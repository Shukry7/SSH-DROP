import { readFile } from 'node:fs/promises';
import { validateMetadata } from './version-policy.mjs';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
const changelog = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
validateMetadata(pkg, lock, changelog, process.env.RELEASE_TAG, readme);
console.log(
  `SSHDrop ${pkg.version}: application metadata, lockfile, changelog, and release tag agree.`,
);
