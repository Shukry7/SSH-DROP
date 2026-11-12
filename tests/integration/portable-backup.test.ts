import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, readdir, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openPortable, sealPortable, writePortableCopy } from '../../src/main/core/portable-backup';
import { portableBackupLimit } from '../../src/shared/portable-backup';
import { portableExportRequest } from '../../src/shared/validation';

const passphrase = 'fixture example portable passphrase';
const data = Buffer.from('disposable bytes from an earlier backup');
const snapshot = { size: data.length, hash: createHash('sha256').update(data).digest('hex') };
const check = () => {};
const source = async function* () {
  yield Buffer.from(data.subarray(0, 8));
  yield Buffer.from(data.subarray(8));
};

describe('portable encrypted recovery copies', () => {
  let directory: string, userData: string, bundle: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'sshdrop-portable-'));
    userData = join(directory, 'app-data');
    bundle = join(directory, 'backup.sshdrop-backup');
    await mkdir(userData);
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('uses a fresh salt/nonce and restores verified bytes without a vault or connection', async () => {
    const first = await sealPortable(source(), snapshot, passphrase, check);
    const second = await sealPortable(source(), snapshot, passphrase, check);
    expect(first.equals(second)).toBe(false);
    expect(first.includes(data)).toBe(false);
    expect(first.includes(Buffer.from(passphrase))).toBe(false);
    await writePortableCopy(bundle, first, userData, check);
    const recovered = await openPortable(bundle, passphrase, check);
    expect(recovered).toEqual(data);
    const output = join(directory, 'new-copy.txt');
    await writePortableCopy(output, recovered, userData, check);
    expect(await readFile(output)).toEqual(data);
    expect(await readdir(userData)).toEqual([]);
    expect(await readdir(directory)).toHaveLength(3);
  });

  it('refuses wrong passphrases, tampered headers/ciphertext, and truncated copies', async () => {
    const valid = await sealPortable(source(), snapshot, passphrase, check);
    await writeFile(bundle, valid);
    await expect(openPortable(bundle, 'different fixture passphrase', check)).rejects.toThrow(
      'Wrong passphrase or damaged',
    );
    for (const index of [12, valid.length - 17, valid.length - 1]) {
      const changed = Buffer.from(valid);
      changed[index] ^= 1;
      await writeFile(bundle, changed);
      await expect(openPortable(bundle, passphrase, check)).rejects.toThrow(
        'Wrong passphrase or damaged',
      );
    }
    await writeFile(bundle, valid.subarray(0, 20));
    await expect(openPortable(bundle, passphrase, check)).rejects.toThrow('incomplete');
    expect(await readdir(directory)).toHaveLength(2);
  });

  it('refuses mismatched vault bytes and discards an export when its source authentication fails', async () => {
    await expect(
      sealPortable(source(), { ...snapshot, hash: 'a'.repeat(64) }, passphrase, check),
    ).rejects.toThrow('SHA-256');
    const broken = async function* () {
      yield Buffer.from(data);
      throw new Error('original vault authentication failed');
    };
    await expect(sealPortable(broken(), snapshot, passphrase, check)).rejects.toThrow(
      'original vault authentication failed',
    );
    await expect(
      sealPortable(source(), { ...snapshot, size: 1 }, passphrase, check),
    ).rejects.toThrow('size changed');
    await expect(
      sealPortable(source(), { ...snapshot, size: portableBackupLimit + 1 }, passphrase, check),
    ).rejects.toThrow('32 MiB');
    expect(await readdir(directory)).toEqual(['app-data']);
  });

  it('preserves existing destinations and clears only its own stage after a cancelled write', async () => {
    const existing = join(directory, 'existing.txt');
    await writeFile(existing, 'keep');
    await expect(writePortableCopy(existing, data, userData, check)).rejects.toThrow(
      'already exists',
    );
    expect(await readFile(existing, 'utf8')).toBe('keep');
    let checks = 0;
    await expect(
      writePortableCopy(bundle, data, userData, () => {
        if (++checks === 3) throw new Error('expired');
      }),
    ).rejects.toThrow('expired');
    await expect(
      writePortableCopy(join(userData, 'recovery.enc'), data, userData, check),
    ).rejects.toThrow('application data');
    expect(await readdir(directory)).toEqual(['app-data', 'existing.txt']);
  });

  it('rejects oversized inputs, hard links, malformed payloads and invalid format versions before decryption', async () => {
    await writeFile(bundle, Buffer.alloc(100));
    await expect(openPortable(bundle, passphrase, check)).rejects.toThrow('Unsupported');
    const other = join(directory, 'alias.sshdrop-backup');
    await link(bundle, other);
    await expect(openPortable(other, passphrase, check)).rejects.toThrow('single-link');
    await rm(other);
    await truncate(bundle, portableBackupLimit + 1024);
    await expect(openPortable(bundle, passphrase, check)).rejects.toThrow('size limit');
    await expect(openPortable(directory, passphrase, check)).rejects.toThrow('regular');
    expect(
      portableExportRequest.safeParse({
        id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
        passphrase,
        path: bundle,
      }).success,
    ).toBe(false);
  });
});
