import { lstat, mkdir, opendir, realpath } from 'node:fs/promises';
import type { Stats as LocalStats } from 'node:fs';
import { basename, dirname, join, posix, resolve } from 'node:path';
import type { SFTPWrapper, Stats } from 'ssh2';
import type { TransferUpdate } from '../../shared/contracts';
import { actionNameSchema } from '../../shared/validation';
import { readDirectory } from './directory';
import type { ReplacementApproval } from './replacement';
import { recoveryPathsSchema } from './recovery-store';
import { runTransfer, transferLimits } from './transfer';
import { transferWait } from './transfer-wait';

export const folderLimits = { entries: 100, depth: 16, bytes: 10 * 1024 ** 3, scan: 30000 };
const mergeDirectoryLimit = 1000;
const foldedName = (name: string) => name.normalize('NFC').toLowerCase();

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
  merge?: {
    confirm: (approval: ReplacementApproval) => Promise<number>;
    conflict: (
      local: string,
      remote: string,
      transfer: (direction: 'upload' | 'download', local: string, remote: string) => Promise<void>,
      guard: () => Promise<void>,
    ) => Promise<boolean>;
  };
  limits?: typeof transferLimits;
}): Promise<void> {
  const { signal, current, sftp, update, publish } = options;
  let scanDeadline = Infinity;
  const check = () => {
    signal.throwIfAborted();
    if (!current()) throw new Error('The connection changed during the folder transfer.');
    if (Date.now() > scanDeadline)
      throw new Error('Folder scan timed out before writing to the destination.');
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
    const paths = remote ? posix : { join, dirname, basename };
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
    const list = async (path: string, limit: number) => {
      const tooMany = () => new Error(`Folder listing exceeds the ${limit}-item limit.`);
      if (remote) {
        const listing = await local(() => readDirectory(sftp, path, current));
        if (listing.entries.length > limit) throw tooMany();
        return listing.entries.map((entry) => entry.name);
      }
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
          if (names.length > limit) throw tooMany();
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
  // Native selections can contain OS aliases (macOS /var -> /private/var).
  // Resolve only the initially selected parent, then keep the canonical path fixed.
  // The selected root itself and every descendant still undergo lstat/link checks.
  const localRoot = join(
    await local(() => realpath(dirname(options.local))),
    basename(options.local),
  );
  const sourceRoot = options.direction === 'upload' ? localRoot : options.remote;
  const targetRoot = options.direction === 'upload' ? options.remote : localRoot;
  const entries: {
    parts: string[];
    directory: boolean;
    key: string;
    size: number;
    targetKey?: string;
  }[] = [];
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
      const names = await source.list(path, folderLimits.entries);
      const seen = new Set<string>();
      for (const raw of names.sort()) {
        const name = folderName(raw);
        const folded = foldedName(name);
        if (seen.has(folded)) throw new Error('Folder contains colliding filenames.');
        seen.add(folded);
        await scan([...parts, name]);
      }
    }
    check();
  };
  // Full bounded preflight before the first write.
  folderName(
    options.direction === 'upload' ? basename(options.local) : posix.basename(options.remote),
  );
  folderName(
    options.direction === 'upload' ? posix.basename(options.remote) : basename(options.local),
  );
  await scan([]);
  const parent = target.dirname(targetRoot);
  const parentInfo = await target.inspect(parent);
  if (!parentInfo.info.isDirectory()) throw new Error('Choose a destination folder.');
  const rootExists = !!(await target.stat(targetRoot));
  const merge = rootExists ? options.merge : undefined;
  if (rootExists && !merge) throw new Error('The destination folder already exists.');
  const directories = new Map<string, string>([[parent, parentInfo.key]]);
  const existingDirectories = new Set<string>();
  const checkName = (path: string, names: string[]) => {
    const name = target.basename(path);
    if (names.some((other) => other !== name && foldedName(other) === foldedName(name)))
      throw new Error('The destination contains a case or Unicode filename collision.');
  };
  if (merge) {
    recoveryPathsSchema.parse({ local: localRoot, remote: options.remote });
    const listings = new Map<string, string[]>();
    let existingBytes = 0;
    for (const entry of entries) {
      const path = target.join(targetRoot, ...entry.parts);
      const containing = target.dirname(path);
      if (entry.parts.length && !existingDirectories.has(containing)) continue;
      const names =
        listings.get(containing) ?? (await target.list(containing, mergeDirectoryLimit));
      listings.set(containing, names);
      checkName(path, names);
      if (!(await target.stat(path))) continue;
      const { info, key } = await target.inspect(path);
      if (entry.directory !== info.isDirectory())
        throw new Error(
          'A destination file and folder have the same name. Resolve it before merging.',
        );
      if (!entry.directory) {
        if (!Number.isSafeInteger(info.size) || info.size < 0)
          throw new Error('Invalid destination file size.');
        existingBytes += info.size;
        if (existingBytes > folderLimits.bytes)
          throw new Error('Existing conflicting files exceed the 10 GiB limit.');
      }
      entry.targetKey = key;
      if (entry.directory) existingDirectories.add(path);
    }
    if (!entries[0].targetKey) throw new Error('The destination folder changed before merging.');
  }
  scanDeadline = Infinity;
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
  const total = entries.filter((entry) => !entry.directory).length;
  let copied = 0;
  let skipped = 0;
  const report = () => {
    update.folderFiles = { copied, skipped, total };
    publish();
  };
  update.total = bytes;
  report();
  if (merge) {
    const conflicts = entries.filter((entry) => !entry.directory && entry.targetKey).length;
    const choice = await merge.confirm({
      title: 'Merge into existing folder?',
      buttons: ['Cancel', 'Review file conflicts and merge'],
      detail: `Source: ${sourceRoot}\nDestination: ${targetRoot}\n\nIncoming files: ${total}. File conflicts: ${conflicts}. Each conflict requires its own decision. Unrelated files stay in place. Stop other writers while merging. Cancellation or connection loss can leave a partial merge; completed changes remain in place.`,
    });
    check();
    if (choice !== 1) {
      update.status = 'cancelled';
      report();
      return;
    }
  }
  let completed = 0;
  try {
    for (const entry of entries) {
      check();
      const from = source.join(sourceRoot, ...entry.parts);
      const to = target.join(targetRoot, ...entry.parts);
      const guard = async () => {
        if (entry.parts.length)
          await verifyAncestors(source.dirname(from), sourceRoot, source, sourceDirectories);
        const before = await source.inspect(from);
        if (before.key !== entry.key || before.info.isDirectory() !== entry.directory)
          throw new Error('A source changed after the folder scan.');
        const containing = target.dirname(to);
        await verifyAncestors(containing, parent, target, directories);
        if (merge && (containing === parent || existingDirectories.has(containing)))
          checkName(to, await target.list(containing, mergeDirectoryLimit));
        const destination = await target.stat(to);
        if (
          entry.targetKey
            ? !destination || (await target.inspect(to)).key !== entry.targetKey
            : destination
        )
          throw new Error('A folder destination changed after the scan. Inspect before retrying.');
      };
      await guard();
      if (entry.directory) {
        if (!entry.targetKey) await target.create(to);
        const made = await target.inspect(to);
        if (!made.info.isDirectory() || (entry.targetKey && made.key !== entry.targetKey))
          throw new Error('A destination folder changed.');
        directories.set(to, made.key);
      } else {
        const transfer = async (
          direction: 'upload' | 'download',
          local: string,
          remote: string,
        ) => {
          await guard();
          const nested: TransferUpdate = {
            ...update,
            direction,
            total: entry.size,
            transferred: 0,
            status: 'running',
          };
          await runTransfer({
            ...options,
            direction,
            local,
            remote,
            beforePublish: merge ? guard : undefined,
            update: nested,
            publish: () => {
              update.transferred = completed + nested.transferred;
              update.phase = nested.phase;
              publish();
            },
          });
          if (nested.status !== 'completed')
            throw new Error(nested.error ?? 'Folder file transfer stopped.');
        };
        const local = options.direction === 'upload' ? from : to;
        const remote = options.direction === 'upload' ? to : from;
        if (merge && entry.targetKey && !(await merge.conflict(local, remote, transfer, guard))) {
          skipped++;
          update.total -= entry.size;
        } else {
          if (!entry.targetKey) await transfer(options.direction, local, remote);
          copied++;
          completed += entry.size;
          update.transferred = completed;
        }
        report();
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
