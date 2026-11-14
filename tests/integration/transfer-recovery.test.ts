import { mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { TransferRecovery } from '../../src/main/core/transfer-recovery';
import { RecoveryStore } from '../../src/main/core/recovery-store';
import { Session } from '../../src/main/core/session';
import type { SessionEvent } from '../../src/shared/contracts';
import { testVault } from '../fixtures/backup-vault';
import { sshFixture } from '../fixtures/ssh-server';

it('recovers a download merge without repeating completed decisions or replacing originals', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sshdrop-merge-recovery-'));
  const local = join(dir, 'destination');
  const root = join(dir, 'vault');
  const fixture = await sshFixture();
  const remote = '/merge-test';
  const events: SessionEvent[] = [];
  const conflicts: string[] = [];
  let interrupt = true;
  const createSession = () =>
    new Session(
      { verify: async () => true },
      (event) => {
        events.push(event);
        if (interrupt && event.type === 'transfer' && event.transfer.folderFiles?.copied === 1) {
          interrupt = false;
          session.disconnect();
        }
      },
      undefined,
      {
        store: new RecoveryStore(root, testVault(root)),
        confirm: async ({ title, buttons, detail }) => {
          if (title !== 'File already exists') return 1;
          expect(buttons).toEqual(['Skip file', 'Keep both']);
          conflicts.push(detail);
          return detail.includes('a.txt') ? 0 : 1;
        },
      },
      undefined,
      new TransferRecovery(testVault(root)),
    );
  let session = createSession();
  const connect = () =>
    session.connect({
      host: '127.0.0.1',
      port: fixture.port,
      username: 'tester',
      password: 'test-password',
    });
  try {
    await mkdir(local);
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      await writeFile(join(local, name), 'original');
      fixture.files.set(remote + '/' + name, Buffer.from('incoming'));
    }
    fixture.directories.add(remote);
    await writeFile(join(local, 'unrelated.txt'), 'keep');
    await connect();
    session.setTransferMemory(true);
    await session.queueFiles([{ direction: 'download', local, remote, folder: true }]);
    await vi.waitFor(() => expect(interrupt).toBe(false));
    session = createSession();
    await connect();
    const [record] = await session.savedTransfers();
    expect(record).toMatchObject({ copiedFiles: 1, totalFiles: 3 });
    await session.reviewSavedTransfer(record.id, 'retry', async () => false);
    expect(conflicts).toHaveLength(2);
    await writeFile(join(local, 'unexpected.txt'), 'keep');
    await session.reviewSavedTransfer(record.id, 'retry', async () => true);
    await vi.waitFor(async () => {
      expect(
        events.some(
          (event) =>
            event.type === 'transfer' && event.transfer.error?.includes('Unexpected entries'),
        ),
      ).toBe(true);
      expect(await session.savedTransfers()).toHaveLength(1);
    });
    expect(conflicts).toHaveLength(2);
    await unlink(join(local, 'unexpected.txt'));
    await session.reviewSavedTransfer(record.id, 'retry', async () => true);
    await vi.waitFor(async () => {
      expect(
        events.some((event) => event.type === 'transfer' && event.transfer.status === 'completed'),
      ).toBe(true);
      expect(await session.savedTransfers()).toEqual([]);
    });
    expect(conflicts).toHaveLength(3);
    expect(conflicts.at(-1)).toContain('c.txt');
    for (const name of ['a.txt', 'b.txt', 'c.txt'])
      expect(await readFile(join(local, name), 'utf8')).toBe('original');
    for (const name of (await readdir(local)).filter((name) => /^(b|c) \(copy /.test(name)))
      expect(await readFile(join(local, name), 'utf8')).toBe('incoming');
    expect((await readdir(local)).filter((name) => name.includes(' (copy '))).toHaveLength(2);
    expect(await readFile(join(local, 'unrelated.txt'), 'utf8')).toBe('keep');
  } finally {
    session.disconnect();
    await fixture.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}, 20000);

it('recovers a folder upload using only verified remote files and a verified partial file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sshdrop-saved-folder-upload-'));
  const local = join(dir, 'source');
  const remote = '/saved-folder-upload';
  const original = Buffer.alloc(256 * 1024, 42);
  const offsets: number[] = [];
  let stall = true;
  const fixture = await sshFixture({
    stallWriteAt: (offset) => {
      offsets.push(offset);
      return stall && offset >= 65536;
    },
  });
  const events: SessionEvent[] = [];
  const createSession = () =>
    new Session(
      { verify: async () => true },
      (event) => events.push(event),
      undefined,
      undefined,
      undefined,
      new TransferRecovery(testVault(join(dir, 'journal'))),
    );
  let session = createSession();
  const connect = () =>
    session.connect({
      host: '127.0.0.1',
      port: fixture.port,
      username: 'tester',
      password: 'test-password',
    });
  const first = remote + '/a.txt';
  const second = remote + '/b.bin';
  try {
    await mkdir(join(local, 'empty'), { recursive: true });
    await writeFile(join(local, 'a.txt'), 'first');
    await writeFile(join(local, 'b.bin'), original);
    await connect();
    session.setTransferMemory(true);
    await session.queueFiles([{ direction: 'upload', local, remote, folder: true }]);
    await vi.waitFor(() => expect(offsets).toContain(65536));
    expect(fixture.files.get(first)?.toString()).toBe('first');
    const stage = [...fixture.files.keys()].find((name) => name.endsWith('.part'))!;
    expect(fixture.files.get(stage)).toEqual(original.subarray(0, 65536));
    fixture.drop();
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === 'status' && event.lost)).toBe(true),
    );
    session = createSession();
    await connect();
    const [record] = await session.savedTransfers();
    expect(record).toMatchObject({
      direction: 'upload',
      folder: true,
      copiedFiles: 1,
      totalFiles: 2,
    });
    stall = false;
    offsets.length = 0;
    const retry = () => session.reviewSavedTransfer(record.id, 'retry', async () => true);
    const rejectsRetry = async (message: string) => {
      await retry();
      await vi.waitFor(async () => {
        expect(
          events.some(
            (event) => event.type === 'transfer' && event.transfer.error?.includes(message),
          ),
        ).toBe(true);
        expect(await session.savedTransfers()).toHaveLength(1);
      });
      expect(fixture.files.has(second)).toBe(false);
      expect(offsets).toEqual([]);
    };
    const extra = remote + '/unexpected.txt';
    fixture.files.set(extra, Buffer.from('preserve'));
    await rejectsRetry('Unexpected entries');
    expect(fixture.files.get(extra)?.toString()).toBe('preserve');
    fixture.files.delete(extra);
    fixture.files.set(first, Buffer.from('other'));
    await rejectsRetry('completed destination file changed');
    fixture.files.set(first, Buffer.from('first'));
    fixture.files.set(stage, Buffer.alloc(65536, 99));
    await rejectsRetry('prefix does not match');
    fixture.files.set(stage, original.subarray(0, 65536));
    await retry();
    await vi.waitFor(() => expect(fixture.files.get(second)).toEqual(original));
    expect(offsets[0]).toBe(65536);
    expect(fixture.files.has(stage)).toBe(false);
    await vi.waitFor(() =>
      expect(
        events.some((event) => event.type === 'transfer' && event.transfer.status === 'completed'),
      ).toBe(true),
    );
    expect(fixture.directories.has(remote + '/empty')).toBe(true);
    await vi.waitFor(async () => expect(await session.savedTransfers()).toEqual([]));
  } finally {
    session.disconnect();
    await fixture.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}, 20000);

