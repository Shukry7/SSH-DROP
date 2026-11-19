import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { TransferRecovery } from '../../src/main/core/transfer-recovery';
import { RecoveryStore } from '../../src/main/core/recovery-store';
import { Session } from '../../src/main/core/session';
import type { SessionEvent } from '../../src/shared/contracts';
import { backupText, testVault } from '../fixtures/backup-vault';
import { sshFixture } from '../fixtures/ssh-server';

it('requires inspection when a replacement completes before its merge checkpoint is saved', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sshdrop-merge-record-failure-'));
  const root = join(dir, 'vault');
  const local = join(dir, 'destination');
  const remote = '/record-failure';
  const fixture = await sshFixture();
  const events: SessionEvent[] = [];
  let store = new TransferRecovery(testVault(join(dir, 'transfers')));
  const save = store.saveFolderCheckpoint.bind(store);
  vi.spyOn(store, 'saveFolderCheckpoint').mockImplementation(async (id, checkpoint) => {
    if (checkpoint.entries.some((entry) => entry.replacementId && entry.destinationKey))
      throw new Error('Simulated journal write failure');
    await save(id, checkpoint);
  });
  const confirm = vi.fn(async ({ title }: { title: string }) =>
    title === 'File already exists' ? 2 : 1,
  );
  const createSession = () =>
    new Session(
      { verify: async () => true },
      (event) => events.push(event),
      undefined,
      { store: new RecoveryStore(root, testVault(root)), confirm },
      undefined,
      store,
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
    await writeFile(join(local, 'a.txt'), 'original');
    await writeFile(join(local, 'b.txt'), 'original');
    fixture.directories.add(remote);
    fixture.files.set(remote + '/a.txt', Buffer.from('incoming'));
    fixture.files.set(remote + '/b.txt', Buffer.from('incoming'));
    await connect();
    session.setTransferMemory(true);
    await session.queueFiles([{ direction: 'download', local, remote, folder: true }]);
    await vi.waitFor(
      async () => {
        expect(
          events.some(
            (event) =>
              event.type === 'transfer' && event.transfer.error?.includes('journal write failure'),
          ),
        ).toBe(true);
        expect(await session.savedTransfers()).toHaveLength(1);
      },
      { timeout: 10000 },
    );
    expect(await readFile(join(local, 'a.txt'), 'utf8')).toBe('incoming');
    expect(await readFile(join(local, 'b.txt'), 'utf8')).toBe('original');
    session.disconnect();
    store = new TransferRecovery(testVault(join(dir, 'transfers')));
    session = createSession();
    await connect();
    confirm.mockClear();
    const [saved] = await session.savedTransfers();
    await session.reviewSavedTransfer(saved.id, 'retry', async () => true);
    await vi.waitFor(async () => {
      expect(
        events.some(
          (event) =>
            event.type === 'transfer' && event.transfer.error?.includes('needs inspection'),
        ),
      ).toBe(true);
      expect(await session.savedTransfers()).toHaveLength(1);
    });
    expect(confirm).not.toHaveBeenCalled();
    const [backup] = await session.recovery();
    expect(await backupText(testVault(root), backup.id)).toBe('original');
    expect(await readFile(join(local, 'b.txt'), 'utf8')).toBe('original');
  } finally {
    session.disconnect();
    await fixture.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}, 20000);

