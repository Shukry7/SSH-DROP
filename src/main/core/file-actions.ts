import { utils, type SFTPWrapper, type Stats } from 'ssh2';
import type { FileAction } from '../../shared/contracts';
import { childPath, fileActionSchema } from '../../shared/validation';
import { replacementIO } from './replacement-io';

const remoteCopyLimit = 128 * 1024 * 1024;
const metadata = ['size', 'mtime', 'mode', 'uid', 'gid'] as const;

export interface FileActionWarning {
  title: string;
  message: string;
  detail: string;
  button: string;
}

export async function changeRemoteFile(
  sftp: SFTPWrapper,
  value: FileAction,
  current: () => boolean,
  signal: AbortSignal,
  confirm: (warning: FileActionWarning) => Promise<boolean>,
  invalidate: () => void,
  milliseconds = 10000,
): Promise<boolean> {
  const input = fileActionSchema.parse(value);
  const creatingFile = input.action === 'create-file';
  const creating = creatingFile || input.action === 'create-folder';
  const relocating = 'destinationDirectory' in input;
  const createButton = creatingFile ? 'Create file' : 'Create folder';
  let sent = false;
  let invalidated = false;
  const stop = () => {
    if (invalidated) return;
    invalidated = true;
    invalidate();
  };
  let deadline = Date.now() + milliseconds;
  const uncertain =
    'The result is uncertain. Reconnect and inspect the remote folder before retrying; the change may already have happened.';
  const check = () => {
    if (!current() || signal.aborted)
      throw new Error(sent ? uncertain : 'The connection changed. No file change was sent.');
  };
  function request<T>(
    start: (callback: (error?: Error | null, result?: T) => void) => void,
  ): Promise<T> {
    check();
    if (Date.now() >= deadline) {
      stop();
      throw new Error(
        sent
          ? uncertain
          : 'The server did not respond. No file change was sent. Reconnect before retrying.',
      );
    }
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error?: Error | null, result?: T) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', lost);
        sftp.removeListener('close', lost);
        sftp.removeListener('error', lost);
        if (error) reject(error);
        else {
          try {
            check();
            resolve(result as T);
          } catch (failure) {
            reject(failure);
          }
        }
      };
      const lost = () => {
        finish(new Error(sent ? uncertain : 'Connection interrupted. No file change was sent.'));
        if (!signal.aborted) stop();
      };
      const timer = setTimeout(
        () => {
          finish(
            new Error(
              sent
                ? uncertain
                : 'The server did not respond. No file change was sent. Reconnect before retrying.',
            ),
          );
          stop();
        },
        Math.max(1, deadline - Date.now()),
      );
      signal.addEventListener('abort', lost, { once: true });
      sftp.once('close', lost);
      sftp.once('error', lost);
      try {
        start(finish);
      } catch {
        lost();
      }
    });
  }
  const info = async (path: string): Promise<Stats | undefined> => {
    try {
      return await request<Stats>((cb) => sftp.lstat(path, cb));
    } catch (error) {
      if ((error as { code?: number }).code === 2) return undefined;
      if ((error as { code?: number }).code === 3)
        throw new Error('Permission denied. No file change was sent.', { cause: error });
      throw error;
    }
  };
  const parent = async (directory: string) => {
    check();
    const canonical = await request<string>((cb) => sftp.realpath(directory, cb));
    const stats = await info(directory);
    if (canonical !== directory || !stats?.isDirectory())
      throw new Error('The directory changed or is a symbolic link. Refresh before retrying.');
  };
  const source = childPath(input.directory, input.name);
  const renaming = input.action === 'rename' || input.action === 'move';
  const destination = relocating
    ? childPath(input.destinationDirectory, input.name)
    : input.action === 'rename'
      ? childPath(input.directory, input.newName)
      : source;
  const inspect = async () => {
    await parent(input.directory);
    if (relocating) await parent(input.destinationDirectory);
    const stats = await info(source);
    if (!creating) {
      if (!stats) throw new Error('The selected item no longer exists. Refresh the directory.');
      if (relocating || input.kind === 'file' ? !stats.isFile() : !stats.isDirectory())
        throw new Error(
          'The item type changed, or it is a symbolic link or special file. Refresh before retrying.',
        );
      for (const field of metadata)
        if (!Number.isSafeInteger(stats[field]) || stats[field] < 0)
          throw new Error('The server returned invalid item metadata.');
      if (input.action === 'permissions') {
        if (stats.mode & 0o7000)
          throw new Error(
            'This item has special permission bits. Edit it through the server terminal.',
          );
        if ((stats.mode & 0o777) !== input.expectedMode)
          throw new Error('Permissions changed since the listing. Refresh and review them again.');
      }
      if (input.action === 'copy' && (stats.size > remoteCopyLimit || stats.mode & 0o7000))
        throw new Error(
          'Remote copy supports files up to 128 MiB without special permission bits.',
        );
    }
    if (creating ? stats : (relocating || renaming) && (await info(destination)))
      throw new Error(
        'The destination already exists. Choose a different name; existing items are not replaced.',
      );
    return stats;
  };
  const before = await inspect();
  if (input.action === 'permissions') {
    const mode = Number.parseInt(input.mode, 8);
    if (mode === input.expectedMode) return false;
    if (
      !(await confirm({
        title: 'Change remote permissions',
        message: `Change permissions for ${JSON.stringify(source)}?`,
        detail: `Current mode: ${input.expectedMode.toString(8).padStart(3, '0')}\nProposed mode: ${input.mode}\n\nChanging access can expose data or prevent users and services from reaching this item. The change applies to this item only.`,
        button: 'Change permissions',
      }))
    )
      return false;
    deadline = Date.now() + milliseconds;
    const unchanged = (stats: Stats | undefined) =>
      !!before && !!stats && metadata.every((field) => stats[field] === before[field]);
    const ensureUnchanged = (stats: Stats | undefined) => {
      if (!unchanged(stats))
        throw new Error('The selected item changed after review. Refresh before trying again.');
    };
    ensureUnchanged(await inspect());
    const handle = await request<Buffer>((cb) => sftp.open(source, 'r', cb)).catch((error) => {
      const code = (error as { code?: number }).code;
      if (code === 6 || code === 7) stop();
      if (code === 3 || code === 4 || code === 8)
        throw new Error(
          'The server could not open this item for handle-based permission editing.',
          { cause: error },
        );
      throw error;
    });
    try {
      ensureUnchanged(await request<Stats>((cb) => sftp.fstat(handle, cb)));
      ensureUnchanged(await inspect());
      sent = true;
      await request<void>((cb) => sftp.fchmod(handle, mode, cb)).catch((error) => {
        const code = (error as { code?: number }).code;
        if (code === 2 || code === 3 || code === 4 || code === 8) {
          sent = false;
          throw new Error(
            'The server refused the permission change. Check your access and server support.',
            { cause: error },
          );
        }
        throw error;
      });
      const actual = await request<Stats>((cb) => sftp.fstat(handle, cb));
      const named = await info(source);
      if (
        !Number.isSafeInteger(actual.mode) ||
        (actual.mode & 0o7777) !== mode ||
        !named ||
        metadata.some((field) => named[field] !== actual[field])
      )
        throw new Error(
          'The server did not report the requested permissions at the selected path.',
        );
    } catch (error) {
      if (!sent) throw error;
      stop();
      throw new Error(uncertain, { cause: error });
    } finally {
      if (!invalidated && current() && !signal.aborted)
        await request<void>((cb) => sftp.close(handle, cb)).catch((error) => {
          stop();
          throw new Error(
            sent ? uncertain : 'The file handle could not be closed. Reconnect before retrying.',
            { cause: error },
          );
        });
    }
    return true;
  }
  const approved = await confirm(
    relocating
      ? {
          title: input.action === 'copy' ? 'Copy remote file' : 'Move remote file',
          message: `${input.action === 'copy' ? 'Copy' : 'Move'} ${JSON.stringify(source)} to ${JSON.stringify(destination)}?`,
          detail:
            input.action === 'copy'
              ? 'The source stays in place. SSHDrop verifies the copied contents before publishing and requests owner-only permissions for the copy. The destination must be empty at this path.'
              : 'The source leaves its current folder. Other applications using that path may be affected. The destination must be empty at this path. If interrupted, inspect both folders before retrying.',
          button: input.action === 'copy' ? 'Copy file' : 'Move file',
        }
      : {
          title:
            input.action === 'delete'
              ? 'Permanently delete remote item'
              : input.action === 'rename'
                ? 'Rename remote item'
                : creatingFile
                  ? 'Create remote file'
                  : 'Create remote folder',
          message:
            input.action === 'rename'
              ? `Rename ${JSON.stringify(source)} to ${JSON.stringify(destination)}?`
              : `${input.action === 'delete' ? 'Permanently delete' : createButton} ${JSON.stringify(source)}?`,
          detail: `${input.action === 'delete' ? 'This cannot be undone. There is no trash or backup. Only files and empty folders can be deleted; folders are never removed recursively.' : input.action === 'rename' ? 'Existing destinations are refused. Other applications using this path may be affected.' : creatingFile ? 'Creates an empty file and requests owner-only read/write permissions (0600). The server controls final permissions. Existing items are preserved.' : 'The new folder requests owner-only permissions (0700); the server controls the final permissions.'} If the connection is interrupted, inspect the remote folder before retrying.`,
          button:
            input.action === 'delete'
              ? 'Delete permanently'
              : input.action === 'rename'
                ? 'Rename'
                : createButton,
        },
  );
  if (!approved) return false;
  const recheck = async () => {
    deadline = Date.now() + milliseconds;
    const after = await inspect();
    if (before && after && metadata.some((field) => before[field] !== after[field]))
      throw new Error(
        'The selected item changed while awaiting confirmation. Refresh and review it again.',
      );
  };
  await recheck();
  check();
  if (input.action === 'copy') {
    const copySignal = AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)]);
    const io = replacementIO(sftp, copySignal, current, stop, remoteCopyLimit);
    try {
      const expected = await io.snapshot(source);
      if (
        !expected ||
        !before ||
        expected.size !== before.size ||
        expected.modified !== before.mtime * 1000
      )
        throw new Error('The source changed after approval. Refresh and review it again.');
      await recheck();
      await io.write(destination, io.read(source), expected, recheck);
    } catch (error) {
      if (error instanceof Error && error.message.includes('publication is uncertain')) stop();
      if ((error as { code?: number }).code === 3)
        throw new Error('The server denied permission to copy the file.', { cause: error });
      if ((error as { code?: number }).code === 4)
        throw new Error('The server refused the copy. Check the destination and available space.', {
          cause: error,
        });
      throw error;
    }
    return true;
  }
  sent = true;
  let fileCreated = false;
  try {
    if (creatingFile) {
      const { WRITE, CREAT, EXCL } = utils.sftp.OPEN_MODE;
      const handle = await request<Buffer>((cb) =>
        sftp.open(source, WRITE | CREAT | EXCL, { mode: 0o600 }, cb),
      );
      fileCreated = true;
      await request<void>((cb) => sftp.close(handle, cb));
    } else {
      await request<void>((cb) => {
        if (input.action === 'create-folder') sftp.mkdir(source, { mode: 0o700 }, cb);
        else if (renaming) sftp.rename(source, destination, cb);
        else if (input.action === 'delete' && input.kind === 'directory') sftp.rmdir(source, cb);
        else sftp.unlink(source, cb);
      });
    }
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (fileCreated || code === 6 || code === 7) {
      stop();
      throw new Error(uncertain, { cause: error });
    }
    if (code === 3)
      throw new Error('The server denied permission. Refresh the folder before trying again.', {
        cause: error,
      });
    if (code === 2)
      throw new Error(
        'The server could not find the item or parent folder. Refresh before retrying.',
        { cause: error },
      );
    if (typeof code === 'number')
      throw new Error(
        'The server refused the change. The folder may be nonempty, the name may exist, or permissions may prevent it. Refresh and inspect before retrying.',
        { cause: error },
      );
    stop();
    throw new Error(uncertain, { cause: error });
  }
  return true;
}
