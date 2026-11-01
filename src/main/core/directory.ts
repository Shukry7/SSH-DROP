import type { FileEntryWithStats, SFTPWrapper } from 'ssh2';
import type { DirectoryListing, RemoteEntry } from '../../shared/contracts';
import { remotePath } from '../../shared/validation';

export const directoryLimits = {
  entries: 10000,
  bytes: 4 * 1024 * 1024,
  batches: 128,
  milliseconds: 30000,
};

function request<T>(
  start: (callback: (error: Error | undefined, value: T) => void) => void,
  milliseconds: number,
  late?: (value: T) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(
      () => {
        finished = true;
        reject(new Error('Directory request timed out. Try a smaller directory or reconnect.'));
      },
      Math.max(1, milliseconds),
    );
    try {
      start((error, value) => {
        if (finished) {
          if (!error) {
            try {
              late?.(value);
            } catch {
              /* A late handle belongs to an already failed request. */
            }
          }
          return;
        }
        finished = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      });
    } catch (error) {
      finished = true;
      clearTimeout(timer);
      reject(error);
    }
  });
}

export async function readDirectory(
  sftp: SFTPWrapper,
  path: string,
  current: () => boolean,
): Promise<DirectoryListing> {
  const deadline = Date.now() + directoryLimits.milliseconds;
  const remaining = () => deadline - Date.now();
  const resolved = remotePath(
    await request<string>((cb) => sftp.realpath(remotePath(path), cb), remaining()),
  );
  if (!current()) throw new Error('The connection changed while reading the directory.');
  const handle = await request<Buffer>(
    (cb) => sftp.opendir(resolved, cb),
    remaining(),
    (late) => {
      sftp.close(late, () => undefined);
    },
  );
  const entries: RemoteEntry[] = [];
  let bytes = 0;
  let count = 0;
  try {
    for (let batch = 0; ; batch++) {
      if (!current()) throw new Error('The connection changed while reading the directory.');
      if (batch >= directoryLimits.batches || remaining() <= 0)
        throw new Error('Directory listing exceeded the safety limit. Open a smaller directory.');
      const page = await request<FileEntryWithStats[] | false>(
        (cb) =>
          sftp.readdir(handle, (error, list) => {
            if ((error as Error & { code?: number })?.code === 1) cb(undefined, false);
            else cb(error, list);
          }),
        remaining(),
      );
      if (page === false) break;
      for (const { filename, attrs } of page) {
        count++;
        bytes += Buffer.byteLength(filename, 'utf8') + 64;
        if (count > directoryLimits.entries || bytes > directoryLimits.bytes)
          throw new Error('Directory listing exceeded the safety limit. Open a smaller directory.');
        if (
          !filename ||
          filename.includes('/') ||
          Array.from(filename).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
          Buffer.byteLength(filename, 'utf8') > 4096
        )
          throw new Error('The server returned an invalid filename.');
        if (filename === '.' || filename === '..') continue;
        if (
          !Number.isSafeInteger(attrs.size) ||
          attrs.size < 0 ||
          !Number.isFinite(attrs.mtime) ||
          !Number.isFinite(new Date(attrs.mtime * 1000).getTime())
        )
          throw new Error('The server returned invalid file metadata.');
        entries.push({
          name: filename,
          kind: attrs.isDirectory()
            ? 'directory'
            : attrs.isSymbolicLink()
              ? 'symlink'
              : attrs.isFile()
                ? 'file'
                : 'other',
          size: attrs.size,
          modified: attrs.mtime * 1000,
        });
      }
    }
  } finally {
    await request<void>(
      (cb) => sftp.close(handle, (error) => cb(error ?? undefined, undefined)),
      2000,
    ).catch(() => undefined);
  }
  if (!current()) throw new Error('The connection changed while reading the directory.');
  return {
    path: resolved,
    entries: entries.sort(
      (a, b) =>
        Number(b.kind === 'directory') - Number(a.kind === 'directory') ||
        a.name.localeCompare(b.name),
    ),
  };
}
