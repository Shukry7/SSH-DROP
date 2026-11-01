import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SFTPWrapper, Stats } from 'ssh2';
import { changeRemoteFile, type FileActionWarning } from '../../src/main/core/file-actions';
import { fileActionSchema } from '../../src/shared/validation';
import type { FileAction } from '../../src/shared/contracts';

const folder: FileAction = { action: 'create-folder', directory: '/', name: 'new folder' };
const remove: FileAction = { action: 'delete', directory: '/', name: 'file', kind: 'file' };
type Reply<T = void> = (error?: Error, value?: T) => void;
function stats(kind = 'file', size = 1): Stats {
  return {
    size,
    mode: kind === 'directory' ? 0o40700 : 0o100600,
    mtime: 10,
    uid: 1,
    gid: 1,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'directory',
  } as Stats;
}
function setup() {
  const entries = new Map<string, Stats>([
    ['/', stats('directory')],
    ['/file', stats()],
  ]);
  const stream = new EventEmitter();
  const missing = Object.assign(new Error('missing'), { code: 2 });
  const sftp = Object.assign(stream, {
    realpath: vi.fn((path: string, cb: Reply<string>) => cb(undefined, path)),
    lstat: vi.fn((path: string, cb: Reply<Stats>) =>
      entries.has(path) ? cb(undefined, entries.get(path)) : cb(missing),
    ),
    mkdir: vi.fn((_path: string, _attrs: { mode: number }, cb: Reply) => cb()),
    rename: vi.fn((_from: string, _to: string, cb: Reply) => cb()),
    unlink: vi.fn((_path: string, cb: Reply) => cb()),
    rmdir: vi.fn((_path: string, cb: Reply) => cb()),
  });
  const confirm = vi.fn<(warning: FileActionWarning) => Promise<boolean>>(async () => true);
  const invalidate = vi.fn();
  const controller = new AbortController();
  let active = true;
  const change = (input: FileAction = folder, milliseconds = 1000) =>
    changeRemoteFile(
      sftp as unknown as SFTPWrapper,
      input,
      () => active,
      controller.signal,
      confirm,
      invalidate,
      milliseconds,
    );
  return {
    entries,
    sftp,
    confirm,
    invalidate,
    controller,
    change,
    stale: () => {
      active = false;
    },
  };
}
afterEach(() => vi.useRealTimers());
describe('bounded confirmed remote file changes', () => {
  it('creates a folder with restrictive permissions after confirmation and removes listeners', async () => {
    const f = setup();
    expect(await f.change()).toBe(true);
    expect(f.sftp.mkdir).toHaveBeenCalledWith('/new folder', { mode: 0o700 }, expect.any(Function));
    expect(f.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('/new folder') }),
    );
    expect(f.sftp.listenerCount('close')).toBe(0);
    expect(f.sftp.listenerCount('error')).toBe(0);
  });
  it('never sends a change after cancellation', async () => {
    const f = setup();
    f.confirm.mockResolvedValue(false);
    expect(await f.change(remove)).toBe(false);
    expect(f.sftp.unlink).not.toHaveBeenCalled();
  });
  it('warns about permanent deletion and uses unlink for regular files', async () => {
    const f = setup();
    await f.change(remove);
    expect(f.confirm.mock.calls[0][0]).toMatchObject({
      detail: expect.stringContaining('cannot be undone'),
    });
    expect(f.sftp.unlink).toHaveBeenCalledWith('/file', expect.any(Function));
  });
  it('uses nonrecursive rmdir for directories', async () => {
    const f = setup();
    f.entries.set('/file', stats('directory'));
    await f.change({ ...remove, kind: 'directory' });
    expect(f.sftp.rmdir).toHaveBeenCalled();
    expect(f.sftp.unlink).not.toHaveBeenCalled();
  });
  it('uses standard rename, without an overwrite extension', async () => {
    const f = setup();
    await f.change({
      action: 'rename',
      directory: '/',
      name: 'file',
      newName: 'new',
      kind: 'file',
    });
    expect(f.sftp.rename).toHaveBeenCalledWith('/file', '/new', expect.any(Function));
  });
  it('refuses existing destinations before prompting', async () => {
    const f = setup();
    f.entries.set('/new folder', stats());
    await expect(f.change()).rejects.toThrow('already exists');
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.sftp.mkdir).not.toHaveBeenCalled();
  });
  it('refuses a rename collision', async () => {
    const f = setup();
    f.entries.set('/other', stats());
    await expect(
      f.change({ action: 'rename', directory: '/', name: 'file', newName: 'other', kind: 'file' }),
    ).rejects.toThrow('already exists');
    expect(f.sftp.rename).not.toHaveBeenCalled();
  });
  it('checks the destination again after confirmation', async () => {
    const f = setup();
    f.confirm.mockImplementation(async () => {
      f.entries.set('/new folder', stats());
      return true;
    });
    await expect(f.change()).rejects.toThrow('already exists');
    expect(f.sftp.mkdir).not.toHaveBeenCalled();
  });
  it('rejects changed source metadata after confirmation', async () => {
    const f = setup();
    f.confirm.mockImplementation(async () => {
      f.entries.set('/file', stats('file', 2));
      return true;
    });
    await expect(f.change(remove)).rejects.toThrow('changed while awaiting');
    expect(f.sftp.unlink).not.toHaveBeenCalled();
  });
  it('rejects missing sources', async () => {
    const f = setup();
    f.entries.delete('/file');
    await expect(f.change(remove)).rejects.toThrow('no longer exists');
    expect(f.confirm).not.toHaveBeenCalled();
  });
  it.each(['symlink', 'special', 'directory'])('rejects a source that became %s', async (kind) => {
    const f = setup();
    f.entries.set('/file', stats(kind));
    await expect(f.change(remove)).rejects.toThrow('item type changed');
    expect(f.sftp.unlink).not.toHaveBeenCalled();
  });
  it('rejects invalid metadata', async () => {
    const f = setup();
    f.entries.set('/file', stats('file', NaN));
    await expect(f.change(remove)).rejects.toThrow('invalid item metadata');
  });
  it('rejects a symlink parent', async () => {
    const f = setup();
    f.entries.set('/', stats('symlink'));
    await expect(f.change()).rejects.toThrow('symbolic link');
  });
  it('rejects an alias or replaced parent', async () => {
    const f = setup();
    f.sftp.realpath.mockImplementation((_path, cb) => cb(undefined, '/elsewhere'));
    await expect(f.change()).rejects.toThrow('directory changed');
  });
  it('does not send a change to a replacement connection after confirmation', async () => {
    const f = setup();
    f.confirm.mockImplementation(async () => {
      f.stale();
      return true;
    });
    await expect(f.change()).rejects.toThrow('No file change was sent');
    expect(f.sftp.mkdir).not.toHaveBeenCalled();
  });
  it('handles permission errors without exposing server text', async () => {
    const f = setup();
    f.sftp.mkdir.mockImplementation((_p, _a, cb) =>
      cb(Object.assign(new Error('server text'), { code: 3 })),
    );
    await expect(f.change()).rejects.toThrow('denied permission');
  });
  it('handles missing and nonempty/server-refused changes', async () => {
    const f = setup();
    for (const [code, message] of [
      [2, 'could not find'],
      [4, 'server refused'],
    ] as const) {
      f.sftp.unlink.mockImplementation((_p, cb) => cb(Object.assign(new Error(), { code })));
      await expect(f.change(remove)).rejects.toThrow(message);
    }
  });
  it('times out preflight without sending a mutation', async () => {
    vi.useFakeTimers();
    const f = setup();
    f.sftp.realpath.mockImplementation(() => undefined);
    const result = expect(f.change(folder, 50)).rejects.toThrow('No file change was sent');
    await vi.advanceTimersByTimeAsync(51);
    await result;
    expect(f.invalidate).toHaveBeenCalledOnce();
    expect(f.sftp.mkdir).not.toHaveBeenCalled();
  });
  it('enforces one deadline across a phase instead of resetting it for each request', async () => {
    vi.useFakeTimers();
    const f = setup();
    f.sftp.realpath.mockImplementation((path, cb) => {
      vi.setSystemTime(Date.now() + 51);
      cb(undefined, path);
    });
    await expect(f.change(folder, 50)).rejects.toThrow('No file change was sent');
    expect(f.sftp.mkdir).not.toHaveBeenCalled();
    expect(f.invalidate).toHaveBeenCalledOnce();
  });
  it('does not count the time spent reviewing confirmation against the network deadline', async () => {
    vi.useFakeTimers();
    const f = setup();
    f.confirm.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 3600000);
      return true;
    });
    expect(await f.change(folder, 50)).toBe(true);
  });
  it('reports a timeout after sending as uncertain, ignores late responses, and never retries', async () => {
    vi.useFakeTimers();
    const f = setup();
    let callback: (() => void) | undefined;
    f.sftp.mkdir.mockImplementation((_p, _a, cb) => {
      callback = cb;
    });
    const result = expect(f.change(folder, 50)).rejects.toThrow('result is uncertain');
    await vi.advanceTimersByTimeAsync(51);
    await result;
    callback?.();
    expect(f.invalidate).toHaveBeenCalledOnce();
    expect(f.sftp.mkdir).toHaveBeenCalledOnce();
  });
  it.each(['close', 'error', 'abort'])(
    'handles %s while a change is in flight as uncertain',
    async (event) => {
      const f = setup();
      f.sftp.mkdir.mockImplementation(() => {
        if (event === 'abort') f.controller.abort();
        else f.sftp.emit(event, new Error('network'));
      });
      await expect(f.change()).rejects.toThrow('result is uncertain');
      expect(f.sftp.mkdir).toHaveBeenCalledOnce();
    },
  );
  it('handles an abrupt SFTP request exception without retrying', async () => {
    const f = setup();
    f.sftp.mkdir.mockImplementation(() => {
      throw new Error('closed');
    });
    await expect(f.change()).rejects.toThrow('result is uncertain');
    expect(f.invalidate).toHaveBeenCalledOnce();
  });
  it('treats SFTP connection-lost status as uncertain', async () => {
    const f = setup();
    f.sftp.mkdir.mockImplementation((_p, _a, cb) => cb(Object.assign(new Error(), { code: 7 })));
    await expect(f.change()).rejects.toThrow('result is uncertain');
    expect(f.invalidate).toHaveBeenCalledOnce();
  });
  it('treats a code-less callback failure after sending as uncertain', async () => {
    const f = setup();
    f.sftp.mkdir.mockImplementation((_p, _a, cb) => cb(new Error('No response from server')));
    await expect(f.change()).rejects.toThrow('result is uncertain');
    expect(f.invalidate).toHaveBeenCalledOnce();
  });
});
describe('file action payload validation', () => {
  it.each([
    '',
    '.',
    '..',
    '../file',
    'a/b',
    'a\\b',
    '/etc',
    'a\0b',
    'a\nb',
    'a\u007fb',
    'a\u202eb',
    'a\u2066b',
    '界'.repeat(86),
  ])('rejects unsafe name %j', (name) => {
    expect(fileActionSchema.safeParse({ ...folder, name }).success).toBe(false);
  });
  it.each(['relative', '/a/../b', '/a//b', '/a/', '/a\nb', '/a\\b'])(
    'rejects noncanonical directory %j',
    (directory) => {
      expect(fileActionSchema.safeParse({ ...folder, directory }).success).toBe(false);
    },
  );
  it('allows literal shell characters without shell interpretation', () => {
    expect(
      fileActionSchema.parse({ ...folder, name: "space 'quote' $(touch pwned) 日本語" }).name,
    ).toContain('$(touch');
  });
  it('rejects combined overlong paths, extra fields, root-like targets, and unchanged names', () => {
    expect(
      fileActionSchema.safeParse({ ...folder, directory: '/' + 'a'.repeat(4090) }).success,
    ).toBe(false);
    expect(fileActionSchema.safeParse({ ...remove, recursive: true }).success).toBe(false);
    expect(fileActionSchema.safeParse({ ...remove, name: '/' }).success).toBe(false);
    expect(
      fileActionSchema.safeParse({ ...remove, action: 'rename', newName: 'file' }).success,
    ).toBe(false);
  });
});
