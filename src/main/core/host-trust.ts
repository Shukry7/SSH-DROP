import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { readLocalData } from './local-data';

export interface HostIdentity {
  host: string;
  port: number;
  fingerprint: string;
}
export type ApproveHost = (identity: HostIdentity, signal?: AbortSignal) => Promise<boolean>;
const storeSchema = z.record(z.string(), z.string().regex(/^SHA256:[A-Za-z0-9+/]+$/));

export class HostTrust {
  private pending: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly approve: ApproveHost,
  ) {}

  verify(host: string, port: number, key: Buffer, signal?: AbortSignal): Promise<boolean> {
    const result = this.pending.then(() => this.verifyIdentity(host, port, key, signal));
    this.pending = result.catch(() => undefined);
    return result;
  }

  private async verifyIdentity(
    host: string,
    port: number,
    key: Buffer,
    signal?: AbortSignal,
  ): Promise<boolean> {
    signal?.throwIfAborted();
    const fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
    const identity = JSON.stringify([host.toLowerCase(), port]);
    let records: Record<string, string>;
    try {
      records = storeSchema.parse(JSON.parse(await readLocalData(this.file)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('The host trust file could not be read. Connection blocked.', {
          cause: error,
        });
      records = {};
    }
    signal?.throwIfAborted();
    if (Object.hasOwn(records, identity)) {
      if (records[identity] !== fingerprint)
        throw new Error(
          'Server host key changed. Connection blocked. Verify the server identity before removing its old trust record.',
        );
      return true;
    }
    if (!(await this.approve({ host, port, fingerprint }, signal))) return false;
    signal?.throwIfAborted();
    records[identity] = fingerprint;
    const contents = JSON.stringify(records, null, 2) + '\n';
    if (Buffer.byteLength(contents) > 1024 * 1024)
      throw new Error('The host trust file exceeds the safety limit. Connection blocked.');
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, contents, {
        flag: 'wx',
        mode: 0o600,
      });
      signal?.throwIfAborted();
      await rename(temporary, this.file);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    return true;
  }
}
