import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

export interface HostIdentity {
  host: string;
  port: number;
  fingerprint: string;
}
export type ApproveHost = (identity: HostIdentity) => Promise<boolean>;
const storeSchema = z.record(z.string(), z.string().regex(/^SHA256:[A-Za-z0-9+/]+$/));

export class HostTrust {
  constructor(
    private readonly file: string,
    private readonly approve: ApproveHost,
  ) {}

  async verify(host: string, port: number, key: Buffer): Promise<boolean> {
    const fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
    const identity = JSON.stringify([host.toLowerCase(), port]);
    let records: Record<string, string>;
    try {
      records = storeSchema.parse(JSON.parse(await readFile(this.file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('The host trust file could not be read. Connection blocked.', {
          cause: error,
        });
      records = {};
    }
    if (Object.hasOwn(records, identity)) {
      if (records[identity] !== fingerprint)
        throw new Error(
          'Server host key changed. Connection blocked. Verify the server identity before removing its old trust record.',
        );
      return true;
    }
    if (!(await this.approve({ host, port, fingerprint }))) return false;
    records[identity] = fingerprint;
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(records, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
      await rename(temporary, this.file);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    return true;
  }
}
