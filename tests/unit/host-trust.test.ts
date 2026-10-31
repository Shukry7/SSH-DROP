import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostTrust } from '../../src/main/core/host-trust';

describe('server host trust', () => {
  let directory: string;
  let file: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'sshdrop-trust-'));
    file = join(directory, 'known-hosts.json');
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  it('requires approval and persists only the public fingerprint', async () => {
    const approve = vi.fn().mockResolvedValue(true);
    const trust = new HostTrust(file, approve);
    expect(await trust.verify('EXAMPLE.com', 22, Buffer.from('public-key'))).toBe(true);
    expect(approve).toHaveBeenCalledWith({
      host: 'EXAMPLE.com',
      port: 22,
      fingerprint: expect.stringMatching(/^SHA256:/),
    });
    expect(
      await new HostTrust(file, approve).verify('example.com', 22, Buffer.from('public-key')),
    ).toBe(true);
    expect(approve).toHaveBeenCalledTimes(1);
    expect(await readFile(file, 'utf8')).not.toContain('public-key');
  });
  it('does not remember a rejected key', async () => {
    expect(
      await new HostTrust(file, async () => false).verify('host', 22, Buffer.from('key')),
    ).toBe(false);
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('blocks changed keys without offering blind replacement', async () => {
    const approve = vi.fn().mockResolvedValue(true);
    const trust = new HostTrust(file, approve);
    await trust.verify('host', 22, Buffer.from('first'));
    await expect(trust.verify('host', 22, Buffer.from('changed'))).rejects.toThrow(
      'host key changed',
    );
    expect(approve).toHaveBeenCalledTimes(1);
  });
  it('keeps different ports independent', async () => {
    const approve = vi.fn().mockResolvedValue(true);
    const trust = new HostTrust(file, approve);
    await trust.verify('host', 22, Buffer.from('first'));
    await trust.verify('host', 2222, Buffer.from('second'));
    expect(approve).toHaveBeenCalledTimes(2);
  });
  it.each(['not json', '{"host":7}'])('fails closed on corrupt trust data %s', async (contents) => {
    await writeFile(file, contents);
    await expect(
      new HostTrust(file, async () => true).verify('host', 22, Buffer.from('key')),
    ).rejects.toThrow('Connection blocked');
  });
  it('does not accept trust when approval fails', async () => {
    await expect(
      new HostTrust(file, async () => {
        throw new Error('closed');
      }).verify('host', 22, Buffer.from('key')),
    ).rejects.toThrow('closed');
  });
});
