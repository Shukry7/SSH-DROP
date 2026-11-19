import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, open, readdir, rename, statfs, unlink } from 'node:fs/promises';
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
const wrappedKey = z.string().min(1).max(16384);
const envelope = z.union([
  z.object({ version: z.literal(1), wrapped: z.string().min(1).max(16384) }).strict(),
  z
    .object({ version: z.literal(2), wrapped: wrappedKey, previous: wrappedKey.optional() })
    .strict(),
]);

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
  private async unwrap(wrapped: string): Promise<Buffer> {
    const value = await this.protection.unwrap(Buffer.from(wrapped, 'base64'));
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(locked);
    return Buffer.from(value, 'hex');
  }
  private async key(create = false, rotation?: { previous?: string }): Promise<Buffer> {
    if (!(await this.protection.available())) throw new Error(locked);
    const path = join(this.directory, 'vault-key.json');
    try {
      await privateFile(path);
      const data = envelope.parse(JSON.parse(await readLocalData(path, 65536)));
      if (rotation && data.version === 2) rotation.previous = data.previous;
      return await this.unwrap(data.wrapped);
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
    const rotation: { previous?: string } = {};
    const key = await this.key(false, rotation);
    let previous: Buffer | undefined;
    try {
      if (rotation.previous) previous = await this.unwrap(rotation.previous);
      let selected = key;
      if (previous) {
        // Do not expose bytes from the wrong key while an interrupted rotation is pending.
        try {
          for await (const chunk of this.readWithKey(name, maximum, key, check, purpose))
            chunk.fill(0);
        } catch {
          check();
          for await (const chunk of this.readWithKey(name, maximum, previous, check, purpose))
            chunk.fill(0);
          selected = previous;
        }
      }
      yield* this.readWithKey(name, maximum, selected, check, purpose);
    } finally {
      key.fill(0);
      previous?.fill(0);
    }
  }
  private async *readWithKey(
    name: string,
    maximum: number,
    key: Buffer,
    check: () => void,
    purpose: string,
  ): AsyncGenerator<Buffer> {
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
  }
  private async writeEnvelope(data: z.infer<typeof envelope>): Promise<void> {
    const contents = JSON.stringify(envelope.parse(data));
    const temporary = join(this.directory, `${randomUUID()}.key.tmp`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(contents);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, join(this.directory, 'vault-key.json'));
      await this.syncDirectory();
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
  private async syncDirectory(): Promise<void> {
    // POSIX directory sync orders key/ciphertext renames before retiring the old key.
    // Windows has no equivalent portable Node API; retain an independent archive for power-loss recovery.
    if (process.platform === 'win32') return;
    const directory = await open(this.directory, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  async rotate(
    files: { name: string; size: number; hash: string }[],
    check: () => void,
  ): Promise<void> {
    // The owner serializes this operation with recovery mutations and blocks all workspace writers.
    check();
    await privateFile(join(this.directory, 'vault-key.json'));
    if (!(await this.protection.available())) throw new Error(locked);
    let data = envelope.parse(
      JSON.parse(await readLocalData(join(this.directory, 'vault-key.json'), 65536)),
    );
    const names = new Set(files.map((file) => file.name));
    if (
      files.some((file) => !/^(recovery|[a-f0-9-]{36}\.bak)\.enc$/.test(file.name)) ||
      names.size !== files.length
    )
      throw new Error('Invalid recovery rotation files.');
    if ((await readdir(this.directory)).some((name) => name.endsWith('.enc') && !names.has(name)))
      throw new Error(
        'Unreferenced encrypted files exist. Preserve and review the vault before rotating.',
      );
    for (const file of files) {
      check();
      await this.verify(file.name, file, check);
    }
    const space = await statfs(this.directory);
    if (
      space.bavail * space.bsize <
      Math.max(0, ...files.map((file) => file.size)) + 50 * 1024 ** 2
    )
      throw new Error('Insufficient space to rotate the vault with a safety reserve.');
    if (data.version === 1 || !data.previous) {
      const key = randomBytes(32);
      try {
        const wrapped = await this.protection.wrap(key.toString('hex'));
        const verified = await this.unwrap(wrapped.toString('base64'));
        try {
          if (!verified.equals(key)) throw new Error(locked);
        } finally {
          verified.fill(0);
        }
        check();
        data = { version: 2, wrapped: wrapped.toString('base64'), previous: data.wrapped };
        // Publish both keys before any ciphertext is replaced. Never restore the old envelope on failure.
        await this.writeEnvelope(data);
      } finally {
        key.fill(0);
      }
    }
    for (const file of files) {
      check();
      const temporary = `${randomUUID()}.rotation.tmp`;
      try {
        const original = this.read(file.name, file.size, check);
        await this.seal(
          temporary,
          (async function* () {
            for await (const chunk of original) {
              try {
                yield chunk;
              } finally {
                chunk.fill(0);
              }
            }
          })(),
          check,
          file.name,
        );
        const key = await this.key();
        try {
          const hash = createHash('sha256');
          let size = 0;
          for await (const chunk of this.readWithKey(temporary, file.size, key, check, file.name)) {
            size += chunk.length;
            hash.update(chunk);
            chunk.fill(0);
          }
          if (size !== file.size || hash.digest('hex') !== file.hash)
            throw new Error('Rotated backup verification failed.');
        } finally {
          key.fill(0);
        }
        check();
        await rename(join(this.directory, temporary), join(this.directory, file.name));
      } finally {
        await unlink(join(this.directory, temporary)).catch(() => undefined);
      }
    }
    // Verify every published file with ONLY the new key before retiring the previous key.
    const key = await this.key();
    try {
      for (const file of files) {
        const hash = createHash('sha256');
        let size = 0;
        for await (const chunk of this.readWithKey(file.name, file.size, key, check, file.name)) {
          size += chunk.length;
          hash.update(chunk);
          chunk.fill(0);
        }
        if (size !== file.size || hash.digest('hex') !== file.hash)
          throw new Error('Rotated backup verification failed.');
      }
      check();
      await this.syncDirectory();
      await this.writeEnvelope({ version: 2, wrapped: data.wrapped });
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
      chunk.fill(0);
    }
    if (size !== expected.size || hash.digest('hex') !== expected.hash)
      throw new Error('Backup SHA-256 verification failed.');
  }
  async metadata(purpose = 'recovery.enc'): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of this.read(purpose, 1024 * 1024)) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  }
  async writeMetadata(contents: string, purpose = 'recovery.enc'): Promise<void> {
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
        purpose,
      );
      const verified: Buffer[] = [];
      for await (const chunk of this.read(
        temporary,
        Buffer.byteLength(contents),
        undefined,
        purpose,
      ))
        verified.push(chunk);
      if (!Buffer.concat(verified).equals(Buffer.from(contents)))
        throw new Error('Encrypted recovery metadata verification failed.');
      await rename(original, join(this.directory, purpose));
    } finally {
      await unlink(join(this.directory, temporary)).catch(() => undefined);
    }
  }
}