it('continues a saved folder between files after restart and refuses changed sources or extra destination entries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sshdrop-saved-folder-'));
  const fixture = await sshFixture();
  const journal = join(dir, 'journal');
  const local = join(dir, 'download');
  const remote = '/recovery-fixture';
  const events: SessionEvent[] = [];
  let interrupt = true;
  let cancel = false;
  const createSession = () =>
    new Session(
      { verify: async () => true },
      (event) => {
        events.push(event);
        if (interrupt && event.type === 'transfer' && event.transfer.folderFiles?.copied === 1) {
          interrupt = false;
          session.disconnect();
        }
        if (cancel && event.type === 'transfer' && event.transfer.folderFiles?.copied === 1) {
          cancel = false;
          session.cancel(event.transfer.id);
        }
      },
      undefined,
      undefined,
      undefined,
      new TransferRecovery(testVault(journal)),
    );
  let session = createSession();
  const connect = () =>
    session.connect({
      host: '127.0.0.1',
      port: fixture.port,
      username: 'tester',
      password: 'test-password',
    });
  const failed = async (message: string) =>
    vi.waitFor(async () => {
      expect(events.at(-1)?.type).toBe('queue');
      expect(
        events.some(
          (event) => event.type === 'transfer' && event.transfer.error?.includes(message),
        ),
      ).toBe(true);
      expect(await session.savedTransfers()).toHaveLength(1);
    });
  try {
    fixture.directories.add(remote);
    fixture.files.set(remote + '/a-sensitive.txt', Buffer.from('first private file'));
    fixture.files.set(remote + '/b.txt', Buffer.from('second'));
    await connect();
    session.setTransferMemory(true);
    await session.queueFiles([{ direction: 'download', local, remote, folder: true }]);
    await vi.waitFor(() => expect(interrupt).toBe(false));
    const first = join(local, 'a-sensitive.txt');
    const second = join(local, 'b.txt');
    expect(await readFile(first, 'utf8')).toBe('first private file');
    await expect(readFile(second)).rejects.toMatchObject({ code: 'ENOENT' });
    const encrypted = await readFile(join(journal, 'transfer-queue.enc'));
    expect(encrypted.includes(Buffer.from('a-sensitive.txt'))).toBe(false);
    expect(encrypted.includes(Buffer.from('first private file'))).toBe(false);
    session = createSession();
    await connect();
    const [record] = await session.savedTransfers();
    expect(record).toMatchObject({ folder: true, copiedFiles: 1, totalFiles: 2 });
    await session.reviewSavedTransfer(record.id, 'retry', async () => false);
    await expect(readFile(second)).rejects.toMatchObject({ code: 'ENOENT' });

    fixture.files.set(remote + '/b.txt', Buffer.from('edited'));
    await session.reviewSavedTransfer(record.id, 'retry', async () => true);
    await failed('source file changed');
    await expect(readFile(second)).rejects.toMatchObject({ code: 'ENOENT' });
    fixture.files.set(remote + '/b.txt', Buffer.from('second'));
    const extra = join(local, 'extra.txt');
    await writeFile(extra, 'keep');
    await session.reviewSavedTransfer(record.id, 'retry', async () => true);
    await failed('Unexpected entries');
    expect(await readFile(extra, 'utf8')).toBe('keep');
    await expect(readFile(second)).rejects.toMatchObject({ code: 'ENOENT' });
    await unlink(extra);

    cancel = true;
    await session.reviewSavedTransfer(record.id, 'retry', async () => true);
    await vi.waitFor(async () => {
      expect(
        events.some((event) => event.type === 'transfer' && event.transfer.status === 'cancelled'),
      ).toBe(true);
      expect(await session.savedTransfers()).toHaveLength(1);
    });
    await expect(readFile(second)).rejects.toMatchObject({ code: 'ENOENT' });

    await session.reviewSavedTransfer(record.id, 'retry', async () => true);
    await vi.waitFor(() =>
      expect(
        events.some((event) => event.type === 'transfer' && event.transfer.status === 'completed'),
      ).toBe(true),
    );
    await vi.waitFor(async () => expect(await session.savedTransfers()).toEqual([]));
    expect(await readFile(first, 'utf8')).toBe('first private file');
    expect(await readFile(second, 'utf8')).toBe('second');
  } finally {
    session.disconnect();
    await fixture.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 20000);

