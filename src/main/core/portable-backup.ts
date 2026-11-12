import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
} from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { portableBackupLimit } from '../../shared/portable-backup';
import { portablePassphrase } from '../../shared/validation';
import type { FileSnapshot } from './recovery-store';
import { folderName } from './folder-transfer';

// Format 1: magic/version, 16-byte salt, 12-byte nonce, ciphertext, 16-byte tag.
// The fixed header is authenticated. There are no filenames, paths, vault keys or KDF settings.
const magic = Buffer.from('SSHDROP-PB1\0');
const headerSize = magic.length + 16 + 12;
const tagSize = 16;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
type Check = () => void;

async function key(passphrase: string, salt: Buffer) {
  portablePassphrase.parse(passphrase);
  const bytes = Buffer.from(passphrase, 'utf8');
  try {
    if (bytes.toString('utf8') !== passphrase) throw new Error('Invalid passphrase text.');
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(
        bytes,
        salt,
        32,
        { N: 2 ** 17, r: 8, p: 1, maxmem: 192 * 1024 ** 2 },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        },
      );
    });
  } finally {
    bytes.fill(0);
  }
}

export async function sealPortable(
  contents: AsyncIterable<Buffer>,
  expected: Pick<FileSnapshot, 'size' | 'hash'>,
  passphrase: string,
  check: Check,
): Promise<Buffer> {
  if (
    !Number.isSafeInteger(expected.size) ||
    expected.size < 0 ||
    expected.size > portableBackupLimit
  )
    throw new Error('Portable export supports backups up to 32 MiB.');
  const prefix = Buffer.concat([magic, randomBytes(16), randomBytes(12)]);
  const secret = await key(passphrase, prefix.subarray(magic.length, magic.length + 16));
  try {
    check();
    const cipher = createCipheriv('aes-256-gcm', secret, prefix.subarray(-12));
    cipher.setAAD(prefix);
    const output = Buffer.alloc(headerSize + expected.size + tagSize);
    prefix.copy(output);
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of contents) {
      try {
        check();
        if (chunk.length > expected.size - size)
          throw new Error('Backup size changed during export.');
        hash.update(chunk);
        cipher.update(chunk).copy(output, headerSize + size);
        size += chunk.length;
      } finally {
        chunk.fill(0);
      }
    }
    if (size !== expected.size || hash.digest('hex') !== expected.hash)
      throw new Error('Backup SHA-256 verification failed.');
    check();
    cipher.final();
    cipher.getAuthTag().copy(output, headerSize + size);
    return output;
  } finally {
    secret.fill(0);
  }
}

export async function openPortable(
  path: string,
  passphrase: string,
  check: Check,
): Promise<Buffer> {
  const input = await readBounded(path, portableBackupLimit + headerSize + tagSize, check);
  if (input.length < headerSize + tagSize || !input.subarray(0, magic.length).equals(magic))
    throw new Error('Unsupported or incomplete SSHDrop portable backup.');
  const prefix = input.subarray(0, headerSize);
  const secret = await key(passphrase, prefix.subarray(magic.length, magic.length + 16));
  let plaintext: Buffer | undefined;
  try {
    check();
    const cipher = createDecipheriv('aes-256-gcm', secret, prefix.subarray(-12));
    cipher.setAAD(prefix);
    cipher.setAuthTag(input.subarray(-tagSize));
    plaintext = cipher.update(input.subarray(headerSize, -tagSize));
    try {
      cipher.final();
    } catch (error) {
      throw new Error('Wrong passphrase or damaged portable backup. No copy was written.', {
        cause: error,
      });
    }
    check();
    return plaintext;
  } catch (error) {
    plaintext?.fill(0);
    throw error;
  } finally {
    secret.fill(0);
  }
}

async function readBounded(path: string, maximum: number, check: Check) {
  check();
  const before = await lstat(path);
  if (!before.isFile() || before.nlink !== 1 || before.size > maximum)
    throw new Error('Select a regular, single-link backup within the size limit.');
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0),
  );
  let bytes: Buffer | undefined;
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.dev !== before.dev ||
      info.ino !== before.ino ||
      info.size !== before.size
    )
      throw new Error('Selected backup changed while opening.');
    bytes = Buffer.alloc(info.size);
    for (let offset = 0; offset < bytes.length;) {
      check();
      const result = await file.read(bytes, offset, Math.min(65536, bytes.length - offset), offset);
      if (!result.bytesRead) throw new Error('Selected backup is incomplete.');
      offset += result.bytesRead;
    }
    const after = await file.stat();
    if (
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs ||
      after.ctimeMs !== info.ctimeMs
    )
      throw new Error('Selected backup changed while reading.');
    check();
    return bytes;
  } catch (error) {
    bytes?.fill(0);
    throw error;
  } finally {
    await file.close();
  }
}

export async function writePortableCopy(
  path: string,
  bytes: Buffer,
  userData: string,
  check: Check,
) {
  if (!isAbsolute(path) || !basename(path)) throw new Error('Choose a new destination file.');
  const parent = await realpath(dirname(path));
  const inside = relative(await realpath(userData), parent);
  if (!inside || (!isAbsolute(inside) && inside !== '..' && !inside.startsWith(`..${sep}`)))
    throw new Error('Choose a destination outside SSHDrop’s application data folder.');
  const identity = await lstat(parent);
  const target = join(parent, folderName(basename(path)));
  const stage = join(parent, `.sshdrop-portable-${randomUUID()}.part`);
  check();
  const output = await open(stage, 'wx', 0o600);
  let stageIdentity: { dev: number; ino: number } | undefined;
  try {
    try {
      stageIdentity = await output.stat();
      await output.writeFile(bytes);
      await output.sync();
    } finally {
      await output.close();
    }
    const staged = await readBounded(stage, bytes.length, check);
    try {
      if (staged.length !== bytes.length || digest(staged) !== digest(bytes))
        throw new Error('The new copy failed readback verification.');
    } finally {
      staged.fill(0);
    }
    const current = await lstat(parent);
    if (
      !current.isDirectory() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      (await realpath(parent)) !== parent
    )
      throw new Error('The destination folder changed. Choose it again.');
    const stagedIdentity = await lstat(stage);
    if (
      !stagedIdentity.isFile() ||
      stagedIdentity.dev !== stageIdentity.dev ||
      stagedIdentity.ino !== stageIdentity.ino ||
      stagedIdentity.nlink !== 1
    )
      throw new Error('The staged file changed. Choose a trusted destination folder.');
    check();
    try {
      await link(stage, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new Error('The destination already exists. Choose a new filename.', { cause: error });
      throw new Error(
        'Could not publish a verified copy without overwriting. Choose a local filesystem that supports hard links.',
        { cause: error },
      );
    }
  } finally {
    // Cleanup only this operation’s stage; never remove the chosen destination.
    const current = await lstat(parent).catch(() => undefined);
    if (current?.isDirectory() && current.dev === identity.dev && current.ino === identity.ino) {
      const staged = await lstat(stage).catch(() => undefined);
      if (staged?.isFile() && staged.dev === stageIdentity?.dev && staged.ino === stageIdentity.ino)
        await unlink(stage).catch(() => undefined);
    }
  }
}
