import { utils, type SFTPWrapper, type Stats } from 'ssh2';
import type { FileAction } from '../../shared/contracts';
import { childPath, fileActionSchema } from '../../shared/validation';

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
  const parent = async () => {
    check();
    const canonical = await request<string>((cb) => sftp.realpath(input.directory, cb));
    const stats = await info(input.directory);
    if (canonical !== input.directory || !stats?.isDirectory())
      throw new Error('The directory changed or is a symbolic link. Refresh before retrying.');
  };
  const source = childPath(input.directory, input.name);
  const destination =
    input.action === 'rename' ? childPath(input.directory, input.newName) : source;
  const inspect = async () => {
    await parent();
    const stats = await info(source);
    if (!creating) {
      if (!stats) throw new Error('The selected item no longer exists. Refresh the directory.');
      if (
        (input.kind === 'file' && !stats.isFile()) ||
        (input.kind === 'directory' && !stats.isDirectory())
      )
        throw new Error(
          'The item type changed, or it is a symbolic link or special file. Refresh before retrying.',
        );
      for (const field of ['size', 'mtime', 'mode', 'uid', 'gid'] as const)
        if (!Number.isSafeInteger(stats[field]) || stats[field] < 0)
          throw new Error('The server returned invalid item metadata.');
    }
    if (creating ? stats : input.action === 'rename' && (await info(destination)))
      throw new Error(
        'The destination already exists. Choose a different name; existing items are not replaced.',
      );
    return stats;
  };
  const before = await inspect();
  const approved = await confirm({
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
  });
  if (!approved) return false;
  deadline = Date.now() + milliseconds;
  check();
  const after = await inspect();
  if (
    before &&
    after &&
    ['size', 'mtime', 'mode', 'uid', 'gid'].some(
      (field) => before[field as keyof Stats] !== after[field as keyof Stats],
    )
  )
    throw new Error(
      'The selected item changed while awaiting confirmation. Refresh and review it again.',
    );
  check();
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
        else if (input.action === 'rename') sftp.rename(source, destination, cb);
        else if (input.kind === 'directory') sftp.rmdir(source, cb);
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
