import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, statfs, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { readLocalData } from './local-data';

const pathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (s) =>
      !Array.from(s).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
      !/[\u202a-\u202e\u2066-\u2069]/.test(s),
  );
export const identitySchema = z
  .object({
    host: pathSchema,
    port: z.number().int().min(1).max(65535),
    username: pathSchema,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type ServerIdentity = z.infer<typeof identitySchema>;
export const snapshotSchema = z
  .object({
    size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    mode: z.number().int().nonnegative(),
    uid: z.number().int().nonnegative(),
    gid: z.number().int().nonnegative(),
    modified: z.number().finite().nonnegative().optional(),
  })
  .strict();
export type FileSnapshot = z.infer<typeof snapshotSchema>;
const recordSchema = z
  .object({
    id: z.string().uuid(),
    identity: identitySchema,
    direction: z.enum(['upload', 'download']),
    local: pathSchema.refine(isAbsolute),
    remote: pathSchema.refine((s) => s.startsWith('/')),
    created: z.string().datetime(),
    state: z.enum([
      'preparing',
      'backup-ready',
      'publishing',
      'completed',
      'uncertain',
      'restored',
      'not-replaced',
    ]),
    previous: snapshotSchema,
    installed: snapshotSchema.optional(),
    parentId: z.string().uuid().optional(),
  })
  .strict();
export type RecoveryRecord = z.infer<typeof recordSchema>;
const schema = z
  .object({ version: z.literal(1), records: z.array(recordSchema).max(100) })
  .strict()
  .refine((data) => new Set(data.records.map((r) => r.id)).size === data.records.length);
export const sameIdentity = (a: ServerIdentity, b: ServerIdentity) =>
  Object.keys(a).every((key) => a[key as keyof ServerIdentity] === b[key as keyof ServerIdentity]);

export class RecoveryStore {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string) {}
  backup(id: string): string {
    return join(this.directory, `${z.string().uuid().parse(id)}.bak`);
  }
  private queue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }
  private async root() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (process.platform !== 'win32' && info.mode & 0o077)
    )
      throw new Error('Backup storage must be a private directory, not a symbolic link.');
  }
  private async read(): Promise<RecoveryRecord[]> {
    await this.root();
    try {
      const info = await lstat(join(this.directory, 'recovery.json'));
      if (info.isSymbolicLink() || (process.platform !== 'win32' && info.mode & 0o077))
        throw new Error('Insecure recovery data.');
      return schema.parse(JSON.parse(await readLocalData(join(this.directory, 'recovery.json'))))
        .records;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error(
        'Recovery records are unreadable or unsafe. They have been preserved; replacement is blocked.',
        { cause: error },
      );
    }
  }
  private async write(records: RecoveryRecord[]) {
    const contents = JSON.stringify(schema.parse({ version: 1, records }), null, 2) + '\n';
    if (Buffer.byteLength(contents) > 1024 * 1024)
      throw new Error('Recovery metadata exceeds the storage limit.');
    const temporary = join(this.directory, `${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(contents);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, join(this.directory, 'recovery.json'));
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
  list(identity: ServerIdentity): Promise<RecoveryRecord[]> {
    return this.queue(async () =>
      (await this.read()).filter((r) => sameIdentity(r.identity, identity)),
    );
  }
  load(id: string, identity: ServerIdentity): Promise<RecoveryRecord> {
    return this.queue(async () => {
      z.string().uuid().parse(id);
      const record = (await this.read()).find(
        (r) => r.id === id && sameIdentity(r.identity, identity),
      );
      if (!record)
        throw new Error(
          'This recovery record does not belong to the connected server and account.',
        );
      return record;
    });
  }
  create(input: Omit<RecoveryRecord, 'id' | 'created' | 'state'>): Promise<RecoveryRecord> {
    return this.queue(async () => {
      const records = await this.read();
      if (
        records.length >= 100 ||
        records.reduce((sum, r) => sum + r.previous.size, input.previous.size) > 10 * 1024 ** 3
      )
        throw new Error(
          'Backup storage limit reached (100 records / 10 GiB). Review and remove old backups first.',
        );
      const space = await statfs(this.directory);
      if (space.bavail * space.bsize < input.previous.size + 50 * 1024 ** 2)
        throw new Error('Insufficient local space for the backup and safety reserve.');
      const record = recordSchema.parse({
        ...input,
        id: randomUUID(),
        created: new Date().toISOString(),
        state: 'preparing',
      });
      await this.write([...records, record]);
      return record;
    });
  }
  update(
    id: string,
    identity: ServerIdentity,
    changes: Pick<RecoveryRecord, 'state'> & { installed?: FileSnapshot },
  ): Promise<RecoveryRecord> {
    return this.queue(async () => {
      const records = await this.read();
      const index = records.findIndex((r) => r.id === id && sameIdentity(r.identity, identity));
      if (index < 0) throw new Error('Recovery record is missing.');
      records[index] = recordSchema.parse({ ...records[index], ...changes });
      await this.write(records);
      return records[index];
    });
  }
  remove(id: string, identity: ServerIdentity): Promise<void> {
    return this.queue(async () => {
      const records = await this.read();
      const record = records.find((r) => r.id === id && sameIdentity(r.identity, identity));
      if (!record || !['completed', 'restored', 'not-replaced'].includes(record.state))
        throw new Error('Inspect the operation before removing its recovery backup.');
      await unlink(this.backup(id)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      await this.write(records.filter((r) => r.id !== id));
    });
  }
}
