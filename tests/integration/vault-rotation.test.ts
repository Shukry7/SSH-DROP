import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BackupVault } from '../../src/main/core/backup-vault';
import { RecoveryStore } from '../../src/main/core/recovery-store';
import { backupText, testProtection, testVault } from '../fixtures/backup-vault';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}));

let directory: string;
let store: RecoveryStore;
const identity = {
  host: 'rotation-fixture.example',
  port: 22,
  username: 'tester',
  fingerprint: 'b'.repeat(64),
};
const check = () => {};
const keyPath = () => join(directory, 'vault-key.json');
async function add(text = 'original contents') {
  const bytes = Buffer.from(text);
  const record = await store.create({
    identity,
    direction: 'download',
    local: join(directory, 'source.txt'),
    remote: '/fixture.txt',
    previous: {
      size: bytes.length,
      hash: createHash('sha256').update(bytes).digest('hex'),
      mode: 0o600,
      uid: 1000,
      gid: 1000,
    },
  });
  await store.save(
    record,
    (async function* () {
      yield bytes;
    })(),
    check,
  );
  return record;
}
beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), 'sshdrop-rotation-'));
  store = new RecoveryStore(directory, testVault(directory));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

it('rotates all ciphertext and metadata, retires the old key and permits another rotation', async () => {
  const record = await add();
  const oldKey = await fs.readFile(keyPath());
  const original = await fs.readFile(store.backup(record.id));
  await store.rotateKey(check);
  const newKey = await fs.readFile(keyPath());
  expect(JSON.parse(newKey.toString())).toMatchObject({ version: 2 });
  expect(JSON.parse(newKey.toString()).previous).toBeUndefined();
  expect(newKey).not.toEqual(oldKey);
  expect(await fs.readFile(store.backup(record.id))).not.toEqual(original);
  const reopened = new RecoveryStore(directory, testVault(directory));
  expect(await reopened.list(identity)).toEqual([record]);
  expect(await backupText(reopened.vault, record.id)).toBe('original contents');
  // Possession of the old live key file cannot decrypt newly published contents.
  await fs.writeFile(keyPath(), oldKey);
  await expect(testVault(directory).metadata()).rejects.toThrow();
  await fs.writeFile(keyPath(), newKey);
  await reopened.rotateKey(check);
  expect(await backupText(testVault(directory), record.id)).toBe('original contents');
  expect(await fs.readdir(directory)).not.toContain(expect.stringContaining('rotation.tmp'));
});

it('preserves mixed old/new files after disk failure and resumes with the same new key after reopening', async () => {
  const first = await add('first original');
  const second = await add('second original');
  const realSeal = store.vault.seal.bind(store.vault);
  let count = 0;
  vi.spyOn(store.vault, 'seal').mockImplementation(async (...args) => {
    if (++count === 3) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return realSeal(...args);
  });
  await expect(store.rotateKey(check)).rejects.toThrow('disk full');
  const pending = JSON.parse(await fs.readFile(keyPath(), 'utf8'));
  expect(pending.previous).toBeTruthy();
  const reopened = new RecoveryStore(directory, testVault(directory));
  expect(await reopened.list(identity)).toEqual([first, second]);
  expect(await backupText(reopened.vault, first.id)).toBe('first original');
  expect(await backupText(reopened.vault, second.id)).toBe('second original');
  await reopened.rotateKey(check);
  const final = JSON.parse(await fs.readFile(keyPath(), 'utf8'));
  expect(final.wrapped).toBe(pending.wrapped);
  expect(final.previous).toBeUndefined();
  expect(await reopened.list(identity)).toHaveLength(2);
});

it('keeps both keys when cancellation occurs after publishing rotated ciphertext', async () => {
  const record = await add();
  const original = await fs.readFile(store.backup(record.id));
  const rename = fs.rename;
  let abort = false;
  vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
    await rename(...args);
    if (String(args[0]).endsWith('.rotation.tmp')) abort = true;
  });
  await expect(
    store.rotateKey(() => {
      if (abort) throw new Error('cancelled');
    }),
  ).rejects.toThrow('cancelled');
  expect(JSON.parse(await fs.readFile(keyPath(), 'utf8')).previous).toBeTruthy();
  expect(await store.list(identity)).toEqual([record]);
  expect(await backupText(store.vault, record.id)).toBe('original contents');
  abort = false;
  vi.restoreAllMocks();
  await store.rotateKey(check);
  expect(await fs.readFile(store.backup(record.id))).not.toEqual(original);
});

