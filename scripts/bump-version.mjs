import { readFile, writeFile } from 'node:fs/promises';
import { assertUpgrade } from './version-policy.mjs';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const lock = JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8'));
const next = process.argv[2];
assertUpgrade(pkg.version, next);
const previous = pkg.version;
const readmePath = new URL('README.md', root);
const readme = await readFile(readmePath, 'utf8');
if (!readme.includes(`**Status: ${previous},`))
  throw new Error('README version is out of sync. Fix it before bumping.');
pkg.version = next;
lock.version = next;
lock.packages[''].version = next;
const changelogPath = new URL('CHANGELOG.md', root);
const changelog = await readFile(changelogPath, 'utf8');
if (changelog.includes(`## [${next}]`))
  throw new Error('That version already has a changelog entry.');
const entry = `## [${next}] — Unreleased\n\n### Changed\n\n- Describe user-visible changes before release.\n\n`;
await writeFile(new URL('package.json', root), JSON.stringify(pkg, null, 2) + '\n');
await writeFile(new URL('package-lock.json', root), JSON.stringify(lock, null, 2) + '\n');
await writeFile(changelogPath, changelog.replace(/(?=## \[)/, entry));
await writeFile(readmePath, readme.replace(`**Status: ${previous},`, `**Status: ${next},`));
console.log(`Prepared ${next}. Update CHANGELOG.md, run npm run check, and commit before tagging.`);
