import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, link, lstat, open, rename, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { dirname, isAbsolute, join, posix } from 'node:path';
import type { SFTPWrapper } from 'ssh2';
import { transferWait } from './transfer-wait';
import type { FileSnapshot } from './recovery-store';

type Reply<T = void> = (error?: Error | null, value?: T) => void;
export interface ReplacementIO {
  read(path: string): AsyncGenerator<Buffer, FileSnapshot | undefined>;
  write(path: string, source: AsyncIterable<Buffer>, expected: FileSnapshot): Promise<void>;
  snapshot(path: string): Promise<FileSnapshot | undefined>;
  supports(path: string): Promise<boolean>;
  sibling(path: string, id: string): string;
  preserve(path: string, previous: FileSnapshot): Promise<void>;
  replace(staged: string, destination: string, safety: string): Promise<void>;
  remove(path: string): Promise<void>;
}
export function replacementIO(
  sftp: SFTPWrapper | undefined,
  signal: AbortSignal,
  current: () => boolean,
  invalidate: () => void,
): ReplacementIO {
  const check = () => {
    signal.throwIfAborted();
    if (!current()) throw new Error('The connection changed. No replacement is allowed.');
  };
  const request = <T>(start: (cb: Reply<T>) => void, data = false) => {
    check();
    return transferWait<T>(start, data ? 120000 : 30000, signal, undefined, invalidate);
  };
  const local = <T>(start: () => Promise<T>) =>
    request<T>((cb) => {
      void start().then(
        (value) => cb(undefined, value),
        (error: Error) => cb(error),
      );
    });
  const info = (path: string) =>
    sftp ? request<import('ssh2').Stats>((cb) => sftp.lstat(path, cb)) : local(() => lstat(path));
  const read = async function* (path: string): AsyncGenerator<Buffer, FileSnapshot | undefined> {
    let before;
    try {
      before = await info(path);
    } catch (error) {
      if ([2, 'ENOENT'].includes((error as { code: number | string }).code)) return undefined;
      throw error;
    }
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.mode & 0o7000 ||
      ('nlink' in before && before.nlink > 1)
    )
      throw new Error(
        'Only regular files without special permission bits or local hard links support replacement.',
      );
    if (!Number.isSafeInteger(before.size) || before.size < 0)
      throw new Error('Invalid file size.');
    const remoteHandle = sftp
      ? await transferWait<Buffer>(
          (cb) => {
            check();
            sftp.open(path, 'r', cb);
          },
          30000,
          signal,
          (handle) => {
            if (current()) sftp.close(handle, () => undefined);
          },
          invalidate,
        ).catch((error) => {
          const code = (error as { code?: number }).code;
          if (signal.aborted || code === undefined || code === 6 || code === 7) invalidate();
          throw error;
        })
      : undefined;
    const localHandle = !sftp
      ? await transferWait<Awaited<ReturnType<typeof open>>>(
          (cb) => {
            check();
            void open(path, 'r').then(
              (handle) => cb(undefined, handle),
              (error: Error) => cb(error),
            );
          },
          30000,
          signal,
          (handle) => {
            void handle.close().catch(() => undefined);
          },
        )
      : undefined;
    const hash = createHash('sha256');
    let position = 0;
    try {
      const opened = sftp
        ? await request<import('ssh2').Stats>((cb) => sftp.fstat(remoteHandle!, cb))
        : await local(() => localHandle!.stat());
      if (
        !opened.isFile() ||
        opened.size !== before.size ||
        opened.mode !== before.mode ||
        opened.uid !== before.uid ||
        opened.gid !== before.gid ||
        ('ino' in before &&
          'ino' in opened &&
          (opened.ino !== before.ino || opened.dev !== before.dev || opened.nlink > 1))
      )
        throw new Error('File identity changed while opening it.');
      for (;;) {
        const buffer = Buffer.alloc(Math.min(65536, Math.max(1, before.size + 1 - position)));
        const count = sftp
          ? await request<number>(
              (cb) =>
                sftp.read(remoteHandle!, buffer, 0, buffer.length, position, (error, count) =>
                  cb(error, count),
                ),
              true,
            )
          : (await local(() => localHandle!.read(buffer, 0, buffer.length, position))).bytesRead;
        if (
          !Number.isSafeInteger(count) ||
          count < 0 ||
          count > buffer.length ||
          position + count > before.size
        )
          throw new Error('File changed while being inspected.');
        if (!count) break;
        hash.update(buffer.subarray(0, count));
        position += count;
        yield buffer.subarray(0, count);
      }
      const after = await info(path);
      const modified = (s: typeof before) =>
        'mtimeMs' in s ? `${s.mtimeMs}:${s.ctimeMs}:${s.ino}:${s.dev}` : String(s.mtime);
      if (
        position !== before.size ||
        after.size !== before.size ||
        after.mode !== before.mode ||
        after.uid !== before.uid ||
        after.gid !== before.gid ||
        modified(after) !== modified(before)
      )
        throw new Error('File changed while being inspected.');
      return {
        size: position,
        hash: hash.digest('hex'),
        mode: before.mode & 0o777,
        uid: before.uid,
        gid: before.gid,
        modified: 'mtimeMs' in before ? before.mtimeMs : before.mtime * 1000,
      };
    } finally {
      if (remoteHandle && current())
        await transferWait<void>((cb) => sftp!.close(remoteHandle, cb), 3000).catch(() =>
          invalidate(),
        );
      if (localHandle)
        await transferWait<void>((cb) => {
          void localHandle.close().then(
            () => cb(),
            (error: Error) => cb(error),
          );
        }, 3000).catch(() => undefined);
    }
  };
  const snapshot = async (path: string) => {
    const source = read(path);
    for (;;) {
      const result = await source.next();
      if (result.done) return result.value;
    }
  };
  return {
    read,
    write: async (path, source, expected) => {
      const temporary = sftp
        ? posix.join(posix.dirname(path), `.sshdrop-${randomUUID()}.part`)
        : join(dirname(path), `.sshdrop-${randomUUID()}.part`);
      let owned = false;
      let publishing = false;
      let remoteHandle: Buffer | undefined;
      let localHandle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        if (sftp)
          remoteHandle = await transferWait<Buffer>(
            (cb) => {
              check();
              sftp.open(temporary, 'wx', 0o600, cb);
            },
            30000,
            signal,
            (handle) => {
              if (current()) sftp.close(handle, () => undefined);
            },
            invalidate,
          );
        else
          localHandle = await transferWait<Awaited<ReturnType<typeof open>>>(
            (cb) => {
              check();
              void open(temporary, 'wx', 0o600).then(
                (h) => cb(undefined, h),
                (e: Error) => cb(e),
              );
            },
            30000,
            signal,
            (h) => {
              void h.close().catch(() => undefined);
            },
          );
        owned = true;
        let position = 0;
        const hash = createHash('sha256');
        // Authentication may fail only at the end of the iterator. All data remains
        // in an exclusive staging file until the iterator and SHA-256 both verify.
        for await (const chunk of source) {
          check();
          if (position + chunk.length > expected.size)
            throw new Error('Recovery source exceeds its recorded size.');
          if (sftp)
            await request<void>(
              (cb) => sftp.write(remoteHandle!, chunk, 0, chunk.length, position, cb),
              true,
            );
          else {
            let offset = 0;
            while (offset < chunk.length) {
              const result = await local(() =>
                localHandle!.write(chunk, offset, chunk.length - offset, position + offset),
              );
              if (!result.bytesWritten) throw new Error('Recovery write made no progress.');
              offset += result.bytesWritten;
            }
          }
          position += chunk.length;
          hash.update(chunk);
        }
        if (position !== expected.size || hash.digest('hex') !== expected.hash)
          throw new Error('Backup SHA-256 verification failed.');
        if (sftp) {
          await request<void>((cb) => sftp.close(remoteHandle!, cb));
          remoteHandle = undefined;
        } else {
          await local(() => localHandle!.sync());
          await localHandle!.close();
          localHandle = undefined;
        }
        const verified = await snapshot(temporary);
        if (verified?.hash !== expected.hash || verified.size !== expected.size)
          throw new Error('Recovery staging verification failed.');
        check();
        publishing = true;
        if (sftp) await request<void>((cb) => sftp.rename(temporary, path, cb));
        else {
          await local(() => link(temporary, path));
          await local(() => unlink(temporary));
        }
        owned = false;
        check();
      } catch (error) {
        if (publishing)
          throw new Error(
            'Recovery publication is uncertain. Inspect the destination and temporary files before retrying; no automatic retry was attempted.',
            { cause: error },
          );
        throw error;
      } finally {
        if (remoteHandle && current())
          await transferWait<void>((cb) => sftp!.close(remoteHandle!, cb), 3000).catch(invalidate);
        if (localHandle) await localHandle.close().catch(() => undefined);
        if (owned && !publishing) {
          if (sftp && current())
            await transferWait<void>((cb) => sftp.unlink(temporary, cb), 3000).catch(invalidate);
          else if (!sftp) await unlink(temporary).catch(() => undefined);
        }
      }
    },
    snapshot,
    sibling: (path, id) =>
      sftp
        ? posix.join(posix.dirname(path), `.sshdrop-recovery-${id}.ready`)
        : join(dirname(path), `.sshdrop-recovery-${id}.ready`),
    supports: async (path) => {
      check();
      if (!sftp) return true;
      const probe = posix.join(posix.dirname(path), `.sshdrop-capability-${randomUUID()}`);
      try {
        await request<void>((cb) => sftp.ext_openssh_rename(probe, probe, cb));
        return true;
      } catch (error) {
        check();
        const code = (error as { code?: number }).code;
        if (code === 6 || code === 7) {
          invalidate();
          throw error;
        }
        return typeof code === 'number' && code !== 8;
      }
    },
    preserve: async (path, previous) => {
      const staged = await info(path);
      if (!staged.isFile() || staged.uid !== previous.uid || staged.gid !== previous.gid)
        throw new Error(
          'Replacement would change owner/group. The original has not been replaced.',
        );
      if (sftp) await request<void>((cb) => sftp.chmod(path, previous.mode, cb));
      else await local(() => chmod(path, previous.mode));
      const checked = await info(path);
      if (process.platform !== 'win32' || sftp)
        if ((checked.mode & 0o777) !== previous.mode)
          throw new Error('Permissions could not be preserved.');
    },
    replace: async (staged, destination, safety) => {
      check();
      if (sftp) await request<void>((cb) => sftp.ext_openssh_rename(staged, destination, cb));
      else if (process.platform === 'win32') {
        // Fixed program only. Paths are data in environment variables, never script text.
        const script =
          "$ErrorActionPreference='Stop'; [System.IO.File]::Replace($env:SSHDROP_STAGE,$env:SSHDROP_TARGET,$env:SSHDROP_SAFETY,$false)";
        await request<void>((cb) => {
          execFile(
            join(
              process.env.SystemRoot ?? 'C:\\Windows',
              'System32',
              'WindowsPowerShell',
              'v1.0',
              'powershell.exe',
            ),
            [
              '-NoProfile',
              '-NonInteractive',
              '-EncodedCommand',
              Buffer.from(script, 'utf16le').toString('base64'),
            ],
            {
              windowsHide: true,
              timeout: 30000,
              maxBuffer: 16384,
              env: {
                ...process.env,
                SSHDROP_STAGE: staged,
                SSHDROP_TARGET: destination,
                SSHDROP_SAFETY: safety,
              },
            },
            (error) =>
              cb(
                error
                  ? new Error('Native replacement failed; inspect recovery before retrying.')
                  : undefined,
              ),
          );
        });
      } else await local(() => rename(staged, destination));
      check();
    },
    remove: async (path) => {
      try {
        if (sftp) await request<void>((cb) => sftp.unlink(path, cb));
        else await local(() => unlink(path));
      } catch (error) {
        if (![2, 'ENOENT'].includes((error as { code: number | string }).code)) throw error;
      }
    },
  };
}

export async function copyLocalBackup(source: string, destination: string): Promise<void> {
  if (!isAbsolute(source) || !isAbsolute(destination))
    throw new Error('Use native selected absolute paths.');
  await transferWait<void>((cb) => {
    void copyFile(source, destination, constants.COPYFILE_EXCL).then(
      () => cb(),
      (error: Error) => cb(error),
    );
  }, 120000);
  await transferWait<void>((cb) => {
    void chmod(destination, 0o600).then(
      () => cb(),
      (error: Error) => cb(error),
    );
  }, 30000);
  const handle = await transferWait<Awaited<ReturnType<typeof open>>>(
    (cb) => {
      void open(destination, 'r+').then(
        (handle) => cb(undefined, handle),
        (error: Error) => cb(error),
      );
    },
    30000,
    undefined,
    (handle) => {
      void handle.close().catch(() => undefined);
    },
  );
  try {
    await transferWait<void>((cb) => {
      void handle.sync().then(
        () => cb(),
        (error: Error) => cb(error),
      );
    }, 30000);
  } finally {
    await transferWait<void>((cb) => {
      void handle.close().then(
        () => cb(),
        (error: Error) => cb(error),
      );
    }, 3000);
  }
}