it.each(['download', 'upload'] as const)(
  'recovers a completed backed-up %s replacement and refuses a corrupt backup before continuing',
  async (direction) => {
    const dir = await mkdtemp(join(tmpdir(), 'sshdrop-backed-merge-'));
    const local = join(dir, 'destination');
    const root = join(dir, 'vault');
    const fixture = await sshFixture({ atomicReplace: true });
    const remote = '/backed-merge';
    const events: SessionEvent[] = [];
    let interrupt = true;
    const uploading = direction === 'upload';
    const readTarget = (name: string) =>
      uploading
        ? Promise.resolve(fixture.files.get(remote + '/' + name)?.toString())
        : readFile(join(local, name), 'utf8');
    const conflicts: string[] = [];
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
            expect(buttons).toEqual(['Skip file', 'Keep both', 'Back up and replace']);
            conflicts.push(detail);
            return 2;
          },
        },
        undefined,
        new TransferRecovery(testVault(join(root, 'transfers'))),
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
      fixture.directories.add(remote);
      for (const name of ['a.txt', 'b.txt']) {
        await writeFile(join(local, name), uploading ? 'incoming' : 'original');
        fixture.files.set(remote + '/' + name, Buffer.from(uploading ? 'original' : 'incoming'));
      }
      await connect();
      session.setTransferMemory(true);
      await session.queueFiles([{ direction, local, remote, folder: true }]);
      await vi.waitFor(() => expect(interrupt).toBe(false), { timeout: 10000 });
      session = createSession();
      await connect();
      const [saved] = await session.savedTransfers();
      const [backup] = await session.recovery();
      expect(backup).toMatchObject({ state: 'completed', encrypted: true });
      expect(await backupText(testVault(root), backup.id)).toBe('original');
      expect(await readTarget('a.txt')).toBe('incoming');
      const backupPath = join(root, backup.id + '.bak.enc');
      const bytes = await readFile(backupPath);
      await writeFile(backupPath, Buffer.from('corrupt'));
      await session.reviewSavedTransfer(saved.id, 'retry', async () => true);
      await vi.waitFor(async () => {
        expect(
          events.some(
            (event) =>
              event.type === 'transfer' && event.transfer.error?.includes('Backup is locked'),
          ),
        ).toBe(true);
        expect(await session.savedTransfers()).toHaveLength(1);
      });
      expect(conflicts).toHaveLength(1);
      expect(await readTarget('b.txt')).toBe('original');
      await writeFile(backupPath, bytes);
      if (uploading) {
        fixture.files.set(remote + '/a.txt', Buffer.from('tampered'));
        await session.reviewSavedTransfer(saved.id, 'retry', async () => true);
        await vi.waitFor(async () => {
          expect(
            events.some(
              (event) =>
                event.type === 'transfer' &&
                event.transfer.error?.includes('completed destination file changed'),
            ),
          ).toBe(true);
          expect(await session.savedTransfers()).toHaveLength(1);
        });
        expect(conflicts).toHaveLength(1);
        expect(await readTarget('b.txt')).toBe('original');
        fixture.files.set(remote + '/a.txt', Buffer.from('incoming'));
      }
      await session.reviewSavedTransfer(saved.id, 'retry', async () => true);
      await vi.waitFor(
        async () => {
          expect(
            events.some(
              (event) => event.type === 'transfer' && event.transfer.status === 'completed',
            ),
          ).toBe(true);
          expect(await session.savedTransfers()).toEqual([]);
        },
        { timeout: 10000 },
      );
      expect(conflicts).toHaveLength(2);
      expect(await readTarget('b.txt')).toBe('incoming');
      expect(await session.recovery()).toHaveLength(2);
      await session.recover({ id: backup.id, action: 'rollback' });
      expect(await readTarget('a.txt')).toBe('original');
      expect(await readTarget('b.txt')).toBe('incoming');
    } finally {
      session.disconnect();
      await fixture.close();
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  },
  20000,
);