it('preserves an encrypted interrupted job and permits only a confirmed, unchanged retry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sshdrop-saved-transfer-'));
  const stalled = ['WRITE'];
  const fixture = await sshFixture({ stall: stalled });
  const other = await sshFixture();
  const local = join(dir, 'sensitive-source.txt');
  const remote = '/sensitive-target.txt';
  const journal = join(dir, 'journal');
  let session = new Session(
    { verify: async () => true },
    () => {},
    undefined,
    undefined,
    undefined,
    new TransferRecovery(testVault(journal)),
  );
  const connect = (port = fixture.port) =>
    session.connect({ host: '127.0.0.1', port, username: 'tester', password: 'test-password' });
  try {
    await writeFile(local, 'original content');
    await connect();
    session.setTransferMemory(true);
    await session.queueFiles([{ direction: 'upload', local, remote }]);
    await vi.waitFor(() =>
      expect(fixture.openedFiles.some((path) => path.endsWith('.part'))).toBe(true),
    );
    session.disconnect();
    const saved = await readFile(join(journal, 'transfer-queue.enc'));
    expect(saved.includes(Buffer.from('sensitive-source'))).toBe(false);
    expect(saved.includes(Buffer.from('original content'))).toBe(false);
    stalled.length = 0;
    // A new session and journal instance model an application restart.
    session = new Session(
      { verify: async () => true },
      () => {},
      undefined,
      undefined,
      undefined,
      new TransferRecovery(testVault(journal)),
    );
    await connect(other.port);
    expect(await session.savedTransfers()).toEqual([]);
    session.disconnect();
    await connect();
    const [record] = await session.savedTransfers();
    expect(record).toMatchObject({ local, remote, direction: 'upload' });
    expect(fixture.files.has(remote)).toBe(false);
    await session.reviewSavedTransfer(record.id, 'retry', async () => false);
    expect(fixture.files.has(remote)).toBe(false);
    await writeFile(local, 'different content');
    await expect(session.reviewSavedTransfer(record.id, 'retry', async () => true)).rejects.toThrow(
      'source changed',
    );
    await writeFile(local, 'original content');
    fixture.files.set(remote, Buffer.from('existing'));
    await expect(session.reviewSavedTransfer(record.id, 'retry', async () => true)).rejects.toThrow(
      'already exists',
    );
    expect(fixture.files.get(remote)?.toString()).toBe('existing');
    fixture.files.delete(remote);
    await session.reviewSavedTransfer(record.id, 'retry', async () => true);
    await vi.waitFor(() => expect(fixture.files.get(remote)?.toString()).toBe('original content'));
    await vi.waitFor(async () => expect(await session.savedTransfers()).toEqual([]));
  } finally {
    session.disconnect();
    await Promise.all([fixture.close(), other.close()]);
    await rm(dir, { recursive: true, force: true });
  }
});

