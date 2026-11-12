import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IdleSettingsStore } from '../../src/main/core/idle-settings';
describe('persistent idle policy', () => {
  let directory: string, file: string, store: IdleSettingsStore;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'sshdrop-idle-'));
    file = join(directory, 'idle-settings.json');
    store = new IdleSettingsStore(file);
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  it('defaults off and atomically saves bounded settings across restarts', async () => {
    expect(await store.read()).toEqual({ minutes: 0, notifications: false });
    await Promise.all([
      store.save({ minutes: 5, notifications: false }, () => {}),
      store.save({ minutes: 10, notifications: true }, () => {}),
    ]);
    expect(await new IdleSettingsStore(file).read()).toEqual({ minutes: 10, notifications: true });
    expect(await readdir(directory)).toEqual(['idle-settings.json']);
  });
  it('preserves corrupt, unsupported and oversized data rather than disabling protection', async () => {
    for (const contents of ['corrupt', '{"version":2}', 'x'.repeat(16385)]) {
      await writeFile(file, contents);
      await expect(store.read()).rejects.toThrow('preserved');
      await expect(store.save({ minutes: 0, notifications: false }, () => {})).rejects.toThrow(
        'preserved',
      );
      expect(await readFile(file, 'utf8')).toBe(contents);
    }
  });
  it('refuses invalid settings and expired approvals before writing', async () => {
    await store.save({ minutes: 10, notifications: false }, () => {});
    const before = await readFile(file, 'utf8');
    let checks = 0;
    await expect(
      store.save({ minutes: 0, notifications: false }, () => {
        if (++checks === 2) throw new Error('expired');
      }),
    ).rejects.toThrow('expired');
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(await readdir(directory)).toEqual(['idle-settings.json']);
    await expect(store.save({ minutes: 1 as 5, notifications: false }, () => {})).rejects.toThrow();
  });
});
