import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateMetadata } from './version-policy.mjs';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const changelog = await readFile('CHANGELOG.md', 'utf8');
validateMetadata(pkg, lock, changelog, process.env.RELEASE_TAG);
const directory = 'release-assets';
const files = (await readdir(directory))
  .filter((file) => /\.(exe|dmg|AppImage|deb|blockmap)$/.test(file))
  .sort();
if (!files.length) throw new Error('No release artifacts were downloaded.');
const checksums = [];
for (const file of files) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(join(directory, file))) hash.update(chunk);
  checksums.push(`${hash.digest('hex')}  ${file}`);
}
await writeFile(join(directory, 'SHA256SUMS.txt'), checksums.join('\n') + '\n');
const start = changelog.indexOf(`## [${pkg.version}]`);
const end = changelog.indexOf('\n## [', start + 1);
const entry = changelog.slice(start, end < 0 ? undefined : end);
await writeFile(
  join(directory, 'RELEASE_NOTES.md'),
  `${entry}\n\nThese development artifacts are unsigned. Platform certification and release signing are pending.\n`,
);
