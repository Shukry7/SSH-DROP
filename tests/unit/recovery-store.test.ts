import { testVault } from '../fixtures/backup-vault';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RecoveryStore, type ServerIdentity } from '../../src/main/core/recovery-store';
import { replacementIO, copyLocalBackup } from '../../src/main/core/replacement-io';
import { recoveryActionSchema } from '../../src/shared/validation';

describe('bounded, server-bound recovery storage', () => {
  let directory: string;
  let store: RecoveryStore;
  const identity: ServerIdentity = {
    host: 'example.com',
    port: 22,
    username: 'tester',
    fingerprint: 'a'.repeat(64),
  };
  const previous = {
    size: 4,
    hash: createHash('sha256').update('data').digest('hex'),
    mode: 0o600,
    uid: 1000,
    gid: 1000,
  };
  const input = () => ({
    identity,
    direction: 'upload' as const,
    local: join(directory, 'input'),
    remote: '/data',
    previous,
  });
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'sshdrop-journal-'));
    store = new RecoveryStore(join(directory, 'backups'), testVault(join(directory, 'backups')));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  it('serializes concurrent updates, validates UUIDs, and excludes secrets from records', async () => {
    const records = await Promise.all([store.create(input()), store.create(input())]);
    expect(await store.list(identity)).toHaveLength(2);
    expect(() => store.backup('../private-key')).toThrow();
    const persisted = await store.vault.metadata();
    expect(await readFile(join(directory, 'backups', 'recovery.enc'), 'utf8')).not.toContain(
      identity.host,
    );
    expect(persisted).not.toMatch(/password|passphrase|privateKey|terminal/);
    expect((await store.load(records[0].id, identity)).state).toBe('preparing');
  });
  it.each(['host', 'port', 'username', 'fingerprint'] as const)(
    'binds backups to the exact verified %s',
    async (key) => {
      const record = await store.create(input());
      const other = { ...identity, [key]: key === 'port' ? 2222 : 'other' };
      expect(await store.list(other)).toEqual([]);
      await expect(store.load(record.id, other)).rejects.toThrow('connected server');
      await expect(store.update(record.id, other, { state: 'completed' })).rejects.toThrow(
        'missing',
      );
      await expect(store.remove(record.id, other)).rejects.toThrow();
      expect(await store.list(identity)).toHaveLength(1);
    },
  );
  it('blocks corrupt/version-incompatible/oversize journals without discarding them', async () => {
    await store.create(input());
    const path = join(directory, 'backups', 'recovery.enc');
    for (const contents of [
      'invalid',
      JSON.stringify({ version: 2, records: [] }),
      ' '.repeat(1024 * 1024 + 1),
    ]) {
      await store.vault.writeMetadata(contents);
      const encrypted = await readFile(path);
      await expect(store.create(input())).rejects.toThrow('preserved');
      expect(await readFile(path)).toEqual(encrypted);
    }
  }, 30000);
  it('requires inspection before deletion and never deletes the destination', async () => {
    const record = await store.create(input());
    await writeFile(store.backup(record.id), 'data');
    await writeFile(record.local, 'destination');
    await expect(store.remove(record.id, identity)).rejects.toThrow('Inspect');
    await store.update(record.id, identity, { state: 'not-replaced' });
    await store.remove(record.id, identity);
    expect(await readFile(record.local, 'utf8')).toBe('destination');
    await expect(readFile(store.backup(record.id))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects special permission bits in persisted recovery data', async () => {
    const record = await store.create(input());
    const contents = JSON.stringify({
      version: 1,
      records: [{ ...record, previous: { ...record.previous, mode: 0o4755 } }],
    });
    await store.vault.writeMetadata(contents);
    await expect(store.load(record.id, identity)).rejects.toThrow('unsafe');
    expect(await store.vault.metadata()).toBe(contents);
  });
  it('refuses non-file recovery metadata before opening it', async () => {
    expect(await store.list(identity)).toEqual([]);
    await mkdir(join(directory, 'backups', 'recovery.enc'));
    await expect(store.list(identity)).rejects.toThrow('unsafe');
  });
  it('enforces the byte and record quotas before creating a new operation', async () => {
    await expect(
      store.create({ ...input(), previous: { ...previous, size: 11 * 1024 ** 3 } }),
    ).rejects.toThrow('storage limit');
    const record = await store.create(input());
    await store.vault.writeMetadata(
      JSON.stringify({
        version: 1,
        records: Array.from({ length: 100 }, () => ({ ...record, id: randomUUID() })),
      }),
    );
    await expect(store.create(input())).rejects.toThrow('storage limit');
  });
  it.skipIf(process.platform === 'win32')('rejects permissive recovery files', async () => {
    await store.create(input());
    await chmod(join(directory, 'backups', 'recovery.enc'), 0o644);
    await expect(store.list(identity)).rejects.toThrow('unsafe');
  });
  it('accepts only named recovery actions and opaque UUIDs over IPC', () => {
    expect(recoveryActionSchema.safeParse({ id: randomUUID(), action: 'inspect' }).success).toBe(
      true,
    );
    for (const value of [
      { id: '../file', action: 'rollback' },
      { id: randomUUID(), action: 'shell' },
      { id: randomUUID(), action: 'rollback', local: '/etc/passwd' },
    ])
      expect(recoveryActionSchema.safeParse(value).success).toBe(false);
  });
  it('copies independently, refuses existing backups and rejects local hard links', async () => {
    const source = join(directory, 'source');
    const backup = join(directory, 'backup');
    await writeFile(source, 'data');
    await copyLocalBackup(source, backup);
    await writeFile(source, 'edit');
    expect(await readFile(backup, 'utf8')).toBe('data');
    await expect(copyLocalBackup(source, backup)).rejects.toMatchObject({ code: 'EEXIST' });
    const io = replacementIO(
      undefined,
      new AbortController().signal,
      () => true,
      () => undefined,
    );
    expect((await io.snapshot(backup))?.hash).toBe(previous.hash);
    expect(await io.snapshot(join(directory, 'absent'))).toBeUndefined();
    await link(source, join(directory, 'alias'));
    await expect(io.snapshot(source)).rejects.toThrow('hard links');
    await expect(copyLocalBackup('relative', backup)).rejects.toThrow('absolute');
  });
  it('refuses inspection when cancelled or the connection changed', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      replacementIO(
        undefined,
        controller.signal,
        () => true,
        () => undefined,
      ).snapshot(join(directory, 'source')),
    ).rejects.toThrow();
    await expect(
      replacementIO(
        undefined,
        new AbortController().signal,
        () => false,
        () => undefined,
      ).supports('/file'),
    ).rejects.toThrow('connection changed');
  });
});
