import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProfileStore } from '../../src/main/core/profiles';
import { profileInputSchema } from '../../src/shared/validation';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const details = {
  name: 'Development',
  host: 'server.example.com',
  port: 2222,
  username: 'deploy',
  auth: 'password' as const,
  startingDirectory: '/home/deploy',
};

describe('saved server profiles', () => {
  let directory: string;
  let file: string;
  let store: ProfileStore;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'sshdrop-profiles-'));
    file = join(directory, 'data', 'profiles.json');
    store = new ProfileStore(file);
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('starts empty and persists normalized non-secret details across instances', async () => {
    expect(await store.list()).toEqual([]);
    const saved = await store.save({
      ...details,
      name: ' Development ',
      host: ' server.example.com ',
    });
    expect(saved).toEqual({ ...details, id: expect.any(String) });
    expect(await new ProfileStore(file).list()).toEqual([saved]);
    expect(await store.load(saved.id)).toEqual({ profile: saved, keyPath: undefined });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, profiles: [saved] });
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(directory, 'data'))).toEqual(['profiles.json']);
  });

  it('stores only a key location, exposes its basename, and supports changing authentication', async () => {
    const keyPath = join(directory, 'identity');
    await writeFile(keyPath, 'PRIVATE KEY CONTENT');
    const saved = await store.save({ ...details, auth: 'key', keyPath });
    expect(saved).toEqual({ ...details, auth: 'key', id: expect.any(String), keyName: 'identity' });
    expect(await store.load(saved.id)).toEqual({ profile: saved, keyPath });
    expect(await readFile(file, 'utf8')).not.toContain('PRIVATE KEY CONTENT');
    const updated = await store.save({ ...details, id: saved.id, name: 'Renamed' });
    expect(updated).not.toHaveProperty('keyName');
    expect(await readFile(file, 'utf8')).not.toContain(keyPath.replaceAll('\\', '\\\\'));
    expect(await store.list()).toEqual([updated]);
  });

  it('updates the chosen profile and deletes only that profile, keeping the private key', async () => {
    const first = await store.save(details);
    const keyPath = join(directory, 'key');
    await writeFile(keyPath, 'keep this key');
    const second = await store.save({ ...details, name: 'Second', auth: 'key', keyPath });
    await store.save({ ...details, id: first.id, host: 'new.example.com' });
    await store.delete(second.id);
    expect(await store.list()).toEqual([{ ...first, host: 'new.example.com' }]);
    expect(await readFile(keyPath, 'utf8')).toBe('keep this key');
  });

  it('rejects duplicate names without modifying existing data and recovers after errors', async () => {
    const saved = await store.save(details);
    const before = await readFile(file, 'utf8');
    await expect(store.save({ ...details, name: 'DEVELOPMENT' })).rejects.toThrow('already exists');
    expect(await readFile(file, 'utf8')).toBe(before);
    await store.save({ ...details, id: saved.id, name: 'DEVELOPMENT' });
    expect((await store.list())[0].name).toBe('DEVELOPMENT');
  });

  it('serializes simultaneous writes, updates, and reads without losing profiles', async () => {
    const saved = await Promise.all(
      Array.from({ length: 8 }, (_, i) => store.save({ ...details, name: `Server ${i}` })),
    );
    expect(await store.list()).toEqual(saved);
    await Promise.all([
      store.delete(saved[0].id),
      store.save({ ...details, id: saved[1].id, name: 'Updated' }),
    ]);
    expect(await store.list()).toHaveLength(7);
    expect((await store.load(saved[1].id)).profile.name).toBe('Updated');
  });

  it('refuses missing profile IDs instead of silently adding or deleting records', async () => {
    for (const operation of [
      () => store.load(randomUUID()),
      () => store.delete(randomUUID()),
      () => store.save({ ...details, id: randomUUID() }),
    ])
      await expect(operation()).rejects.toThrow('no longer exists');
    await expect(store.load('../other-file')).rejects.toThrow();
    await expect(store.delete('../other-file')).rejects.toThrow();
    expect(await store.list()).toEqual([]);
  });

  it.each([
    { password: 'secret' },
    { passphrase: 'secret' },
    { privateKey: 'secret' },
    { keyId: randomUUID() },
    { keyPath: '/unexpected/key' },
    { auth: 'key' },
    { auth: 'key', keyPath: 'relative/key' },
    { auth: 'key', keyPath: '/key\nfile' },
    { name: '' },
    { name: 'bad\u0000name' },
    { host: 'https://example.com' },
    { port: 65536 },
    { startingDirectory: 'relative' },
    { startingDirectory: '/bad\npath' },
    { id: 'not-a-uuid' },
  ])('rejects invalid or secret-bearing stored input %#', async (invalid) => {
    await expect(store.save({ ...details, ...invalid })).rejects.toThrow();
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    'not JSON',
    '{"version":2,"profiles":[]}',
    '{"version":1,"profiles":[{"password":"secret"}]}',
  ])('preserves corrupt or unsupported files %#', async (contents) => {
    await mkdir(join(directory, 'data'));
    await writeFile(file, contents);
    await expect(store.list()).rejects.toThrow('could not be read');
    await expect(store.save(details)).rejects.toThrow('could not be read');
    expect(await readFile(file, 'utf8')).toBe(contents);
  });

  it('rejects duplicate IDs and names in files instead of loading ambiguous records', async () => {
    const saved = await store.save(details);
    await writeFile(file, JSON.stringify({ version: 1, profiles: [saved, saved] }));
    await expect(store.list()).rejects.toThrow('could not be read');
  });

  it('bounds file size and the number of saved profiles', async () => {
    const profiles = Array.from({ length: 100 }, (_, i) => ({
      ...details,
      id: randomUUID(),
      name: `Server ${i}`,
    }));
    await mkdir(join(directory, 'data'));
    await writeFile(file, JSON.stringify({ version: 1, profiles }));
    await expect(store.save(details)).rejects.toThrow('100 server profiles');
    await writeFile(file, ' '.repeat(1024 * 1024 + 1));
    await expect(store.list()).rejects.toThrow('could not be read');
  });

  it('refuses oversized UTF-8 writes without making previously readable profiles unreadable', async () => {
    const profiles = Array.from({ length: 86 }, (_, i) => ({
      ...details,
      id: randomUUID(),
      name: `Server ${i}`,
      startingDirectory: '/' + '界'.repeat(3900),
    }));
    const contents = JSON.stringify({ version: 1, profiles });
    expect(Buffer.byteLength(contents, 'utf8')).toBeLessThan(1024 * 1024);
    await mkdir(join(directory, 'data'));
    await writeFile(file, contents);
    await expect(
      store.save({
        ...details,
        name: 'Large key profile',
        auth: 'key',
        keyPath: join(directory, '界'.repeat(3900)),
        startingDirectory: '/' + '界'.repeat(3900),
      }),
    ).rejects.toThrow('storage limit');
    expect(await readFile(file, 'utf8')).toBe(contents);
    expect(await store.list()).toHaveLength(86);
  });

  it('reports inaccessible or non-file storage without overwriting it', async () => {
    await mkdir(file, { recursive: true });
    await expect(store.save(details)).rejects.toThrow('could not be read');
    expect((await stat(file)).isDirectory()).toBe(true);
  });

  it('reports write failures and can be used again after the storage is repaired', async () => {
    // An intermediate component is a file, so this cannot depend on Unix permissions or root status.
    const blocker = join(directory, 'blocker');
    await writeFile(blocker, 'keep');
    const blocked = new ProfileStore(join(blocker, 'data', 'profiles.json'));
    await expect(blocked.save(details)).rejects.toThrow();
    expect(await readFile(blocker, 'utf8')).toBe('keep');
    await rm(blocker);
    expect(await blocked.save(details)).toMatchObject(details);
  });

  it('preserves previous records and removes temporary files when atomic replacement fails', async () => {
    const saved = await store.save(details);
    const before = await readFile(file, 'utf8');
    vi.mocked(rename).mockRejectedValueOnce(new Error('Simulated disk failure'));
    await expect(store.save({ ...details, id: saved.id, name: 'Changed' })).rejects.toThrow(
      'could not be written',
    );
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(await readdir(join(directory, 'data'))).toEqual(['profiles.json']);
    expect(await store.save({ ...details, id: saved.id, name: 'Changed' })).toMatchObject({
      name: 'Changed',
    });
  });
});

describe('profile IPC validation', () => {
  it('accepts secret-free details and native key handles', () => {
    expect(profileInputSchema.parse(details)).toEqual(details);
    expect(
      profileInputSchema.parse({ ...details, auth: 'key', keyId: randomUUID() }),
    ).toMatchObject({ auth: 'key' });
  });
  it.each([
    { password: 'secret' },
    { passphrase: 'secret' },
    { keyPath: '/arbitrary/file' },
    { auth: 'key' },
    { keyId: randomUUID() },
    { id: '../file' },
  ])('rejects secrets, arbitrary paths, missing keys, and malformed IDs %#', (invalid) => {
    expect(() => profileInputSchema.parse({ ...details, ...invalid })).toThrow();
  });
});
