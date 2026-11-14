import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { TransferRecovery } from '../../src/main/core/transfer-recovery';
import { Session } from '../../src/main/core/session';
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
