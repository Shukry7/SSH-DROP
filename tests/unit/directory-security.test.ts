import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileEntryWithStats, SFTPWrapper } from 'ssh2';
import { directoryLimits, readDirectory } from '../../src/main/core/directory';

function entry(name = 'file.txt', size = 1): FileEntryWithStats {
  return {
    filename: name,
    longname: '',
    attrs: {
      size,
      mtime: 1700000000,
      isDirectory: () => false,
      isFile: () => true,
      isSymbolicLink: () => false,
    },
  } as FileEntryWithStats;
}
function fixture(pages: FileEntryWithStats[][], repeat = false) {
  let index = 0;
  const close = vi.fn((_handle, callback) => callback(undefined));
  const readdir = vi.fn((_handle, callback) => {
    const page = pages[index++];
    if (page || repeat) callback(undefined, page ?? pages[0]);
    else callback(Object.assign(new Error('EOF'), { code: 1 }));
  });
  const sftp = {
    realpath: (_path: string, cb: (error: Error | undefined, path: string) => void) =>
      cb(undefined, '/'),
    opendir: (_path: string, cb: (error: Error | undefined, handle: Buffer) => void) =>
      cb(undefined, Buffer.from('directory')),
    readdir,
    close,
  } as unknown as SFTPWrapper;
  return { sftp, readdir, close };
}
afterEach(() => vi.useRealTimers());
describe('bounded hostile-server directory handling', () => {
  it('reads multiple batches, filters dots, and closes the handle', async () => {
    const f = fixture([[entry('.'), entry('..'), entry('日本語.txt')], [entry('another.txt')]]);
    expect((await readDirectory(f.sftp, '/', () => true)).entries.map((e) => e.name)).toEqual([
      'another.txt',
      '日本語.txt',
    ]);
    expect(f.close).toHaveBeenCalledTimes(1);
  });
  it.each(['', '../escape', 'bad\nname', 'a'.repeat(4097)])(
    'rejects unsafe filename %# and closes the handle',
    async (name) => {
      const f = fixture([[entry(name)]]);
      await expect(readDirectory(f.sftp, '/', () => true)).rejects.toThrow('invalid filename');
      expect(f.close).toHaveBeenCalledTimes(1);
    },
  );
  it.each([-1, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid file size %#',
    async (size) => {
      await expect(
        readDirectory(fixture([[entry('file', size)]]).sftp, '/', () => true),
      ).rejects.toThrow('metadata');
    },
  );
  it('stops endlessly repeated and empty batches and closes their handles', async () => {
    for (const page of [[entry()], []]) {
      const f = fixture([page], true);
      await expect(readDirectory(f.sftp, '/', () => true)).rejects.toThrow('safety limit');
      expect(f.readdir).toHaveBeenCalledTimes(directoryLimits.batches);
      expect(f.close).toHaveBeenCalledTimes(1);
    }
  });
  it('bounds entry count and total UTF-8 listing size', async () => {
    for (const page of [
      Array.from({ length: 10001 }, () => entry()),
      Array.from({ length: 500 }, () => entry('界'.repeat(1000))),
    ]) {
      const f = fixture([page], true);
      await expect(readDirectory(f.sftp, '/', () => true)).rejects.toThrow('safety limit');
      expect(f.close).toHaveBeenCalledTimes(1);
    }
  });
  it('times out a stalled batch without accumulating entries forever', async () => {
    vi.useFakeTimers();
    const f = fixture([]);
    f.readdir.mockImplementation(() => undefined);
    const result = expect(readDirectory(f.sftp, '/', () => true)).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(directoryLimits.milliseconds + 1);
    await result;
    expect(f.close).toHaveBeenCalledTimes(1);
  });
  it('rejects stale connection results', async () => {
    let calls = 0;
    const f = fixture([[entry()]]);
    await expect(readDirectory(f.sftp, '/', () => ++calls < 2)).rejects.toThrow(
      'connection changed',
    );
    expect(f.close).toHaveBeenCalledTimes(1);
  });
  it('closes a handle that arrives after an open-directory timeout', async () => {
    vi.useFakeTimers();
    const f = fixture([]);
    let opened!: (error: Error | undefined, handle: Buffer) => void;
    f.sftp.opendir = (_path, cb) => {
      opened = cb;
    };
    const result = expect(readDirectory(f.sftp, '/', () => true)).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(directoryLimits.milliseconds + 1);
    await result;
    opened(undefined, Buffer.from('late-handle'));
    expect(f.close).toHaveBeenCalledTimes(1);
  });
});
