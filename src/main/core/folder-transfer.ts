import { lstat, mkdir, opendir, realpath } from 'node:fs/promises';
import type { Stats as LocalStats } from 'node:fs';
import { basename, dirname, join, posix, resolve } from 'node:path';
import type { SFTPWrapper, Stats } from 'ssh2';
import type { TransferUpdate } from '../../shared/contracts';
import { actionNameSchema } from '../../shared/validation';
import { readDirectory } from './directory';
import { runTransfer, transferLimits } from './transfer';
import { transferWait } from './transfer-wait';

export const folderLimits = { entries: 100, depth: 16, bytes: 10 * 1024 ** 3, scan: 30000 };

// Use portable names even on Unix so a folder cannot introduce ambiguous Windows targets.
export function folderName(value: string): string {
  actionNameSchema.parse(value);
  if (
    /[<>:"|?*]/.test(value) ||
    /[. ]$/.test(value) ||
    /^(?:CON|CONIN\$|CONOUT\$|CLOCK\$|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(value)
  )
    throw new Error('Folder transfers require portable filenames without reserved device names.');
  return value;
}

type Info = LocalStats | Stats;
function signature(info: Info): string {
  if (
    info.isSymbolicLink() ||
    (!info.isFile() && !info.isDirectory()) ||
    ('nlink' in info && info.isFile() && info.nlink !== 1)
  )
    throw new Error(
      'Folder transfers refuse symbolic links, hard-linked local files and special files.',
    );
  return JSON.stringify([
    info.mode,
    info.uid,
    info.gid,
    ...('ino' in info ? [info.dev, info.ino] : []),
    ...(info.isFile()
      ? [
          info.size,
          'mtimeMs' in info ? info.mtimeMs : info.mtime,
          'ctimeMs' in info ? info.ctimeMs : null,
        ]
      : []),
  ]);
}

export async function runFolderTransfer(options: {
  sftp: SFTPWrapper;
  direction: 'upload' | 'download';
  local: string;
  remote: string;
  signal: AbortSignal;
  current: () => boolean;
  invalidate: () => void;
  update: TransferUpdate;
  publish: () => void;
  warn: () => void;
  limits?: typeof transferLimits;
}): Promise<void> {
  const { signal, current, sftp, update, publish } = options;
  let scanDeadline = Infinity;
  const check = () => {
    signal.throwIfAborted();
    if (!current()) throw new Error('The connection changed during the folder transfer.');
    if (Date.now() > scanDeadline)
      throw new Error('Folder scan timed out. No destination was created.');
  };
  const wait = <T>(start: (cb: (error?: Error | null, value?: T) => void) => void) => {
    check();
    return transferWait<T>(
      start,
      Math.max(1, Math.min(options.limits?.request ?? 30000, scanDeadline - Date.now())),
      signal,
      undefined,
      options.invalidate,
    );
  };
  const local = <T>(start: () => Promise<T>) =>
    wait<T>((cb) => {
      void start().then(
        (value) => cb(undefined, value),
        (error: Error) => cb(error),
      );
    });
  const io = (remote: boolean) => {
    const paths = remote ? posix : { join, dirname };
    const stat = async (path: string): Promise<Info | undefined> => {
      try {
        return remote
          ? await wait<Stats>((cb) => sftp.lstat(path, cb))
          : await local(() => lstat(path));
      } catch (error) {
        if ([2, 'ENOENT'].includes((error as { code: number | string }).code)) return undefined;
        throw error;
      }
    };
    const inspect = async (path: string) => {
      const info = await stat(path);
      if (!info) throw new Error('A folder transfer source or parent disappeared.');
      const key = signature(info);
      const canonical = remote
        ? await wait<string>((cb) => sftp.realpath(path, cb))
        : await local(() => realpath(path));
      const equal =
        !remote && process.platform === 'win32'
          ? canonical.toLowerCase() === resolve(path).toLowerCase()
          : canonical === path;
      if (!equal)
        throw new Error('A folder path is a symbolic link or changed. Refresh before retrying.');
      check();
      return { info, key };
    };
    const list = async (path: string) => {
      if (remote)
        return (await local(() => readDirectory(sftp, path, current))).entries.map(
          (entry) => entry.name,
        );
      check();
      const handle = await transferWait<Awaited<ReturnType<typeof opendir>>>(
        (cb) => {
          void opendir(path).then(
            (handle) => cb(undefined, handle),
            (error: Error) => cb(error),
          );
        },
        Math.max(1, Math.min(30000, scanDeadline - Date.now())),
        signal,
        (late) => {
          void late.close().catch(() => undefined);
        },
        options.invalidate,
      );
      const names: string[] = [];
      try {
        for (;;) {
          const entry = await local(() => handle.read());
          if (!entry) break;
          check();
          names.push(entry.name);
          if (names.length > folderLimits.entries)
            throw new Error('Folder item limit exceeded (100 items including folders).');
        }
      } finally {
        await transferWait<void>((cb) => {
          void handle.close().then(
            () => cb(),
            (error: Error) => cb(error),
          );
        }, 2000).catch(() => undefined);
      }
      return names;
    };
    const create = async (path: string) => {
      if (remote) await wait<void>((cb) => sftp.mkdir(path, { mode: 0o700 }, cb));
      else await local(() => mkdir(path, { mode: 0o700 }));
      check();
    };
    return { ...paths, stat, inspect, list, create };
  };
  const source = io(options.direction === 'download');
  const target = io(options.direction === 'upload');
  const sourceRoot = options.direction === 'upload' ? options.local : options.remote;
  const targetRoot = options.direction === 'upload' ? options.remote : options.local;
  const entries: { parts: string[]; directory: boolean; key: string; size: number }[] = [];
  const deadline = Date.now() + folderLimits.scan;
  scanDeadline = deadline;
  let bytes = 0;
  const scan = async (parts: string[]): Promise<void> => {
    check();
    if (
      Date.now() > deadline ||
      parts.length > folderLimits.depth ||
      entries.length >= folderLimits.entries
    )
      throw new Error('Folder scan limit exceeded (100 items, 16 levels, 30 seconds).');
    const path = source.join(sourceRoot, ...parts);
    if (
      Buffer.byteLength(path) > 4096 ||
      Buffer.byteLength(target.join(targetRoot, ...parts)) > 4096
    )
      throw new Error('Folder path is too long.');
    const { info, key } = await source.inspect(path);
    if (!parts.length && !info.isDirectory()) throw new Error('Select a regular folder.');
    if (!Number.isSafeInteger(info.size) || info.size < 0)
      throw new Error('Invalid folder metadata.');
    bytes += info.isFile() ? info.size : 0;
    if (bytes > folderLimits.bytes) throw new Error('Folder size limit exceeded (10 GiB).');
    entries.push({
      parts,
      directory: info.isDirectory(),
      key,
      size: info.isFile() ? info.size : 0,
    });
    if (info.isDirectory()) {
      const names = await source.list(path);
      const seen = new Set<string>();
      for (const raw of names) {
        const name = folderName(raw);
        const folded = name.normalize('NFC').toLowerCase();
        if (seen.has(folded)) throw new Error('Folder contains colliding filenames.');
        seen.add(folded);
        await scan([...parts, name]);
      }
    }
    if (Date.now() > deadline)
      throw new Error('Folder scan timed out. No destination was created.');
  };
  // Full bounded preflight before the first write; no merge or recursive deletion.
  folderName(
    options.direction === 'upload' ? basename(options.local) : posix.basename(options.remote),
  );
  folderName(
    options.direction === 'upload' ? posix.basename(options.remote) : basename(options.local),
  );
  await scan([]);
  scanDeadline = Infinity;
  const parent = target.dirname(targetRoot);
  const parentInfo = await target.inspect(parent);
  if (!parentInfo.info.isDirectory()) throw new Error('Choose a destination folder.');
  if (await target.stat(targetRoot))
    throw new Error(
      'The destination folder already exists. Choose another location or rename the source; folder merging is not supported.',
    );
  const directories = new Map<string, string>([[parent, parentInfo.key]]);
  const sourceDirectories = new Map(
    entries
      .filter((entry) => entry.directory)
      .map((entry) => [source.join(sourceRoot, ...entry.parts), entry.key]),
  );
  const verifyAncestors = async (
    path: string,
    root: string,
    side: ReturnType<typeof io>,
    known: Map<string, string>,
  ) => {
    for (;;) {
      const value = await side.inspect(path);
      if (!value.info.isDirectory() || value.key !== known.get(path))
        throw new Error(
          'A folder changed during transfer. Inspect the partial copy before retrying.',
        );
      if (path === root) break;
      path = side.dirname(path);
    }
  };
  update.total = bytes;
  publish();
  let completed = 0;
  try {
    for (const entry of entries) {
      check();
      const from = source.join(sourceRoot, ...entry.parts);
      const to = target.join(targetRoot, ...entry.parts);
      if (entry.parts.length)
        await verifyAncestors(source.dirname(from), sourceRoot, source, sourceDirectories);
      const before = await source.inspect(from);
      if (before.key !== entry.key || before.info.isDirectory() !== entry.directory)
        throw new Error('A source changed after the folder scan.');
      await verifyAncestors(target.dirname(to), parent, target, directories);
      if (await target.stat(to))
        throw new Error(
          'A folder destination appeared during transfer. Nothing will be overwritten.',
        );
      if (entry.directory) {
        await target.create(to);
        const made = await target.inspect(to);
        if (!made.info.isDirectory()) throw new Error('The created folder changed.');
        directories.set(to, made.key);
      } else {
        const nested: TransferUpdate = {
          ...update,
          total: entry.size,
          transferred: 0,
          status: 'running',
        };
        await runTransfer({
          ...options,
          local: options.direction === 'upload' ? from : to,
          remote: options.direction === 'upload' ? to : from,
          update: nested,
          publish: () => {
            update.transferred = completed + nested.transferred;
            update.phase = nested.phase;
            publish();
          },
        });
        if (nested.status !== 'completed')
          throw new Error(nested.error ?? 'Folder file transfer stopped.');
        completed += entry.size;
      }
    }
    check();
    update.transferred = completed;
    update.status = 'completed';
    publish();
  } catch (error) {
    options.warn();
    throw error;
  }
}
