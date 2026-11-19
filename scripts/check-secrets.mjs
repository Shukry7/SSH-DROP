import { execFileSync } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const patterns = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{50,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
];
export function looksSensitive(file, contents) {
  return (
    (/(?:^|\/)(?:profiles\.json|workflows\.json|[^/]+\.sshdrop-(?:backup|vault)|\.sshdrop-portable-[a-f0-9-]+\.part|idle-settings\.json|known-hosts\.json|vault-key\.json|recovery\.(?:json|enc)|transfer-queue\.enc|[a-f0-9-]{36}\.download(?:\.tmp)?\.enc|[a-f0-9-]{36}\.bak(?:\.enc)?|\.env(?:\.[^/]+)?|id_(?:rsa|ed25519|ecdsa))$/.test(
      file,
    ) &&
      !file.endsWith('.env.example')) ||
    patterns.some((pattern) => pattern.test(contents))
  );
}
export async function scanTrackedFiles(root = process.cwd()) {
  const files = execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  })
    .split('\0')
    .filter(Boolean);
  const failures = [];
  for (const file of files) {
    const contents = await readFile(
      new URL(
        file.split('/').map(encodeURIComponent).join('/'),
        pathToFileURL(root.replaceAll('\\', '/') + '/'),
      ),
    );
    if (looksSensitive(file, contents.toString('utf8'))) failures.push(file);
  }
  return failures;
}
if (process.argv[1] && pathToFileURL(await realpath(process.argv[1])).href === import.meta.url) {
  try {
    const files = await scanTrackedFiles();
    if (files.length) {
      console.error(
        `Possible secrets or user data in tracked files:\n${files.join('\n')}\nMatched values are intentionally not printed.`,
      );
      process.exitCode = 1;
    } else
      console.log(
        'Tracked-file secret scan passed. This is a baseline scan, not a guarantee that no secrets exist.',
      );
  } catch {
    console.error('Tracked-file secret scan could not complete.');
    process.exitCode = 1;
  }
}
