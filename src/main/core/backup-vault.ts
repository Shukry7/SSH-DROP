import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, open, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { readLocalData } from './local-data';

export interface KeyProtection {
  available(): Promise<boolean>;
  wrap(value: string): Promise<Buffer>;
  unwrap(value: Buffer): Promise<string>;
}
const header = Buffer.from('SSHDROP1');
const locked =
  'Encrypted backups are locked. Unlock the OS key store on this computer. No plaintext fallback is permitted. Keep the backup folder and its vault key together; losing the OS account/key can make recovery impossible.';
const envelope = z
  .object({ version: z.literal(1), wrapped: z.string().min(1).max(16384) })
  .strict();

export async function privateFile(path: string): Promise<void> {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    (process.platform !== 'win32' && info.mode & 0o077)
  )
    throw new Error('Unsafe backup file; data has been preserved.');
}

export class BackupVault {
  constructor(
    readonly directory: string,
    private readonly protection: KeyProtection,
  ) {}
  private async key(create = false): Promise<Buffer> {
    if (!(await this.protection.available())) throw new Error(locked);
    const path = join(this.directory, 'vault-key.json');
    try {
      await privateFile(path);
      const data = envelope.parse(JSON.parse(await readLocalData(path, 32768)));
      const value = await this.protection.unwrap(Buffer.from(data.wrapped, 'base64'));
      if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid vault key.');
      return Buffer.from(value, 'hex');
    } catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error(locked, { cause: error });
      // Never silently replace a lost key for an existing encrypted vault.
      if ((await readdir(this.directory)).some((name) => name.endsWith('.enc')))
        throw new Error(locked, { cause: error });
      const key = randomBytes(32);
      try {
        const wrapped = await this.protection.wrap(key.toString('hex'));
        if ((await this.protection.unwrap(wrapped)) !== key.toString('hex'))
          throw new Error(locked, { cause: error });
        const file = await open(path, 'wx', 0o600);
        try {
          await file.writeFile(JSON.stringify({ version: 1, wrapped: wrapped.toString('base64') }));
          await file.sync();
        } finally {
          await file.close();
        }
        return Buffer.from(key);
      } finally {
        key.fill(0);
      }
    }
  }
  async seal(
    name: string,
    source: AsyncIterable<Buffer>,
    check: () => void = () => undefined,
    purpose = name,
  ): Promise<void> {
    const key = await this.key(true);
    try {
      check();
    } catch (error) {
      key.fill(0);
      throw error;
    }
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    key.fill(0);
    cipher.setAAD(Buffer.from(`SSHDrop:${purpose}`));
    const path = join(this.directory, name);
    // Exclusive output: an interrupted copy is preserved, never mistaken for a complete backup.
    const file = await open(path, 'wx', 0o600);
    try {
      await file.writeFile(Buffer.concat([header, nonce]));
      for await (const chunk of source) {
        check();
        await file.writeFile(cipher.update(chunk));
      }
      check();
      await file.writeFile(Buffer.concat([cipher.final(), cipher.getAuthTag()]));
      await file.sync();
    } finally {
      await file.close();
    }
  }
  async *read(
    name: string,
    maximum: number,
    check: () => void = () => undefined,
    purpose = name,
  ): AsyncGenerator<Buffer> {
    const key = await this.key();
    try {
      const path = join(this.directory, name);
      await privateFile(path);
      const file = await open(path, 'r');
      try {
        const size = (await file.stat()).size;
        if (size < 36 || size > maximum + 36) throw new Error('Invalid encrypted backup size.');
        const prefix = Buffer.alloc(20);
        if (
          (await file.read(prefix, 0, 20, 0)).bytesRead !== 20 ||
          !prefix.subarray(0, 8).equals(header)
        )
          throw new Error('Invalid encrypted backup header.');
        const tag = Buffer.alloc(16);
        if ((await file.read(tag, 0, 16, size - 16)).bytesRead !== 16)
          throw new Error('Incomplete encrypted backup.');
        const cipher = createDecipheriv('aes-256-gcm', key, prefix.subarray(8));
        cipher.setAAD(Buffer.from(`SSHDrop:${purpose}`));
        cipher.setAuthTag(tag);
        for (let position = 20; position < size - 16;) {
          check();
          const buffer = Buffer.alloc(Math.min(65536, size - 16 - position));
          const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
          if (!bytesRead) throw new Error('Incomplete encrypted backup.');
          position += bytesRead;
          yield cipher.update(buffer.subarray(0, bytesRead));
        }
        check();
        // Consumers must stage all yielded bytes until authentication succeeds here.
        yield cipher.final();
      } finally {
        await file.close();
      }
    } finally {
      key.fill(0);
    }
  }
  async verify(
    name: string,
    expected: { size: number; hash: string },
    check?: () => void,
  ): Promise<void> {
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of this.read(name, expected.size, check)) {
      size += chunk.length;
      hash.update(chunk);
    }
    if (size !== expected.size || hash.digest('hex') !== expected.hash)
      throw new Error('Backup SHA-256 verification failed.');
  }
  async metadata(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of this.read('recovery.enc', 1024 * 1024)) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  }
  async writeMetadata(contents: string): Promise<void> {
    const temporary = `${randomUUID()}.tmp.enc`;
    try {
      // Bind metadata to its stable purpose, even while writing a temporary filename.
      const original = join(this.directory, temporary);
      await this.seal(
        temporary,
        (async function* () {
          yield Buffer.from(contents);
        })(),
        undefined,
        'recovery.enc',
      );
      const verified: Buffer[] = [];
      for await (const chunk of this.read(
        temporary,
        Buffer.byteLength(contents),
        undefined,
        'recovery.enc',
      ))
        verified.push(chunk);
      if (!Buffer.concat(verified).equals(Buffer.from(contents)))
        throw new Error('Encrypted recovery metadata verification failed.');
      await rename(original, join(this.directory, 'recovery.enc'));
    } finally {
      await unlink(join(this.directory, temporary)).catch(() => undefined);
    }
  }
}
