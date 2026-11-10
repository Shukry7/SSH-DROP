import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { inspectBundle, sha256, withMountedImage } from './check-mac-package.mjs';
const execute = promisify(execFile);
assert.equal(process.platform, 'darwin', 'Release inspection requires macOS');
const tags = process.argv.slice(2);
assert.equal(tags.length, 2, 'Pass baseline and suspect tags');
for (const tag of tags)
  assert(/^v\d+\.\d+\.\d+-(?:alpha|beta|rc)\.\d+$/.test(tag), 'Invalid release tag');
const results = [];
for (const tag of tags) {
  const temporary = await mkdtemp(join(tmpdir(), 'sshdrop-release-inspect-'));
  const mountpoint = join(temporary, 'mounted');
  const image = `SSHDrop-${tag.slice(1)}-mac-${process.arch}.dmg`;
  const command = (file, args) => execute(file, args, { timeout: 120000, maxBuffer: 1024 * 1024 });
  try {
    await command('gh', [
      'release',
      'download',
      tag,
      '--repo',
      'Shukry7/SSH-DROP',
      '--pattern',
      image,
      '--pattern',
      'SHA256SUMS.txt',
      '--dir',
      temporary,
    ]);
    const sums = await readFile(join(temporary, 'SHA256SUMS.txt'), 'utf8');
    const line = sums.split(/\r?\n/).find((line) => line.endsWith(`  ${image}`));
    assert(
      line && line.slice(0, 64) === (await sha256(join(temporary, image))),
      'Downloaded release checksum mismatch',
    );
    await mkdir(mountpoint);
    const result = {
      tag,
      architecture: process.arch,
      checksum: 'valid',
      image: 'unchecked',
      signature: 'unchecked',
    };
    try {
      await withMountedImage(join(temporary, image), mountpoint, async (app) => {
        result.image = 'valid';
        try {
          await inspectBundle(app, tag.slice(1));
          result.signature = 'valid';
        } catch (error) {
          result.signature = 'invalid';
          console.log(`${tag} signature/version diagnostic: ${error.message}`);
        }
      });
    } catch (error) {
      result.image = 'invalid or mount/detach failed';
      console.log(`${tag} image diagnostic: ${error.message}`);
    }
    results.push(result);
  } finally {
    const { stdout } = await command('/sbin/mount', []);
    assert(
      !stdout.includes(` on ${mountpoint} (`),
      'Image still mounted; temporary files retained',
    );
    await rm(temporary, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ releaseComparison: results }, null, 2));