it.each(['initial envelope', 'retirement envelope'])(
  'preserves readable files when the %s rename reports failure after committing',
  async (phase) => {
    const record = await add();
    const rename = fs.rename;
    let count = 0;
    vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
      await rename(...args);
      if (String(args[1]) === keyPath() && ++count === (phase === 'initial envelope' ? 1 : 2))
        throw new Error('uncertain key commit');
    });
    await expect(store.rotateKey(check)).rejects.toThrow('uncertain key commit');
    const reopened = new RecoveryStore(directory, testVault(directory));
    expect(await reopened.list(identity)).toEqual([record]);
    expect(await backupText(reopened.vault, record.id)).toBe('original contents');
    vi.restoreAllMocks();
    await reopened.rotateKey(check);
    expect(JSON.parse(await fs.readFile(keyPath(), 'utf8')).previous).toBeUndefined();
  },
);

it.each(['corruption', 'unreferenced file', 'low space', 'locked provider', 'cancelled'])(
  'refuses %s before changing the existing key',
  async (kind) => {
    const record = await add();
    const key = await fs.readFile(keyPath());
    if (kind === 'corruption') {
      const path = store.backup(record.id);
      const bytes = await fs.readFile(path);
      bytes[25] ^= 1;
      await fs.writeFile(path, bytes);
    }
    if (kind === 'unreferenced file')
      await fs.writeFile(join(directory, 'unreferenced.enc'), 'preserve');
    if (kind === 'low space')
      vi.spyOn(fs, 'statfs').mockResolvedValue({ bavail: 0, bsize: 4096 } as Awaited<
        ReturnType<typeof fs.statfs>
      >);
    if (kind === 'locked provider')
      store = new RecoveryStore(
        directory,
        new BackupVault(directory, { ...testProtection, available: async () => false }),
      );
    await expect(
      store.rotateKey(() => {
        if (kind === 'cancelled') throw new Error('cancelled');
      }),
    ).rejects.toThrow();
    expect(await fs.readFile(keyPath())).toEqual(key);
  },
);

it('does not retire the previous key when a published rotated file fails final verification', async () => {
  const record = await add();
  const rename = fs.rename;
  vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
    await rename(...args);
    if (String(args[0]).endsWith('.rotation.tmp') && String(args[1]) === store.backup(record.id)) {
      const bytes = await fs.readFile(args[1]);
      bytes[25] ^= 1;
      await fs.writeFile(args[1], bytes);
    }
  });
  await expect(store.rotateKey(check)).rejects.toThrow();
  expect(JSON.parse(await fs.readFile(keyPath(), 'utf8')).previous).toBeTruthy();
  expect(await store.list(identity)).toEqual([record]);
});

it('preserves the original key when the replacement key cannot be wrapped and verified', async () => {
  const record = await add();
  const key = await fs.readFile(keyPath());
  const broken = new RecoveryStore(
    directory,
    new BackupVault(directory, {
      ...testProtection,
      wrap: async () => Buffer.from('invalid wrapped key'),
    }),
  );
  await expect(broken.rotateKey(check)).rejects.toThrow();
  expect(await fs.readFile(keyPath())).toEqual(key);
  expect(await backupText(store.vault, record.id)).toBe('original contents');
});

it('refuses an oversized OS envelope before publishing an unreadable key file', async () => {
  const record = await add();
  const key = await fs.readFile(keyPath());
  const protection = {
    ...testProtection,
    wrap: async (value: string) => Buffer.from(value + 'x'.repeat(20000)),
    unwrap: async (value: Buffer) =>
      value.length > 20000 ? value.toString().slice(0, 64) : testProtection.unwrap(value),
  };
  const broken = new RecoveryStore(directory, new BackupVault(directory, protection));
  await expect(broken.rotateKey(check)).rejects.toThrow();
  expect(await fs.readFile(keyPath())).toEqual(key);
  expect(await backupText(store.vault, record.id)).toBe('original contents');
});