it('resumes the recorded upload stage without rewriting its prefix', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sshdrop-upload-resume-'));
  const original = Buffer.alloc(256 * 1024, 29);
  const local = join(dir, 'upload.bin');
  const remote = '/upload.bin';
  const offsets: number[] = [];
  const events: SessionEvent[] = [];
  let stalled = true;
  const fixture = await sshFixture({
    stallWriteAt: (offset) => {
      offsets.push(offset);
      return stalled && offset >= 65536;
    },
  });
  const createSession = () =>
    new Session(
      { verify: async () => true },
      (event) => events.push(event),
      undefined,
      undefined,
      undefined,
      new TransferRecovery(testVault(join(dir, 'journal'))),
    );
  let session = createSession();
  const connect = () =>
    session.connect({
      host: '127.0.0.1',
      port: fixture.port,
      username: 'tester',
      password: 'test-password',
    });
  try {
    await writeFile(local, original);
    await connect();
    session.setTransferMemory(true);
    await session.queueFiles([{ direction: 'upload', local, remote }]);
    await vi.waitFor(() => expect(offsets).toContain(65536));
    const stage = [...fixture.files.keys()].find((path) => path.endsWith('.part'))!;
    const prefix = fixture.files.get(stage)!;
    expect(prefix).toEqual(original.subarray(0, 65536));
    session.disconnect();
    session = createSession();
    await connect();
    const [record] = await session.savedTransfers();
    offsets.length = 0;
    stalled = false;
    fixture.files.set(stage, Buffer.alloc(prefix.length, 99));
    await session.reviewSavedTransfer(record.id, 'retry', async () => true);
    await vi.waitFor(() =>
      expect(
        events.some(
          (event) =>
            event.type === 'transfer' && event.transfer.error?.includes('prefix does not match'),
        ),
      ).toBe(true),
    );
    await vi.waitFor(async () => expect(await session.savedTransfers()).toHaveLength(1));
    expect(offsets).toEqual([]);
    expect(fixture.files.has(remote)).toBe(false);
    fixture.files.set(stage, prefix);
    await session.reviewSavedTransfer(record.id, 'retry', async () => true);
    await vi.waitFor(() => expect(fixture.files.get(remote)?.equals(original)).toBe(true));
    expect(offsets[0]).toBe(prefix.length);
    expect(fixture.files.has(stage)).toBe(false);
    await vi.waitFor(async () => expect(await session.savedTransfers()).toEqual([]));
  } finally {
    session.disconnect();
    await fixture.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}, 20000);

