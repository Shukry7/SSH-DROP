import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { TransferRecovery } from '../../src/main/core/transfer-recovery';
import { Session } from '../../src/main/core/session';
import type { SessionEvent } from '../../src/shared/contracts';
import { testVault } from '../fixtures/backup-vault';
import { sshFixture } from '../fixtures/ssh-server';

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
