import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectBundle, sha256, withMountedImage } from '../../scripts/check-mac-package.mjs';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
describe('macOS installer validation', () => {
  it('verifies all nested signatures before accepting version metadata', async () => {
    const calls: [string, string[]][] = [];
    await expect(
      inspectBundle(
        '/tmp/SSH Drop.app',
        '0.2.0-alpha.5',
        async (command: string, args: string[]) => {
          calls.push([command, args]);
          if (command.endsWith('codesign')) throw new Error('invalid signature');
          return { stdout: '0.2.0-alpha.5' };
        },
      ),
    ).rejects.toThrow('invalid signature');
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual([
      '--verify',
      '--deep',
      '--strict',
      '--verbose=2',
      '/tmp/SSH Drop.app',
    ]);
  });
  it('rejects the wrong app version even if the bundle has a valid signature', async () => {
    await expect(
      inspectBundle('/tmp/SSHDrop.app', '0.2.0-alpha.5', async () => ({
        stdout: '0.2.0-alpha.2\n',
      })),
    ).rejects.toThrow('version differs');
    await inspectBundle('/tmp/SSHDrop.app', '0.2.0-alpha.5', async () => ({
      stdout: '0.2.0-alpha.5\n',
    }));
  });
  it('detaches images after validation fails and never inspects an image that fails verification', async () => {
    const calls: string[][] = [];
    const command = async (_file: string, args: string[]) => {
      calls.push(args);
      return { stdout: '' };
    };
    await expect(
      withMountedImage(
        '/tmp/image.dmg',
        '/tmp/mounted',
        async () => {
          throw new Error('damaged app');
        },
        command,
      ),
    ).rejects.toThrow('damaged app');
    expect(calls.map((args) => args[0])).toEqual(['verify', 'attach', 'detach']);
    expect(calls[1]).toContain('-readonly');
    let inspected = false;
    await expect(
      withMountedImage(
        '/tmp/image.dmg',
        '/tmp/mounted',
        async () => {
          inspected = true;
        },
        async () => {
          throw new Error('damaged DMG');
        },
      ),
    ).rejects.toThrow('damaged DMG');
    expect(inspected).toBe(false);
  });
  it('tries to detach an attachment with an uncertain result and propagates detach failure', async () => {
    const calls: string[] = [];
    await expect(
      withMountedImage(
        '/tmp/image.dmg',
        '/tmp/mounted',
        async () => {},
        async (_file: string, args: string[]) => {
          calls.push(args[0]);
          if (args[0] === 'attach') throw new Error('lost acknowledgement');
          return { stdout: '' };
        },
      ),
    ).rejects.toThrow('lost acknowledgement');
    expect(calls).toEqual(['verify', 'attach', 'detach']);
    await expect(
      withMountedImage(
        '/tmp/image.dmg',
        '/tmp/mounted',
        async () => {},
        async (_file: string, args: string[]) => {
          if (args[0] === 'detach') throw new Error('detach failed');
          return { stdout: '' };
        },
      ),
    ).rejects.toThrow('detach failed');
  });
  it('streams content hashing so damaged downloads cannot pass a checksum comparison', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sshdrop-hash-'));
    directories.push(directory);
    const file = join(directory, 'image.dmg');
    await writeFile(file, 'abc');
    expect(await sha256(file)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    await writeFile(file, 'abcd');
    expect(await sha256(file)).not.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(await readFile(file, 'utf8')).toBe('abcd');
  });
});
