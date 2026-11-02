import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Session } from '../../src/main/core/session';
import { RecoveryStore } from '../../src/main/core/recovery-store';
import type { ReplacementApproval } from '../../src/main/core/replacement';
import { sshFixture } from '../fixtures/ssh-server';

describe('verified overwrite and persistent recovery over SFTP', () => {
  let directory: string;
  let fixture: Awaited<ReturnType<typeof sshFixture>>;
  let session: Session;
  let choice: number;
  let approvals: ReplacementApproval[];
  let confirmHook: (() => void | Promise<void>) | undefined;
  let store: RecoveryStore;
  const original = 'Hello from the remote server.\n';
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'sshdrop-replace-'));
    choice = 2;
    approvals = [];
    confirmHook = undefined;
    store = new RecoveryStore(join(directory, 'backups'));
    fixture = await sshFixture({ atomicReplace: true });
  });
  async function connect() {
    session = new Session({ verify: async () => true }, () => undefined, undefined, {
      store,
      confirm: async (approval) => {
        approvals.push(approval);
        await confirmHook?.();
        return choice;
      },
    });
    await session.connect({
      host: '127.0.0.1',
      port: fixture.port,
      username: 'tester',
      password: 'test-password',
    });
  }
  async function upload() {
    const local = join(directory, 'hello.txt');
    await writeFile(local, 'replacement');
    await session.transfer('upload', local, '/hello.txt');
  }
  afterEach(async () => {
    session?.disconnect();
    await fixture.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  it('keeps an independent verified backup, persists across reconnect, and rolls back with another backup', async () => {
    await connect();
    await upload();
    expect(fixture.files.get('/hello.txt')?.toString()).toBe('replacement');
    const [record] = await session.recovery();
    expect(record.state).toBe('completed');
    expect(await readFile(store.backup(record.id), 'utf8')).toBe(original);
    expect(approvals[0].detail).toContain('unencrypted');
    session.disconnect();
    store = new RecoveryStore(join(directory, 'backups'));
    await connect();
    choice = 1;
    await session.recover({ id: record.id, action: 'rollback' });
    expect(fixture.files.get('/hello.txt')?.toString()).toBe(original);
    const records = await session.recovery();
    expect(records.find((r) => r.id === record.id)?.state).toBe('restored');
    const newer = records.find((r) => r.id !== record.id)!;
    expect(await readFile(store.backup(newer.id), 'utf8')).toBe('replacement');
    expect(await readdir(join(directory, 'backups'))).toHaveLength(3);
    expect([...fixture.files.keys()].some((p) => p.includes('.sshdrop-recovery'))).toBe(false);
  });
  it('replaces local downloads and safely rolls them back', async () => {
    await connect();
    const local = join(directory, "local 'quote' 日本語.txt");
    await writeFile(local, 'local original');
    await session.transfer('download', local, '/hello.txt');
    expect(await readFile(local, 'utf8')).toBe(original);
    const [record] = await session.recovery();
    expect(await readFile(store.backup(record.id), 'utf8')).toBe('local original');
    choice = 1;
    await session.recover({ id: record.id, action: 'rollback' });
    expect(await readFile(local, 'utf8')).toBe('local original');
  });
  it('cancel and keep-both leave the existing destination intact', async () => {
    await connect();
    choice = 0;
    await upload();
    expect(await session.recovery()).toEqual([]);
    choice = 1;
    await upload();
    expect(fixture.files.get('/hello.txt')?.toString()).toBe(original);
    expect([...fixture.files].find(([p]) => p.includes('(copy '))?.[1].toString()).toBe(
      'replacement',
    );
    expect(await session.recovery()).toEqual([]);
  });
  it('offers only keep-both on servers without atomic replacement support', async () => {
    await fixture.close();
    fixture = await sshFixture();
    await connect();
    choice = 1;
    await upload();
    expect(approvals[0].buttons).toEqual(['Cancel', 'Keep both']);
    expect(fixture.files.get('/hello.txt')?.toString()).toBe(original);
  });
  it('does not replace a destination edited during the confirmation', async () => {
    await connect();
    confirmHook = () => {
      fixture.files.set('/hello.txt', Buffer.from('external edit'));
    };
    await expect(upload()).rejects.toThrow('Backup verification failed');
    expect(fixture.files.get('/hello.txt')?.toString()).toBe('external edit');
    expect((await session.recovery())[0].state).toBe('not-replaced');
  });
  it('does not publish incoming contents changed after approval', async () => {
    await connect();
    confirmHook = () => writeFile(join(directory, 'hello.txt'), 'changed incoming');
    await expect(upload()).rejects.toThrow('source changed');
    expect(fixture.files.get('/hello.txt')?.toString()).toBe(original);
  });
  it('blocks stale native approvals after disconnection and rejects the old file picker lease', async () => {
    await connect();
    const lease = session.lease();
    confirmHook = () => session.disconnect();
    await expect(upload()).rejects.toThrow();
    expect(() => lease()).toThrow('connection changed');
    expect(fixture.files.get('/hello.txt')?.toString()).toBe(original);
  });
  it('refuses rollback after external edits and restores to a new filename instead', async () => {
    await connect();
    await upload();
    const [record] = await session.recovery();
    fixture.files.set('/hello.txt', Buffer.from('external edit'));
    choice = 1;
    await expect(session.recover({ id: record.id, action: 'rollback' })).rejects.toThrow(
      'destination changed',
    );
    await session.recover({ id: record.id, action: 'inspect' });
    expect((await session.recovery())[0].state).toBe('uncertain');
    await session.recover({ id: record.id, action: 'restore-copy' });
    expect(fixture.files.get('/hello.txt')?.toString()).toBe('external edit');
    expect([...fixture.files].find(([p]) => p.includes('(copy '))?.[1].toString()).toBe(original);
  });
  it('refuses corrupted backups and requires confirmation to delete a resolved backup', async () => {
    await connect();
    await upload();
    const [record] = await session.recovery();
    choice = 0;
    await session.recover({ id: record.id, action: 'delete-backup' });
    expect(await session.recovery()).toHaveLength(1);
    await writeFile(store.backup(record.id), 'tampered');
    choice = 1;
    await expect(session.recover({ id: record.id, action: 'rollback' })).rejects.toThrow('SHA-256');
    expect(fixture.files.get('/hello.txt')?.toString()).toBe('replacement');
    await session.recover({ id: record.id, action: 'delete-backup' });
    expect(await session.recovery()).toEqual([]);
  });
  it('retains an uncertain journal after lost replacement acknowledgement and resolves it by inspection only', async () => {
    await fixture.close();
    fixture = await sshFixture({ atomicReplace: true, dropAfterReplace: true });
    await connect();
    await expect(upload()).rejects.toThrow('uncertain');
    expect(fixture.files.get('/hello.txt')?.toString()).toBe('replacement');
    await connect();
    const [record] = await session.recovery();
    expect(record.state).toBe('uncertain');
    await session.recover({ id: record.id, action: 'inspect' });
    expect((await session.recovery())[0].state).toBe('completed');
  });
  it('preserves the original when staging fails, refuses symlinks, and blocks corrupt journals', async () => {
    await fixture.close();
    fixture = await sshFixture({ atomicReplace: true, failWrites: true });
    await connect();
    await expect(upload()).rejects.toThrow();
    expect(fixture.files.get('/hello.txt')?.toString()).toBe(original);
    fixture.symlinks.add('/link');
    await expect(session.transfer('upload', join(directory, 'hello.txt'), '/link')).rejects.toThrow(
      'regular files',
    );
    await writeFile(join(directory, 'backups', 'recovery.json'), 'invalid');
    await expect(upload()).rejects.toThrow('Recovery records');
    expect(fixture.files.get('/hello.txt')?.toString()).toBe(original);
  });
});
