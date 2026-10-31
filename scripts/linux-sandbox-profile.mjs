import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function renderSandboxProfile(binary) {
  const unsafe = ['"', '\\', '*', '?', '[', ']', '{', '}'];
  if (
    typeof binary !== 'string' ||
    !posix.isAbsolute(binary) ||
    Array.from(binary).some(
      (character) =>
        character.charCodeAt(0) < 32 ||
        character.charCodeAt(0) === 127 ||
        unsafe.includes(character),
    )
  )
    throw new Error(
      'Expected one absolute Linux executable path without control characters or AppArmor pattern syntax.',
    );
  return `abi <abi/4.0>,\ninclude <tunables/global>\nprofile sshdrop-ci "${binary}" flags=(unconfined) {\n  userns,\n}\n`;
}

export async function writeSandboxProfile(
  destination,
  getBinary = () => createRequire(import.meta.url)('electron'),
) {
  // Electron's loader may print installer output on a cold npm cache. Use its
  // returned value directly; never interpolate captured stdout into a policy.
  const profile = renderSandboxProfile(getBinary());
  await writeFile(destination, profile, { mode: 0o600 });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv[2])
    throw new Error('Provide a temporary output file for the AppArmor profile.');
  await writeSandboxProfile(process.argv[2]);
}
