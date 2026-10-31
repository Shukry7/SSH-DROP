import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const fixtureEnvironment = { ...process.env };
delete fixtureEnvironment.RELEASE_TAG;
describe('version and release tooling', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'sshdrop-version-'));
    await cp(new URL('../../scripts/', import.meta.url), join(directory, 'scripts'), {
      recursive: true,
    });
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({ version: '0.1.0-alpha.1', description: 'SSH workspace' }),
    );
    await writeFile(
      join(directory, 'package-lock.json'),
      JSON.stringify({ version: '0.1.0-alpha.1', packages: { '': { version: '0.1.0-alpha.1' } } }),
    );
    await writeFile(
      join(directory, 'CHANGELOG.md'),
      '# Changelog\n\n## [0.1.0-alpha.1] — Unreleased\n\n- Existing change.\n',
    );
    await writeFile(
      join(directory, 'README.md'),
      '# SSHDrop\n\n**Status: 0.1.0-alpha.1, early preview.**\n',
    );
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const run = (script: string, args: string[] = [], env: NodeJS.ProcessEnv = fixtureEnvironment) =>
    execute(process.execPath, [join(directory, 'scripts', script), ...args], {
      cwd: directory,
      env,
    });
  it('updates the manifest, lockfile, README, and changelog together', async () => {
    await run('bump-version.mjs', ['0.1.0-alpha.2']);
    const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    const lock = JSON.parse(await readFile(join(directory, 'package-lock.json'), 'utf8'));
    expect(pkg.version).toBe('0.1.0-alpha.2');
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[''].version).toBe(pkg.version);
    expect(await readFile(join(directory, 'README.md'), 'utf8')).toContain(
      '**Status: 0.1.0-alpha.2,',
    );
    expect(await readFile(join(directory, 'CHANGELOG.md'), 'utf8')).toContain('- Existing change.');
    expect(await readFile(join(directory, 'CHANGELOG.md'), 'utf8')).toContain('## [0.1.0-alpha.2]');
    await expect(run('check-version.mjs')).resolves.toBeDefined();
  });
  it('rejects a downgrade without modifying the manifest', async () => {
    const previous = await readFile(join(directory, 'package.json'), 'utf8');
    await expect(run('bump-version.mjs', ['0.0.1'])).rejects.toThrow();
    expect(await readFile(join(directory, 'package.json'), 'utf8')).toBe(previous);
  });
  it('generates release notes and hashes the actual artifact bytes', async () => {
    await writeFile(
      join(directory, 'CHANGELOG.md'),
      '# Changelog\n\n## [0.1.0-alpha.1] — 2026-10-30\n\n- Tested release.\n',
    );
    const assets = join(directory, 'release-assets');
    await mkdir(assets);
    await writeFile(join(assets, 'SSHDrop.exe'), 'installer bytes');
    await run('prepare-release.mjs', [], { ...process.env, RELEASE_TAG: 'v0.1.0-alpha.1' });
    expect(await readFile(join(assets, 'SHA256SUMS.txt'), 'utf8')).toContain(
      `${createHash('sha256').update('installer bytes').digest('hex')}  SSHDrop.exe`,
    );
    expect(await readFile(join(assets, 'RELEASE_NOTES.md'), 'utf8')).toContain('- Tested release.');
  });
});
