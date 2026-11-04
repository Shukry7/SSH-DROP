import { testVault, backupText, testProtection } from '../fixtures/backup-vault';
import { BackupVault } from '../../src/main/core/backup-vault';
import { mkdtemp, readFile, readdir, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Session } from '../../src/main/core/session';
import { RecoveryStore } from '../../src/main/core/recovery-store';
import type { ReplacementApproval } from '../../src/main/core/replacement';
import { sshFixture } from '../fixtures/ssh-server';
import type { TransferUpdate } from '../../src/shared/contracts';

describe('verified overwrite and persistent recovery over SFTP', () => {
  let directory: string;
  let fixture: Awaited<ReturnType<typeof sshFixture>>;
  let session: Session;
  let choice: number;
  let approvals: ReplacementApproval[];
  let confirmHook: (() => void | Promise<void>) | undefined;
  let store: RecoveryStore;
  let observe: ((transfer: TransferUpdate) => void) | undefined;
  const original = 'Hello from the remote server.\n';
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'sshdrop-replace-'));
    choice = 2;
    approvals = [];
    confirmHook = undefined;
    observe = undefined;
    store = new RecoveryStore(join(directory, 'backups'), testVault(join(directory, 'backups')));
    fixture = await sshFixture({ atomicReplace: true });
  });
  async function connect() {
    session = new Session(
      { verify: async () => true },
      (event) => {
        if (event.type === 'transfer') observe?.(event.transfer);
      },
      undefined,
      {
        store,
        confirm: async (approval) => {
          approvals.push(approval);
          await confirmHook?.();
          return choice;
        },
      },
    );
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
  it('allows no-backup replacement when OS key protection is unavailable without opening the vault', async () => {
    let requested = 0;
    const protection = {
      ...testProtection,
      available: async () => {
        requested++;
        return false;
      },
    };
    const root = join(directory, 'backups');
    store = new RecoveryStore(root, new BackupVault(root, protection));
    await connect();
    choice = 3;
    confirmHook = () => {
      if (approvals.at(-1)?.title === 'Replace without recovery backup') choice = 1;
    };
    await upload();
    expect(requested).toBe(0);
    expect(fixture.files.get('/hello.txt')?.toString()).toBe('replacement');
  });
  it('reports an uncertain no-backup outcome after a lost publication acknowledgement without replay', async () => {
    await fixture.close();
    fixture = await sshFixture({ atomicReplace: true, dropAfterReplace: true });
    await connect();
    choice = 3;
    confirmHook = () => {
      if (approvals.at(-1)?.title === 'Replace without recovery backup') choice = 1;
    };
    await expect(upload()).rejects.toThrow('uncertain');
    expect(fixture.files.get('/hello.txt')?.toString()).toBe('replacement');
    await expect(readFile(join(directory, 'backups', 'recovery.enc'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('refuses a no-backup replacement when the approved source changes', async () => {
    await connect();
    choice = 3;
    confirmHook = async () => {
      if (approvals.at(-1)?.title === 'Replace without recovery backup') {
        await writeFile(join(directory, 'hello.txt'), 'changed after approval');
        choice = 1;
      }
    };
    await expect(upload()).rejects.toThrow('source changed');
    expect(fixture.files.get('/hello.txt')?.toString()).toBe(original);
    expect(await session.recovery()).toHaveLength(0);
  });
  it('replaces uploads and downloads without a vault backup or recovery record after explicit permanent approval', async () => {
    await connect();
    choice = 3;
    confirmHook = () => {
      if (approvals.at(-1)?.title === 'Replace without recovery backup') choice = 1;
    };
    await upload();
    expect(fixture.files.get('/hello.txt')?.toString()).toBe('replacement');
    expect(await session.recovery()).toHaveLength(0);
    const local = join(directory, 'no-backup.txt');
    await writeFile(local, 'original local');
    choice = 3;
    await session.transfer('download', local, '/hello.txt');
    expect(await readFile(local, 'utf8')).toBe('replacement');
    expect(await session.recovery()).toHaveLength(0);
    expect((await readdir(directory)).some((n) => n.includes('.original'))).toBe(false);
  });
  it('keeps the original when permanent replacement is cancelled', async () => {
    await connect();
    choice = 3;
    confirmHook = () => {
      if (approvals.at(-1)?.title === 'Replace without recovery backup') choice = 0;
    };
    await upload();
    expect(fixture.files.get('/hello.txt')?.toString()).toBe(original);
    expect(await session.recovery()).toHaveLength(0);
  });
  it('refuses a changed destination after permanent replacement approval without making a backup', async () => {
    await connect();
    choice = 3;
    confirmHook = () => {
      if (approvals.at(-1)?.title === 'Replace without recovery backup') {
        fixture.files.set('/hello.txt', Buffer.from('external writer'));
        choice = 1;
      }
    };
    await expect(upload()).rejects.toThrow('Destination changed');
    expect(fixture.files.get('/hello.txt')?.toString()).toBe('external writer');
    expect(await session.recovery()).toHaveLength(0);
  });
  it('keeps an independent verified backup, persists across reconnect, and rolls back with another backup', async () => {
    await connect();
    await upload();
    expect(fixture.files.get('/hello.txt')?.toString()).toBe('replacement');
    const [record] = await session.recovery();
    expect(record.state).toBe('completed');
    expect(await backupText(store.vault, record.id)).toBe(original);
    expect(approvals[0].detail).toContain('encrypted');
    session.disconnect();
    store = new RecoveryStore(join(directory, 'backups'), testVault(join(directory, 'backups')));
    await connect();
    choice = 1;
    await session.recover({ id: record.id, action: 'rollback' });
    expect(fixture.files.get('/hello.txt')?.toString()).toBe(original);
    const records = await session.recovery();
    expect(records.find((r) => r.id === record.id)?.state).toBe('restored');
    const newer = records.find((r) => r.id !== record.id)!;
    expect(await backupText(store.vault, newer.id)).toBe('replacement');
    expect(await readdir(join(directory, 'backups'))).toHaveLength(5);
    expect([...fixture.files.keys()].some((p) => p.includes('.sshdrop-recovery'))).toBe(false);
  });
  it('replaces local downloads and safely rolls them back', async () => {
    await connect();
    const local = join(directory, "local 'quote' 日本語.txt");
    await writeFile(local, 'local original');
    await session.transfer('download', local, '/hello.txt');
    expect(await readFile(local, 'utf8')).toBe(original);
    const [record] = await session.recovery();
    expect(await backupText(store.vault, record.id)).toBe('local original');
    choice = 1;
    await session.recover({ id: record.id, action: 'rollback' });
    expect(await readFile(local, 'utf8')).toBe('local original');
  });
  it('requires explicit legacy migration and keeps server contents unchanged during migration', async () => {
    await connect();
    await upload();
    const journal = JSON.parse(await store.vault.metadata());
    delete journal.records[0].encrypted;
    const record = journal.records[0];
    await writeFile(join(store.directory, `${record.id}.bak`), original, { mode: 0o600 });
    await unlink(store.backup(record.id));
    await unlink(join(store.directory, 'recovery.enc'));
    await writeFile(join(store.directory, 'recovery.json'), JSON.stringify(journal), {
      mode: 0o600,
    });
    expect((await session.recovery())[0].encrypted).toBe(false);
    choice = 0;
    await session.recover({ id: record.id, action: 'encrypt-backup' });
    expect((await session.recovery())[0].encrypted).toBe(false);
    choice = 1;
    await session.recover({ id: record.id, action: 'encrypt-backup' });
    expect((await session.recovery())[0].encrypted).toBe(true);
    await expect(readFile(join(store.directory, `${record.id}.bak`))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(JSON.parse(await readFile(join(store.directory, 'recovery.json'), 'utf8'))).toEqual({
      version: 2,
      encrypted: true,
    });
    expect(fixture.files.get('/hello.txt')?.toString()).toBe('replacement');
    await session.recover({ id: record.id, action: 'rollback' });
    expect(fixture.files.get('/hello.txt')?.toString()).toBe(original);
  });
  it('rejects timestamp-only edits during confirmation and before rollback', async () => {
    await connect();
    const local = join(directory, 'timestamp.txt');
    await writeFile(local, 'local original');
    const touch = async () => {
      const info = await stat(local);
      await utimes(local, info.atime, new Date(info.mtimeMs + 10000));
    };
    confirmHook = touch;
    await expect(session.transfer('download', local, '/hello.txt')).rejects.toThrow(
      'Destination changed',
    );
    expect(await readFile(local, 'utf8')).toBe('local original');
    confirmHook = undefined;
    await session.transfer('download', local, '/hello.txt');
    const record = (await session.recovery()).find((r) => r.state === 'completed')!;
    await touch();
    choice = 1;
    await expect(session.recover({ id: record.id, action: 'rollback' })).rejects.toThrow(
      'destination changed',
    );
    expect(await readFile(local, 'utf8')).toBe(original);
  });
  it('rechecks its backup immediately before replacing the destination', async () => {
    await connect();
    let corrupted = false;
    observe = () => {
      const stage = [...fixture.files.keys()].find((path) => path.endsWith('.ready'));
      if (!stage || corrupted) return;
      corrupted = true;
      const id = stage.match(/recovery-([a-f0-9-]+)\.ready$/)![1];
      writeFileSync(store.backup(id), 'tampered during staging');
    };
    await expect(upload()).rejects.toThrow('Backup changed before publication');
    expect(corrupted).toBe(true);
    expect(fixture.files.get('/hello.txt')?.toString()).toBe(original);
  });
  it('reports a restored remote copy that no longer matches the recorded backup', async () => {
    await connect();
    await upload();
    const [record] = await session.recovery();
    choice = 1;
    fixture.afterRename = (path) => {
      if (path.includes('(copy ')) fixture.files.set(path, Buffer.from('changed after upload'));
    };
    await expect(session.recover({ id: record.id, action: 'restore-copy' })).rejects.toThrow(
      'Restored copy verification failed',
    );
    expect(fixture.files.get('/hello.txt')?.toString()).toBe('replacement');
    expect(await backupText(store.vault, record.id)).toBe(original);
  });
  it('cancel and keep-both leave the existing destination intact', async () => {
    await connect();
    let lastStatus: TransferUpdate['status'] | undefined;
    observe = (transfer) => {
      lastStatus = transfer.status;
    };
    choice = 0;
    await upload();
    expect(lastStatus).toBe('cancelled');
    expect(await session.recovery()).toEqual([]);
    choice = 1;
    await upload();
    expect(lastStatus).toBe('completed');
    expect(fixture.files.get('/hello.txt')?.toString()).toBe(original);
    expect([...fixture.files].find(([p]) => p.includes('(copy '))?.[1].toString()).toBe(
      'replacement',
    );
    expect(await session.recovery()).toEqual([]);
  });
  it('blocks protected operations when the OS key store locks while preserving unique transfers and Keep both', async () => {
    let available = true;
    store = new RecoveryStore(
      join(directory, 'backups'),
      new BackupVault(join(directory, 'backups'), {
        ...testProtection,
        available: async () => available,
      }),
    );
    await connect();
    await upload();
    const [record] = await session.recovery();
    available = false;
    choice = 1;
    await expect(session.recover({ id: record.id, action: 'restore-copy' })).rejects.toThrow(
      'preserved',
    );
    choice = 2;
    await expect(upload()).rejects.toThrow('preserved');
    expect(fixture.files.get('/hello.txt')?.toString()).toBe('replacement');
    choice = 1;
    await upload();
    await session.transfer('upload', join(directory, 'hello.txt'), '/unique-while-locked.txt');
    expect(fixture.files.get('/unique-while-locked.txt')?.toString()).toBe('replacement');
    expect([...fixture.files.keys()].some((path) => path.includes('(copy '))).toBe(true);
    available = true;
    expect((await session.recovery())[0].id).toBe(record.id);
  });
  it.each(['/folder/spoof\nDestination.txt', '/folder/\u202espoof.txt'])(
    'rejects a misleading path before native confirmation: %j',
    async (remote) => {
      await connect();
      const local = join(directory, 'hello.txt');
      await writeFile(local, 'replacement');
      await expect(session.transfer('upload', local, remote)).rejects.toThrow();
      expect(approvals).toEqual([]);
      expect(fixture.files.has(remote)).toBe(false);
    },
  );
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
    let lastStatus: TransferUpdate['status'] | undefined;
    observe = (transfer) => {
      lastStatus = transfer.status;
    };
    await session.recover({ id: record.id, action: 'delete-backup' });
    expect(lastStatus).toBe('cancelled');
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
    await writeFile(join(directory, 'backups', 'recovery.enc'), 'invalid');
    await expect(upload()).rejects.toThrow('Recovery records');
    expect(fixture.files.get('/hello.txt')?.toString()).toBe(original);
  });
});
