import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { getCurrentFuseWire, FuseV1Options, FuseState } from '@electron/fuses';

const roots = (await readdir('dist', { withFileTypes: true })).filter((entry) =>
  entry.isDirectory(),
);
const binaries = [];
for (const root of roots) {
  const directory = join('dist', root.name);
  if (root.name === 'win-unpacked')
    binaries.push({
      binary: join(directory, 'SSHDrop.exe'),
      asar: join(directory, 'resources', 'app.asar'),
    });
  if (root.name === 'linux-unpacked')
    binaries.push({
      binary: join(directory, 'sshdrop'),
      asar: join(directory, 'resources', 'app.asar'),
    });
  if (root.name === 'mac' || root.name.startsWith('mac-'))
    binaries.push({
      binary: join(directory, 'SSHDrop.app'),
      asar: join(directory, 'SSHDrop.app', 'Contents', 'Resources', 'app.asar'),
    });
}
assert(binaries.length > 0, 'No unpacked application was found to inspect.');
for (const { binary, asar } of binaries) {
  assert((await stat(asar)).isFile(), 'Packaged application must use app.asar.');
  const wire = await getCurrentFuseWire(binary);
  for (const option of [
    FuseV1Options.RunAsNode,
    FuseV1Options.EnableNodeOptionsEnvironmentVariable,
    FuseV1Options.EnableNodeCliInspectArguments,
  ])
    assert.equal(
      wire[option],
      FuseState.DISABLE,
      `Unsafe packaged Electron fuse ${option}: ${binary}`,
    );
  for (const option of [
    FuseV1Options.OnlyLoadAppFromAsar,
    FuseV1Options.EnableEmbeddedAsarIntegrityValidation,
  ])
    assert.equal(
      wire[option],
      FuseState.ENABLE,
      `Missing packaged Electron restriction ${option}: ${binary}`,
    );
  console.log(`Verified packaged security fuses: ${binary}`);
}
