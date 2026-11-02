import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackupVault } from '../../src/main/core/backup-vault';
import { RecoveryStore } from '../../src/main/core/recovery-store';
import { replacementIO } from '../../src/main/core/replacement-io';
import { osKeyProtection } from '../../src/main/core/os-key-protection';
import { testProtection, testVault, backupText } from '../fixtures/backup-vault';

const source = async function* (value: Buffer) {
  for (let p = 0; p < value.length; p += 65536) yield value.subarray(p, p + 65536);
};
const identity = {
  host: 'private-server.example',
  port: 22,
  username: 'private-user',
  fingerprint: 'a'.repeat(64),
};
describe('authenticated encrypted recovery vault', () => {
  let directory: string;
  let vault: BackupVault;
  let store: RecoveryStore;
  const data = Buffer.from('private original contents');
  const previous = {
    size: data.length,
    hash: createHash('sha256').update(data).digest('hex'),
    mode: 0o600,
    uid: 1000,
    gid: 1000,
  };
  const io = () =>
    replacementIO(
      undefined,
      new AbortController().signal,
      () => true,
      () => undefined,
    );
  const input = () => ({
    identity,
    direction: 'upload' as const,
    local: join(directory, 'private-path'),
    remote: '/private-path',
    previous,
  });
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'sshdrop-vault-'));
    vault = testVault(directory);
    store = new RecoveryStore(directory, vault);
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  it('encrypts metadata and streamed bytes independently and survives reopening', async () => {
    const record = await store.create(input());
    await store.save(record, source(data), () => undefined);
    expect(await backupText(testVault(directory), record.id)).toBe(data.toString());
    const ciphertext = await readFile(store.backup(record.id));
    expect(ciphertext.includes(data)).toBe(false);
    expect(
      (await readFile(join(directory, 'recovery.enc'))).includes(Buffer.from(identity.host)),
    ).toBe(false);
    expect((await readFile(join(directory, 'vault-key.json'))).includes(data)).toBe(false);
    expect(
      (await new RecoveryStore(directory, testVault(directory)).load(record.id, identity))
        .encrypted,
    ).toBe(true);
    expect((await readdir(directory)).sort()).toEqual(
      [`${record.id}.bak.enc`, 'recovery.enc', 'recovery.json', 'vault-key.json'].sort(),
    );
    await expect(vault.seal(`${record.id}.bak.enc`, source(data))).rejects.toMatchObject({
      code: 'EEXIST',
    });
  });
  it('uses unique nonces and binds ciphertext to the record identity and purpose', async () => {
    const first = await store.create(input());
    const second = await store.create(input());
    await store.save(first, source(data), () => undefined);
    await store.save(second, source(data), () => undefined);
    const a = await readFile(store.backup(first.id));
    const b = await readFile(store.backup(second.id));
    expect(a).not.toEqual(b);
    await writeFile(store.backup(second.id), a);
    await expect(store.verify(second)).rejects.toThrow('authentication');
    await writeFile(join(directory, 'recovery.enc'), a);
    await expect(store.list(identity)).rejects.toThrow('preserved');
  });
  it.each(['header', 'contents', 'tag', 'truncated', 'extra'] as const)(
    'blocks %s corruption without publishing decrypted data',
    async (kind) => {
      const record = await store.create(input());
      await store.save(record, source(data), () => undefined);
      const original = await readFile(store.backup(record.id));
      const changed = Buffer.from(original);
      changed[kind === 'header' ? 0 : kind === 'contents' ? 22 : changed.length - 1] ^= 1;
      await writeFile(
        store.backup(record.id),
        kind === 'truncated'
          ? original.subarray(0, -5)
          : kind === 'extra'
            ? Buffer.concat([original, Buffer.from('x')])
            : changed,
      );
      const destination = join(directory, 'restored');
      await expect(
        io().write(
          destination,
          store.contents(record, () => undefined),
          previous,
        ),
      ).rejects.toThrow();
      await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await readdir(directory)).some((name) => name.endsWith('.part'))).toBe(false);
      expect(await readFile(store.backup(record.id))).not.toEqual(Buffer.alloc(0));
    },
  );
  it('handles empty and multi-chunk files without plaintext backup staging', async () => {
    for (const content of [Buffer.alloc(0), Buffer.alloc(200000, 83)]) {
      const snapshot = {
        ...previous,
        size: content.length,
        hash: createHash('sha256').update(content).digest('hex'),
      };
      const record = await store.create({ ...input(), previous: snapshot });
      await store.save(record, source(content), () => undefined);
      const destination = join(directory, randomUUID());
      await io().write(
        destination,
        store.contents(record, () => undefined),
        snapshot,
      );
      expect(await readFile(destination)).toEqual(content);
      await expect(
        io().write(
          destination,
          store.contents(record, () => undefined),
          snapshot,
        ),
      ).rejects.toThrow('publication is uncertain');
      expect(await readFile(destination)).toEqual(content);
    }
  });
  it('preserves interrupted encryption, rejects the partial output and keeps the original', async () => {
    const record = await store.create(input());
    const broken = async function* () {
      yield data.subarray(0, 5);
      throw new Error('connection cut');
    };
    await expect(store.save(record, broken(), () => undefined)).rejects.toThrow('connection cut');
    await expect(store.verify(record)).rejects.toThrow('preserved');
    expect((await store.load(record.id, identity)).state).toBe('preparing');
    const controller = new AbortController();
    controller.abort();
    await expect(
      vault.seal(`${randomUUID()}.bak.enc`, source(data), () => controller.signal.throwIfAborted()),
    ).rejects.toThrow();
  });
  it('fails closed when OS storage is locked, a key is lost/corrupt, or unwrap fails', async () => {
    const record = await store.create(input());
    await store.save(record, source(data), () => undefined);
    const metadata = await readFile(join(directory, 'recovery.enc'));
    const locked = new BackupVault(directory, { ...testProtection, available: async () => false });
    await expect(locked.metadata()).rejects.toThrow('locked');
    await expect(new RecoveryStore(directory, locked).create(input())).rejects.toThrow('preserved');
    await expect(
      new BackupVault(directory, {
        ...testProtection,
        unwrap: async () => {
          throw new Error('locked');
        },
      }).metadata(),
    ).rejects.toThrow('locked');
    const keyPath = join(directory, 'vault-key.json');
    await writeFile(keyPath, '{broken');
    await expect(vault.metadata()).rejects.toThrow('locked');
    expect(await readFile(keyPath, 'utf8')).toBe('{broken');
    await unlink(keyPath);
    await expect(vault.writeMetadata('{}')).rejects.toThrow('locked');
    await expect(readFile(keyPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(directory, 'recovery.enc'))).toEqual(metadata);
  });
  it('does not create plaintext files or a key when secure storage is unavailable', async () => {
    store = new RecoveryStore(
      directory,
      new BackupVault(directory, { ...testProtection, available: async () => false }),
    );
    await expect(store.create(input())).rejects.toThrow('locked');
    expect(await readdir(directory)).toEqual([]);
  });
  it('migrates a legacy backup only after verified encryption and preserves all other server records', async () => {
    const legacy = {
      ...input(),
      id: randomUUID(),
      created: new Date().toISOString(),
      state: 'completed',
    };
    const other = {
      ...legacy,
      id: randomUUID(),
      identity: { ...identity, host: 'another-server' },
    };
    await writeFile(
      join(directory, 'recovery.json'),
      JSON.stringify({ version: 1, records: [legacy, other] }),
      { mode: 0o600 },
    );
    await writeFile(join(directory, `${legacy.id}.bak`), data, { mode: 0o600 });
    await writeFile(join(directory, `${other.id}.bak`), data, { mode: 0o600 });
    const [record] = await store.list(identity);
    expect(record.encrypted).toBeUndefined();
    await expect(store.verify(record)).rejects.toThrow();
    await store.encryptLegacy(
      record,
      io().read(join(directory, `${record.id}.bak`)),
      () => undefined,
    );
    await expect(readFile(join(directory, `${record.id}.bak`))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(JSON.parse(await readFile(join(directory, 'recovery.json'), 'utf8'))).toEqual({
      version: 2,
      encrypted: true,
    });
    expect(await backupText(vault, record.id)).toBe(data.toString());
    expect(await readFile(join(directory, `${other.id}.bak`))).toEqual(data);
    expect((await store.list(other.identity))[0].encrypted).toBeUndefined();
    // A crash after committing encrypted metadata but before cleanup is safe to retry.
    await writeFile(join(directory, `${record.id}.bak`), data, { mode: 0o600 });
    await store.encryptLegacy(
      await store.load(record.id, identity),
      io().read('not-used'),
      () => undefined,
    );
    await expect(readFile(join(directory, `${record.id}.bak`))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('retains plaintext originals on failed migration and supports an explicit retry', async () => {
    const legacy = {
      ...input(),
      id: randomUUID(),
      created: new Date().toISOString(),
      state: 'completed' as const,
    };
    const path = join(directory, `${legacy.id}.bak`);
    await writeFile(
      join(directory, 'recovery.json'),
      JSON.stringify({ version: 1, records: [legacy] }),
      { mode: 0o600 },
    );
    await writeFile(path, data, { mode: 0o600 });
    await expect(
      store.encryptLegacy(legacy, source(Buffer.from('tampered')), () => undefined),
    ).rejects.toThrow();
    expect(await readFile(path)).toEqual(data);
    expect((await store.load(legacy.id, identity)).encrypted).toBeUndefined();
    await store.encryptLegacy(legacy, io().read(path), () => undefined);
    expect((await store.load(legacy.id, identity)).encrypted).toBe(true);
  });
  it('preserves the original if metadata commit fails after encrypting a legacy backup', async () => {
    const legacy = {
      ...input(),
      id: randomUUID(),
      created: new Date().toISOString(),
      state: 'completed' as const,
    };
    const path = join(directory, `${legacy.id}.bak`);
    await writeFile(
      join(directory, 'recovery.json'),
      JSON.stringify({ version: 1, records: [legacy] }),
      { mode: 0o600 },
    );
    await writeFile(path, data, { mode: 0o600 });
    vi.spyOn(vault, 'writeMetadata').mockRejectedValueOnce(new Error('disk full'));
    await expect(store.encryptLegacy(legacy, io().read(path), () => undefined)).rejects.toThrow(
      'disk full',
    );
    expect(await readFile(path)).toEqual(data);
    expect((await store.load(legacy.id, identity)).encrypted).toBeUndefined();
    await store.encryptLegacy(legacy, io().read(path), () => undefined);
    expect(await backupText(vault, legacy.id)).toBe(data.toString());
  });
  it('rejects nonregular vault keys', async () => {
    await mkdir(join(directory, 'vault-key.json'));
    await expect(vault.writeMetadata('{}')).rejects.toThrow('locked');
  });
  it.skipIf(process.platform === 'win32')(
    'rejects exposed keys and backup ciphertext files',
    async () => {
      const record = await store.create(input());
      await store.save(record, source(data), () => undefined);
      await chmod(store.backup(record.id), 0o644);
      await expect(store.verify(record)).rejects.toThrow();
      await chmod(join(directory, 'vault-key.json'), 0o644);
      await expect(vault.metadata()).rejects.toThrow('locked');
    },
  );
});

describe('OS provider selection', () => {
  const storage = (backend = 'gnome_libsecret') => ({
    isEncryptionAvailable: vi.fn(() => true),
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    getSelectedStorageBackend: vi.fn(() => backend),
    encryptString: vi.fn((s: string) => Buffer.from(s)),
    decryptString: vi.fn((b: Buffer) => b.toString()),
    encryptStringAsync: vi.fn(async (s: string) => Buffer.from(s)),
    decryptStringAsync: vi.fn(async (b: Buffer) => ({
      result: b.toString(),
      shouldReEncrypt: false,
    })),
  });
  it.each(['basic_text', 'unknown', 'unrecognized'])(
    'refuses Linux backend %s without invoking encryption',
    async (backend) => {
      const api = storage(backend);
      const provider = osKeyProtection(api, 'linux');
      expect(await provider.available()).toBe(false);
      await expect(provider.wrap('value')).rejects.toThrow('unavailable');
      await expect(provider.unwrap(Buffer.from('value'))).rejects.toThrow('unavailable');
      expect(api.encryptString).not.toHaveBeenCalled();
      expect(api.encryptStringAsync).not.toHaveBeenCalled();
    },
  );
  it.each(['win32', 'darwin', 'linux'] as const)(
    'uses the approved provider and returns errors on %s',
    async (platform) => {
      const api = storage();
      const provider = osKeyProtection(api, platform);
      expect(await provider.unwrap(await provider.wrap('value'))).toBe('value');
      if (platform === 'linux') {
        expect(api.encryptString).toHaveBeenCalled();
        expect(api.encryptStringAsync).not.toHaveBeenCalled();
        api.isEncryptionAvailable.mockReturnValue(false);
      } else api.isAsyncEncryptionAvailable.mockResolvedValue(false);
      expect(await provider.available()).toBe(false);
      await expect(provider.wrap('value')).rejects.toThrow('unavailable');
    },
  );
  it('bounds an asynchronous keychain request', async () => {
    vi.useFakeTimers();
    try {
      const api = storage();
      api.encryptStringAsync.mockImplementation(() => new Promise(() => undefined));
      const result = expect(osKeyProtection(api, 'darwin').wrap('value')).rejects.toThrow(
        'timed out',
      );
      await vi.advanceTimersByTimeAsync(30001);
      await result;
    } finally {
      vi.useRealTimers();
    }
  });
});
