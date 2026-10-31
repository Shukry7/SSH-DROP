import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderSandboxProfile } from '../../scripts/linux-sandbox-profile.mjs';

const execute = promisify(execFile);
describe('Linux sandbox profile generation', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'sshdrop-apparmor-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('quotes a single absolute executable attachment, including paths with spaces', () => {
    expect(renderSandboxProfile('/opt/SSH Drop/electron')).toBe(
      'abi <abi/4.0>,\ninclude <tunables/global>\nprofile sshdrop-ci "/opt/SSH Drop/electron" flags=(unconfined) {\n  userns,\n}\n',
    );
  });

  it.each([
    'relative/electron',
    'Downloading Electron binary...\n/opt/electron',
    '/opt/electron\nextra',
    '/opt/"electron',
    '/opt/\\electron',
    '/opt/*/electron',
    '/opt/?/electron',
    '/opt/[ab]/electron',
    '/opt/{a,b}/electron',
    '/opt/\0electron',
  ])('rejects malformed or policy-changing executable path %j', (binary) => {
    expect(() => renderSandboxProfile(binary)).toThrow('absolute Linux executable path');
  });

  it('keeps cold-install loader logs out of the generated profile', async () => {
    const scripts = join(directory, 'scripts');
    const module = join(directory, 'node_modules', 'electron');
    await mkdir(scripts, { recursive: true });
    await mkdir(module, { recursive: true });
    await cp(
      new URL('../../scripts/linux-sandbox-profile.mjs', import.meta.url),
      join(scripts, 'linux-sandbox-profile.mjs'),
    );
    await writeFile(
      join(module, 'index.js'),
      "console.log('Downloading Electron binary...'); module.exports = '/opt/sshdrop/electron';\n",
    );
    const output = join(directory, 'profile');
    const result = await execute(process.execPath, [
      join(scripts, 'linux-sandbox-profile.mjs'),
      output,
    ]);
    expect(result.stdout).toContain('Downloading Electron binary...');
    const profile = await readFile(output, 'utf8');
    expect(profile).toBe(renderSandboxProfile('/opt/sshdrop/electron'));
    expect(profile).not.toContain('Downloading');
  });

  it('does not create a profile when the loader returns an invalid attachment', async () => {
    const scripts = join(directory, 'scripts');
    const module = join(directory, 'node_modules', 'electron');
    await mkdir(scripts, { recursive: true });
    await mkdir(module, { recursive: true });
    await cp(
      new URL('../../scripts/linux-sandbox-profile.mjs', import.meta.url),
      join(scripts, 'linux-sandbox-profile.mjs'),
    );
    await writeFile(join(module, 'index.js'), "module.exports = '/opt/unsafe\\npath';\n");
    const output = join(directory, 'profile');
    await expect(
      execute(process.execPath, [join(scripts, 'linux-sandbox-profile.mjs'), output]),
    ).rejects.toThrow();
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