it('preserves an uncertain upload replacement and stops its saved merge until inspection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sshdrop-uncertain-backed-merge-'));
  const root = join(dir, 'vault');
  const local = join(dir, 'source');
  const remote = '/uncertain-backed-merge';
  const fixture = await sshFixture({ atomicReplace: true, dropAfterReplace: true });
  const events: SessionEvent[] = [];
  const confirm = vi.fn(async ({ title }: { title: string }) =>
    title === 'File already exists' ? 2 : 1,
  );
  const createSession = () =>
    new Session(
      { verify: async () => true },
      (event) => events.push(event),
      undefined,
      { store: new RecoveryStore(root, testVault(root)), confirm },
      undefined,
      new TransferRecovery(testVault(join(dir, 'transfers'))),
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
    fixture.directories.add(remote);
    for (const name of ['a.txt', 'b.txt']) {
      await writeFile(join(local, name), 'incoming');
      fixture.files.set(remote + '/' + name, Buffer.from('original'));
    }
    await connect();
    session.setTransferMemory(true);
    await session.queueFiles([{ direction: 'upload', local, remote, folder: true }]);
    await vi.waitFor(
      () => {
        expect(events.some((event) => event.type === 'status' && event.lost)).toBe(true);
      },
      { timeout: 10000 },
    );
    expect(fixture.files.get(remote + '/a.txt')?.toString()).toBe('incoming');
    expect(fixture.files.get(remote + '/b.txt')?.toString()).toBe('original');
    session.disconnect();
    session = createSession();
    await connect();
    const [record] = await session.recovery();
    expect(record.state).toBe('uncertain');
    expect(await backupText(testVault(root), record.id)).toBe('original');
    const [saved] = await session.savedTransfers();
    confirm.mockClear();
    await session.reviewSavedTransfer(saved.id, 'retry', async () => true);
    await vi.waitFor(async () => {
      expect(
        events.some(
          (event) =>
            event.type === 'transfer' && event.transfer.error?.includes('needs inspection'),
        ),
      ).toBe(true);
      expect(await session.savedTransfers()).toHaveLength(1);
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(fixture.files.get(remote + '/b.txt')?.toString()).toBe('original');
  } finally {
    session.disconnect();
    await fixture.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}, 20000);

it.each(['download', 'upload'] as const)(
  'recovers a %s merge without repeating completed decisions or replacing originals',
  async (direction) => {
    const dir = await mkdtemp(join(tmpdir(), 'sshdrop-merge-recovery-'));
    const local = join(dir, 'destination');
    const root = join(dir, 'vault');
    const fixture = await sshFixture();
    const remote = '/merge-test';
    const events: SessionEvent[] = [];
    const conflicts: string[] = [];
    const uploading = direction === 'upload';
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
            expect(buttons).toEqual(
              uploading
                ? ['Skip file', 'Keep both']
                : ['Skip file', 'Keep both', 'Back up and replace'],
            );
            conflicts.push(detail);
            return detail.includes('a.txt') ? 0 : 1;
          },
        },
        undefined,
        new TransferRecovery(testVault(join(root, 'transfers'))),
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
        await writeFile(join(local, name), uploading ? 'incoming' : 'original');
        fixture.files.set(remote + '/' + name, Buffer.from(uploading ? 'original' : 'incoming'));
      }
      fixture.directories.add(remote);
      const writeTarget = async (name: string, contents: string) => {
        if (uploading) fixture.files.set(remote + '/' + name, Buffer.from(contents));
        else await writeFile(join(local, name), contents);
      };
      const readTarget = async (name: string) =>
        uploading
          ? fixture.files.get(remote + '/' + name)?.toString()
          : readFile(join(local, name), 'utf8');
      const listTarget = async () =>
        uploading
          ? [...fixture.files.keys()]
              .filter((name) => name.startsWith(remote + '/'))
              .map((name) => name.slice(remote.length + 1))
          : readdir(local);
      await writeTarget('unrelated.txt', 'keep');
      await connect();
      session.setTransferMemory(true);
      await session.queueFiles([{ direction, local, remote, folder: true }]);
      await vi.waitFor(() => expect(interrupt).toBe(false), { timeout: 10000 });
      session = createSession();
      await connect();
      const [record] = await session.savedTransfers();
      expect(record).toMatchObject({
        direction,
        merge: true,
        copiedFiles: 1,
        skippedFiles: 1,
        totalFiles: 3,
      });
      await session.reviewSavedTransfer(record.id, 'retry', async () => false);
      expect(conflicts).toHaveLength(2);
      await writeTarget('unexpected.txt', 'keep');
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
      if (uploading) {
        fixture.files.delete(remote + '/unexpected.txt');
        await writeTarget('c.txt', 'modified');
        await session.reviewSavedTransfer(record.id, 'retry', async () => true);
        await vi.waitFor(async () => {
          expect(
            events.some(
              (event) =>
                event.type === 'transfer' &&
                event.transfer.error?.includes('original merge file changed'),
            ),
          ).toBe(true);
          expect(await session.savedTransfers()).toHaveLength(1);
        });
        expect(conflicts).toHaveLength(2);
        expect(await readTarget('c.txt')).toBe('modified');
        await writeTarget('c.txt', 'original');
      } else await unlink(join(local, 'unexpected.txt'));
      await session.reviewSavedTransfer(record.id, 'retry', async () => true);
      await vi.waitFor(async () => {
        expect(
          events.some(
            (event) => event.type === 'transfer' && event.transfer.status === 'completed',
          ),
        ).toBe(true);
        expect(await session.savedTransfers()).toEqual([]);
      });
      expect(conflicts).toHaveLength(3);
      expect(conflicts.at(-1)).toContain('c.txt');
      for (const name of ['a.txt', 'b.txt', 'c.txt'])
        expect(await readTarget(name)).toBe('original');
      const copies = (await listTarget()).filter((name) => /^(b|c) \(copy /.test(name));
      expect(copies).toHaveLength(2);
      for (const name of copies) expect(await readTarget(name)).toBe('incoming');
      expect(await readTarget('unrelated.txt')).toBe('keep');
    } finally {
      session.disconnect();
      await fixture.close();
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  },
  20000,
);

