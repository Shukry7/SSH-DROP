import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const run = async (file, args) => {
  const { stdout } = await execute(file, args, { timeout: 120000, maxBuffer: 1024 * 1024 });
  return { stdout };
};
export async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function inspectBundle(app, expectedVersion, command = run) {
  await command('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  const { stdout } = await command('/usr/libexec/PlistBuddy', [
    '-c',
    'Print :CFBundleShortVersionString',
    join(app, 'Contents', 'Info.plist'),
  ]);
  assert.equal(stdout.trim(), expectedVersion, 'DMG application version differs from source');
}

// Always detach a mounted image, including signature/version/ASAR/startup failures.
export async function withMountedImage(image, mountpoint, operation, command = run) {
  await command('/usr/bin/hdiutil', ['verify', image]);
  let attached = false;
  try {
    // hdiutil attachment can succeed even when the caller loses the response.
    attached = true;
    await command('/usr/bin/hdiutil', [
      'attach',
      image,
      '-readonly',
      '-nobrowse',
      '-noautoopen',
      '-mountpoint',
      mountpoint,
    ]);
    await operation(join(mountpoint, 'SSHDrop.app'));
  } finally {
    if (attached) await command('/usr/bin/hdiutil', ['detach', mountpoint]);
  }
}

async function smoke(app, directory) {
  const profile = join(directory, 'user-data');
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.NODE_OPTIONS;
  const child = spawn(join(app, 'Contents', 'MacOS', 'SSHDrop'), [`--user-data-dir=${profile}`], {
    env: environment,
    stdio: 'ignore',
  });
  let failure;
  child.once('error', (error) => {
    failure = error;
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 8000));
    if (failure) throw failure;
    assert(
      child.exitCode === null && child.signalCode === null,
      'Packaged application exited during startup',
    );
  } finally {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const closed = new Promise((resolve) => child.once('close', resolve));
      child.kill('SIGTERM');
      let timer;
      await Promise.race([
        closed,
        new Promise((resolve) => {
          timer = setTimeout(() => {
            child.kill('SIGKILL');
            resolve();
          }, 5000);
        }),
      ]);
      clearTimeout(timer);
    }
  }
}

export async function verifyMacPackages(directory = 'dist') {
  assert.equal(process.platform, 'darwin', 'Mac package verification must run on macOS');
  const metadata = JSON.parse(await readFile('package.json', 'utf8'));
  const expected = new Set(['arm64', 'x64']);
  const files = (await readdir(directory))
    .filter((file) => file.startsWith(`SSHDrop-${metadata.version}-mac-`) && file.endsWith('.dmg'))
    .sort();
  assert.equal(files.length, 2, 'Both Intel and Apple Silicon DMGs must be verified');
  for (const file of files) {
    const arch = file.slice(`SSHDrop-${metadata.version}-mac-`.length, -4);
    assert(expected.delete(arch), 'Unexpected or duplicate Mac architecture');
    const temporary = await mkdtemp(join(tmpdir(), 'sshdrop-dmg-check-'));
    const mountpoint = join(temporary, 'mounted');
    await mkdir(mountpoint);
    try {
      await withMountedImage(resolve(directory, file), mountpoint, async (app) => {
        await inspectBundle(app, metadata.version);
        const unpacked = join(directory, arch === 'arm64' ? 'mac-arm64' : 'mac', 'SSHDrop.app');
        const archive = ['Contents', 'Resources', 'app.asar'];
        assert(
          (await stat(join(app, ...archive))).isFile(),
          'Mounted bundle must contain app.asar',
        );
        assert.equal(
          await sha256(join(app, ...archive)),
          await sha256(join(unpacked, ...archive)),
          'DMG ASAR differs from verified unpacked build',
        );
        // Launch a copy as a user would, preserving symlinks and signatures. No quarantine bypass.
        // Only the host architecture can be required without installing Rosetta.
        if (arch === process.arch) {
          const copied = join(temporary, 'SSHDrop.app');
          await cp(app, copied, { recursive: true, verbatimSymlinks: true });
          await inspectBundle(copied, metadata.version);
          await smoke(copied, temporary);
          console.log(`Verified packaged startup: ${basename(file)}`);
        } else
          console.log(
            `Signature/DMG verified for ${arch}; startup requires a ${arch} test device.`,
          );
      });
      console.log(`Verified image integrity, signature, version and ASAR: ${file}`);
    } finally {
      // Never recursively remove a potentially still-mounted image after detach failure.
      const { stdout } = await run('/sbin/mount', []);
      assert(
        !stdout.includes(` on ${mountpoint} (`),
        'Image is still mounted; temporary directory retained',
      );
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await verifyMacPackages();
}
