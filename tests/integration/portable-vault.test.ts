import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RecoveryStore, type ServerIdentity } from '../../src/main/core/recovery-store';
import { Replacements } from '../../src/main/core/replacement';
import { replacementIO } from '../../src/main/core/replacement-io';
import { openPortable, sealPortable } from '../../src/main/core/portable-backup';
import { backupText, testVault } from '../fixtures/backup-vault';

let directory: string;
const identity: ServerIdentity = {
  host: 'archive-fixture.example',
  port: 22,
  username: 'tester',
  fingerprint: 'a'.repeat(64),
};
const passphrase = 'disposable archive fixture passphrase';
const check = () => {};
const makeStore = (name: string) => {
  const path = join(directory, name);
  return new RecoveryStore(path, testVault(path));
};
async function add(store: RecoveryStore, text: string, server = identity) {
  const previous = {
    size: Buffer.byteLength(text),
    hash: createHash('sha256').update(text).digest('hex'),
    mode: 0o600,
    uid: 1000,
    gid: 1000,
  };
  const record = await store.create({
    identity: server,
    direction: 'download',
    local: join(directory, text + '.txt'),
    remote: '/' + text + '.txt',
    previous,
  });
  await store.save(
    record,
    (async function* () {
      yield Buffer.from(text);
    })(),
    check,
  );
  return store.update(record.id, server, { state: 'completed', installed: previous });
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'sshdrop-vault-archive-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

it('moves all verified backups across vaults, preserves server identities and skips repeated imports', async () => {
  const source = makeStore('source');
  const target = makeStore('target');
  const first = await add(source, 'first');
  const other = { ...identity, username: 'other-account' };
  const second = await add(source, 'second', other);
  const payload = await source.exportVault(check);
  const expected = {
    size: payload.length,
    hash: createHash('sha256').update(payload).digest('hex'),
  };
  const encrypted = await sealPortable(
    (async function* () {
      yield payload;
    })(),
    expected,
    passphrase,
    check,
    'vault',
  );
  expect(encrypted.includes(Buffer.from(identity.host))).toBe(false);
  expect(encrypted.includes(Buffer.from('first'))).toBe(false);
  const archive = join(directory, 'archive.sshdrop-vault');
  await writeFile(archive, encrypted);
  await expect(openPortable(archive, passphrase, check)).rejects.toThrow('Unsupported');
  await expect(
    openPortable(archive, 'different fixture passphrase', check, 'vault'),
  ).rejects.toThrow('Wrong passphrase');
  await rm(source.directory, { recursive: true, force: true });
  const bytes = await openPortable(archive, passphrase, check, 'vault');
  expect(await target.importVault(bytes, check)).toEqual({ added: 2, skipped: 0 });
  const [imported] = await target.list(identity);
  expect(imported).toMatchObject({ imported: true, sourceId: first.id, identity });
  expect(imported.id).not.toBe(first.id);
  expect(await backupText(target.vault, imported.id)).toBe('first');
  expect((await target.list(other))[0].sourceId).toBe(second.id);
  expect(await target.list({ ...identity, fingerprint: 'b'.repeat(64) })).toEqual([]);
  expect(await target.importVault(bytes, check)).toEqual({ added: 0, skipped: 2 });
  expect(await target.list(identity)).toHaveLength(1);
  const io = replacementIO(undefined, new AbortController().signal, () => true, check);
  const restore = vi.fn(async () => {});
  const replacements = new Replacements({
    store: target,
    identity,
    localIO: io,
    remoteIO: io,
    check,
    transfer: async () => {},
    confirm: async () => 1,
    restoreImported: restore,
  });
  await expect(replacements.recover(imported.id, 'rollback')).rejects.toThrow('restore-copy');
  expect(restore).not.toHaveBeenCalled();
  await replacements.recover(imported.id, 'restore-copy');
  expect(restore).toHaveBeenCalledOnce();
  bytes.fill(0);
});

it('rejects corrupt entries and conflicting duplicates before changing the destination journal', async () => {
  const source = makeStore('source');
  const target = makeStore('target');
  await add(source, 'first');
  await add(target, 'existing');
  const original = await readFile(join(target.directory, 'recovery.enc'));
  await expect(
    target.importVault(Buffer.from('['.repeat(32) + '0' + ']'.repeat(32)), check),
  ).rejects.toThrow('nesting exceeds');
  expect(await readFile(join(target.directory, 'recovery.enc'))).toEqual(original);
  const payload = await source.exportVault(check);
  const invalid = JSON.parse(payload.toString());
  invalid.entries[0].contents = Buffer.from('wrong').toString('base64');
  await expect(target.importVault(Buffer.from(JSON.stringify(invalid)), check)).rejects.toThrow(
    'invalid backup',
  );
  expect(await readFile(join(target.directory, 'recovery.enc'))).toEqual(original);
  await target.importVault(payload, check);
  const conflict = JSON.parse(payload.toString());
  conflict.entries[0].record.identity.username = 'changed';
  await expect(target.importVault(Buffer.from(JSON.stringify(conflict)), check)).rejects.toThrow(
    'conflicts',
  );
  expect(await target.list(identity)).toHaveLength(2);
});

it('cleans staged imports on cancellation and preserves committed backups if metadata writing reports an error', async () => {
  const source = makeStore('source');
  const target = makeStore('target');
  await add(source, 'first');
  const prior = await add(target, 'existing');
  const payload = await source.exportVault(check);
  const write = target.vault.writeMetadata.bind(target.vault);
  const fault = vi
    .spyOn(target.vault, 'writeMetadata')
    .mockImplementation(async (contents, purpose) => {
      await write(contents, purpose);
      throw new Error('Simulated error after metadata commit');
    });
  await expect(target.importVault(payload, check)).rejects.toThrow('after metadata commit');
  fault.mockRestore();
  expect(await backupText(target.vault, prior.id)).toBe('existing');
  expect(await target.importVault(payload, check)).toEqual({ added: 0, skipped: 1 });
  expect(await target.list(identity)).toHaveLength(2);
  expect((await readdir(target.directory)).some((name) => name.startsWith('.vault-import-'))).toBe(
    false,
  );
  const cancelled = makeStore('cancelled');
  await mkdir(cancelled.directory, { mode: 0o700 });
  await expect(
    cancelled.importVault(payload, () => {
      throw new Error('cancelled');
    }),
  ).rejects.toThrow('cancelled');
  expect(await readdir(cancelled.directory)).toEqual([]);
});

it('accepts a foreign OS path as archived metadata and refuses export of missing or legacy contents', async () => {
  const source = makeStore('source');
  const record = await add(source, 'first');
  const payload = JSON.parse((await source.exportVault(check)).toString());
  payload.entries[0].record.local = 'C:\\archive-fixture\\first.txt';
  const target = makeStore('target');
  await target.importVault(Buffer.from(JSON.stringify(payload)), check);
  expect((await target.list(identity))[0].local).toBe('C:\\archive-fixture\\first.txt');
  await writeFile(source.backup(record.id), Buffer.from('damaged'));
  await expect(source.exportVault(check)).rejects.toThrow('verification failed');
});

it('preserves existing backups when import runs out of space during encrypted staging', async () => {
  const source = makeStore('source');
  const target = makeStore('target');
  await add(source, 'first');
  await add(source, 'second');
  const existing = await add(target, 'existing');
  const before = await readFile(join(target.directory, 'recovery.enc'));
  const payload = await source.exportVault(check);
  const seal = target.vault.seal.bind(target.vault);
  let count = 0;
  vi.spyOn(target.vault, 'seal').mockImplementation(async (...args) => {
    if (++count === 2)
      throw Object.assign(new Error('No space left on device'), { code: 'ENOSPC' });
    await seal(...args);
  });
  await expect(target.importVault(payload, check)).rejects.toMatchObject({ code: 'ENOSPC' });
  expect(await readFile(join(target.directory, 'recovery.enc'))).toEqual(before);
  expect(await backupText(target.vault, existing.id)).toBe('existing');
  expect(await target.list(identity)).toHaveLength(1);
  expect((await readdir(target.directory)).filter((name) => name.endsWith('.bak.enc'))).toEqual([
    existing.id + '.bak.enc',
  ]);
});