it('authenticates a retained download prefix, rejects changed remote bytes and resumes safely', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sshdrop-download-resume-'));
  let stall = false;
  const fixture = await sshFixture({ stallReadAt: (offset) => stall && offset >= 65536 });
  const local = join(dir, 'destination.bin');
  const remote = '/download.bin';
  const original = Buffer.alloc(256 * 1024, 42);
  const events: SessionEvent[] = [];
  const makeStore = () => new TransferRecovery(testVault(join(dir, 'journal')));
  let store = makeStore();
  const createSession = () =>
    new Session(
      { verify: async () => true },
      (event) => {
        events.push(event);
        if (event.type === 'transfer' && event.transfer.phase === 'transferring' && !stall)
          stall = stallOnStart;
      },
      undefined,
      undefined,
      undefined,
      store,
    );
  let stallOnStart = true;
  let session = createSession();
  const connect = () =>
    session.connect({
      host: '127.0.0.1',
      port: fixture.port,
      username: 'tester',
      password: 'test-password',
    });
  try {
    fixture.files.set(remote, original);
    await connect();
    session.setTransferMemory(true);
    await session.queueFiles([{ direction: 'download', local, remote }]);
    await vi.waitFor(() =>
      expect(
        events.some((event) => event.type === 'transfer' && event.transfer.transferred > 0),
      ).toBe(true),
    );
    session.disconnect();
    await connect();
    let id = '';
    await vi.waitFor(
      async () => {
        const [record] = await session.savedTransfers();
        expect(record).toBeDefined();
        id = record.id;
      },
      { timeout: 5000 },
    );
    expect((await store.readDownloadPrefix(id)).length).toBe(65536);
    const encrypted = await readFile(join(dir, 'journal', `${id}.download.enc`));
    expect(encrypted.includes(original.subarray(0, 256))).toBe(false);
    await expect(readFile(local)).rejects.toMatchObject({ code: 'ENOENT' });
    session.disconnect();
    store = makeStore();
    session = createSession();
    stallOnStart = false;
    stall = false;
    await connect();
    await writeFile(
      join(dir, 'journal', `${id}.download.enc`),
      Buffer.concat([encrypted.subarray(0, -1), Buffer.from([encrypted.at(-1)! ^ 1])]),
    );
    await session.reviewSavedTransfer(id, 'retry', async () => true);
    await vi.waitFor(() =>
      expect(
        events.some(
          (event) =>
            event.type === 'transfer' && event.transfer.error?.includes('verify the saved partial'),
        ),
      ).toBe(true),
    );
    await vi.waitFor(async () => expect(await session.savedTransfers()).toHaveLength(1));
    await writeFile(join(dir, 'journal', `${id}.download.enc`), encrypted);
    const modified = Buffer.from(original);
    modified[0] ^= 1;
    fixture.files.set(remote, modified);
    await session.reviewSavedTransfer(id, 'retry', async () => true);
    await vi.waitFor(() =>
      expect(
        events.some(
          (event) =>
            event.type === 'transfer' && event.transfer.error?.includes('prefix no longer matches'),
        ),
      ).toBe(true),
    );
    await vi.waitFor(async () => expect(await session.savedTransfers()).toHaveLength(1));
    await expect(readFile(local)).rejects.toMatchObject({ code: 'ENOENT' });
    fixture.files.set(remote, original);
    await session.reviewSavedTransfer(id, 'retry', async () => true);
    await vi.waitFor(async () => expect((await readFile(local)).equals(original)).toBe(true));
    await vi.waitFor(async () => expect(await session.savedTransfers()).toEqual([]));
  } finally {
    session.disconnect();
    await fixture.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}, 20000);
