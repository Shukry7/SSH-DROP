import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, rename, statfs, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { readLocalData } from './local-data';
import { BackupVault, privateFile } from './backup-vault';

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
    mode: z.number().int().min(0).max(0o777),
    uid: z.number().int().nonnegative(),
    gid: z.number().int().nonnegative(),
    modified: z.number().finite().nonnegative().optional(),
  })
  .strict();
export type FileSnapshot = z.infer<typeof snapshotSchema>;
export const recoveryPathsSchema = z
  .object({
    local: pathSchema.refine(isAbsolute),
    remote: pathSchema.refine((s) => s.startsWith('/')),
  })
  .strict();
const recordSchema = z
  .object({
    id: z.string().uuid(),
    identity: identitySchema,
    direction: z.enum(['upload', 'download']),
    ...recoveryPathsSchema.shape,
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
    encrypted: z.literal(true).optional(),
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
  constructor(
    readonly directory: string,
    readonly vault: BackupVault,
  ) {}
  backup(id: string): string {
    return join(this.directory, `${z.string().uuid().parse(id)}.bak.enc`);
  }
  private legacy(id: string): string {
    return join(this.directory, `${z.string().uuid().parse(id)}.bak`);
  }
  async verify(record: RecoveryRecord, check?: () => void): Promise<void> {
    try {
      if (record.encrypted) await this.vault.verify(`${record.id}.bak.enc`, record.previous, check);
      else throw new Error('Encrypt this legacy backup before using it.');
    } catch (error) {
      throw new Error(
        'Backup is locked, missing, or SHA-256/authentication verification failed. Data has been preserved.',
        { cause: error },
      );
    }
  }
  async save(
    record: RecoveryRecord,
    source: AsyncIterable<Buffer>,
    check: () => void,
  ): Promise<void> {
    await this.vault.seal(`${record.id}.bak.enc`, source, check);
    await this.verify(record, check);
  }
  contents(record: RecoveryRecord, check: () => void): AsyncIterable<Buffer> {
    if (!record.encrypted) throw new Error('Encrypt this legacy backup before using it.');
    return this.vault.read(`${record.id}.bak.enc`, record.previous.size, check);
  }
  async encryptLegacy(
    record: RecoveryRecord,
    source: AsyncIterable<Buffer>,
    check: () => void,
  ): Promise<void> {
    if (!record.encrypted) {
      const space = await statfs(this.directory);
      if (space.bavail * space.bsize < record.previous.size + 50 * 1024 ** 2)
        throw new Error('Insufficient space to encrypt the backup while retaining its original.');
      // Failed/interrupted migrations keep both the original and any incomplete encrypted
      // output. Remove only that record's unused encrypted output before an explicit retry.
      await unlink(this.backup(record.id)).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'ENOENT') throw e;
      });
      await this.save({ ...record, encrypted: true }, source, check);
      await this.queue(async () => {
        const records = await this.read();
        const found = records.findIndex(
          (r) => r.id === record.id && sameIdentity(r.identity, record.identity),
        );
        if (found < 0) throw new Error('Recovery record is missing.');
        records[found] = { ...records[found], encrypted: true };
        check();
        await this.write(records);
      });
    } else {
      await this.verify(record, check);
      await this.queue(async () => this.write(await this.read()));
    }
    check();
    // Commit encrypted content AND metadata before unlinking a plaintext original.
    await unlink(this.legacy(record.id)).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
    });
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
      try {
        await privateFile(join(this.directory, 'recovery.enc'));
        return schema.parse(JSON.parse(await this.vault.metadata())).records;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const info = await lstat(join(this.directory, 'recovery.json'));
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        (process.platform !== 'win32' && info.mode & 0o077)
      )
        throw new Error('Insecure recovery data.');
      return schema.parse(JSON.parse(await readLocalData(join(this.directory, 'recovery.json'))))
        .records;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (!(await readdir(this.directory)).some((name) => name.endsWith('.enc'))) return [];
      }
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
    await this.vault.writeMetadata(contents);
    // Leave a non-sensitive format marker so older plaintext-only app versions
    // fail closed rather than starting a second, unrelated recovery journal.
    const marker = join(this.directory, `${randomUUID()}.tmp`);
    try {
      const handle = await open(marker, 'wx', 0o600);
      try {
        await handle.writeFile('{"version":2,"encrypted":true}\n');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(marker, join(this.directory, 'recovery.json'));
    } finally {
      await unlink(marker).catch(() => undefined);
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
        encrypted: true,
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
      await unlink(this.legacy(id)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      await this.write(records.filter((r) => r.id !== id));
    });
  }
}
