import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, join, posix, relative } from 'node:path';
import type { SFTPWrapper, Stats } from 'ssh2';
import { z } from 'zod';
import { BackupVault, privateFile } from './backup-vault';
import { identitySchema, sameIdentity, type ServerIdentity } from './recovery-store';
import { replacementIO } from './replacement-io';
import { queuedFileSchema, type QueuedFile } from './transfer-queue';
import { transferWait } from './transfer-wait';

const journal = 'transfer-queue.enc';
const recordSchema = z
  .object({
    id: z.string().uuid(),
    identity: identitySchema,
    file: queuedFileSchema.refine(
      (file) => !file.folder && !file.recoveryId && !file.expectedSourceHash,
    ),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    created: z.string().datetime(),
  })
  .strict();
type Record = z.infer<typeof recordSchema>;
const schema = z
  .object({ version: z.literal(1), records: z.array(recordSchema).max(100) })
  .strict()
  .refine(({ records }) => new Set(records.map(({ id }) => id)).size === records.length);

export class TransferRecovery {
  private pending: Promise<unknown> = Promise.resolve();
  private readonly claimed = new Set<string>();

  constructor(private readonly vault: BackupVault) {}

  private async read(): Promise<Record[]> {
    await mkdir(this.vault.directory, { recursive: true, mode: 0o700 });
    const root = await lstat(this.vault.directory);
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      (process.platform !== 'win32' && root.mode & 0o077)
    )
      throw new Error('Transfer recovery needs a private storage directory.');
    try {
      await privateFile(join(this.vault.directory, journal));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return schema.parse(JSON.parse(await this.vault.metadata(journal))).records;
  }

  private queue<T>(action: (records: Record[]) => Promise<T> | T): Promise<T> {
    const result = this.pending.then(async () => {
      const records = await this.read().catch(() => {
        throw new Error(
          'Saved transfers could not be read. Unlock the OS key store and check the journal. The data has been preserved.',
        );
      });
      return action(records);
    });
    this.pending = result.catch(() => undefined);
    return result;
  }

  private async write(records: Record[]) {
    const contents = JSON.stringify(schema.parse({ version: 1, records }));
    if (Buffer.byteLength(contents) > 1024 * 1024)
      throw new Error('Saved transfers exceed the local storage limit.');
    await this.vault.writeMetadata(contents, journal);
  }

  add(identity: ServerIdentity, batch: { file: QueuedFile; hash: string }[]) {
    return this.queue(async (records) => {
      if (records.length + batch.length > 100)
        throw new Error('Saved transfer limit reached. Forget old transfers before adding more.');
      const added = batch.map((item) => ({
        ...item,
        identity,
        id: randomUUID(),
        created: new Date().toISOString(),
      }));
      await this.write([...records, ...added]);
      for (const item of added) this.claimed.add(item.id);
      return added;
    });
  }

  list(identity: ServerIdentity) {
    return this.queue((records) =>
      records
        .filter((item) => sameIdentity(item.identity, identity) && !this.claimed.has(item.id))
        .map(({ id, file: { local, remote, direction }, created }) => ({
          id,
          local,
          remote,
          direction,
          created,
        })),
    );
  }

  claim(identity: ServerIdentity, id: string) {
    return this.queue((records) => {
      const item = records.find(
        (record) => record.id === id && sameIdentity(record.identity, identity),
      );
      if (!item || this.claimed.has(id)) throw new Error('This saved transfer is unavailable.');
      this.claimed.add(id);
      return item;
    });
  }

  release(id: string) {
    this.claimed.delete(id);
  }

  async finish(id: string) {
    try {
      await this.queue(async (records) => {
        await this.write(records.filter((item) => item.id !== id));
      });
    } finally {
      this.release(id);
    }
  }
}

export async function checkRecoverablePaths(
  sftp: SFTPWrapper,
  file: QueuedFile,
  signal: AbortSignal,
) {
  if (file.folder) throw new Error('Persistent recovery supports individual files.');
  signal.throwIfAborted();
  const remoteParent = posix.dirname(file.remote);
  const canonical = await transferWait<string>(
    (done) => sftp.realpath(remoteParent, done),
    30000,
    signal,
  );
  if (canonical !== remoteParent || posix.normalize(file.remote) !== file.remote)
    throw new Error('Choose a canonical remote folder.');
  const parent = dirname(file.local);
  const [remoteInfo, localParent, localCanonical] = await Promise.all([
    transferWait<Stats>((done) => sftp.stat(remoteParent, done), 30000, signal),
    lstat(parent),
    realpath(parent),
  ]);
  if (
    !remoteInfo.isDirectory() ||
    !localParent.isDirectory() ||
    localParent.isSymbolicLink() ||
    relative(parent, localCanonical)
  )
    throw new Error('A transfer folder is missing or unsafe.');
  try {
    if (file.direction === 'upload')
      await transferWait<Stats>((done) => sftp.lstat(file.remote, done), 30000, signal);
    else await lstat(file.local);
  } catch (error) {
    const code = (error as { code?: string | number }).code;
    if (file.direction === 'upload' ? code === 2 : code === 'ENOENT') return;
    throw error;
  }
  throw new Error('The destination already exists. Saved transfers require an empty destination.');
}

export async function fingerprintRecoverableFile(
  sftp: SFTPWrapper,
  file: QueuedFile,
  signal: AbortSignal,
) {
  await checkRecoverablePaths(sftp, file, signal);
  const sourceRemote = file.direction === 'download';
  const io = replacementIO(
    sourceRemote ? sftp : undefined,
    signal,
    () => !signal.aborted,
    () => {},
    32 * 1024 * 1024,
  );
  const source = await io.snapshot(sourceRemote ? file.remote : file.local);
  if (!source) throw new Error('The transfer source could not be found.');
  signal.throwIfAborted();
  return source.hash;
}