it('stops an upload merge retry after a remote copy lost its publication acknowledgement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sshdrop-uncertain-merge-'));
  const local = join(dir, 'source');
  const remote = '/uncertain-merge';
  const fixture = await sshFixture();
  const root = join(dir, 'vault');
  const events: SessionEvent[] = [];
  const confirm = vi.fn(async () => 1);
  const createSession = () =>
    new Session(
      { verify: async () => true },
      (event) => events.push(event),
      undefined,
      { store: new RecoveryStore(root, testVault(root)), confirm },
      undefined,
      new TransferRecovery(testVault(join(root, 'transfers'))),
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
    await writeFile(join(local, 'file.txt'), 'incoming');
    fixture.directories.add(remote);
    fixture.files.set(remote + '/file.txt', Buffer.from('original'));
    let published = '';
    fixture.afterRename = (to) => {
      published = to;
      fixture.drop();
    };
    await connect();
    session.setTransferMemory(true);
    await session.queueFiles([{ direction: 'upload', local, remote, folder: true }]);
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === 'status' && event.lost)).toBe(true),
    );
    expect(published).toMatch(/\/file \(copy /);
    expect(fixture.files.get(published)?.toString()).toBe('incoming');
    fixture.afterRename = undefined;
    session = createSession();
    await connect();
    const [record] = await session.savedTransfers();
    expect(record).toMatchObject({ copiedFiles: 0, totalFiles: 1, merge: true });
    confirm.mockClear();
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
    expect(confirm).not.toHaveBeenCalled();
    expect([...fixture.files.keys()].filter((path) => path.startsWith(remote + '/'))).toEqual([
      remote + '/file.txt',
      published,
    ]);
    expect(fixture.files.get(remote + '/file.txt')?.toString()).toBe('original');
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
    await expect.poll(() => fixture.files.get(second)).toEqual(original);
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
    await vi.waitFor(() => expect(interrupt).toBe(false), { timeout: 10000 });
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

it('rejects aliased local ancestors for saved transfers and accepts the canonical directory', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'sshdrop-transfer-alias-')));
  const fixture = await sshFixture();
  const session = new Session(
    { verify: async () => true },
    () => {},
    undefined,
    undefined,
    undefined,
    new TransferRecovery(testVault(join(dir, 'journal'))),
  );
  try {
    const actual = join(dir, 'actual');
    const alias = join(dir, 'alias');
    await mkdir(join(actual, 'nested'), { recursive: true });
    await symlink(actual, alias, 'junction');
    const local = join(actual, 'nested', 'source.txt');
    await writeFile(local, 'canonical source');
    await session.connect({
      host: '127.0.0.1',
      port: fixture.port,
      username: 'tester',
      password: 'test-password',
    });
    session.setTransferMemory(true);
    await expect(
      session.queueFiles([
        {
          direction: 'upload',
          local: join(alias, 'nested', 'source.txt'),
          remote: '/canonical.txt',
        },
      ]),
    ).rejects.toThrow('missing or unsafe');
    expect(fixture.files.has('/canonical.txt')).toBe(false);
    await session.queueFiles([{ direction: 'upload', local, remote: '/canonical.txt' }]);
    await expect
      .poll(() => fixture.files.get('/canonical.txt')?.toString())
      .toBe('canonical source');
    await expect.poll(() => session.savedTransfers()).toEqual([]);
  } finally {
    session.disconnect();
    await fixture.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

it('preserves an encrypted interrupted job and permits only a confirmed, unchanged retry', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'sshdrop-saved-transfer-')));
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
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'sshdrop-upload-resume-')));
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
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'sshdrop-download-resume-')));
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
