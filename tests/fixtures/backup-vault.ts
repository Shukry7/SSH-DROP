import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { BackupVault, type KeyProtection } from '../../src/main/core/backup-vault';

// Isolated test key provider, never used or selected by production code.
const wrappingKey = randomBytes(32);
export const testProtection: KeyProtection = {
  available: async () => true,
  wrap: async (value) => {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', wrappingKey, nonce);
    return Buffer.concat([
      nonce,
      cipher.update(value, 'utf8'),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
  },
  unwrap: async (value) => {
    const cipher = createDecipheriv('aes-256-gcm', wrappingKey, value.subarray(0, 12));
    cipher.setAuthTag(value.subarray(-16));
    return Buffer.concat([cipher.update(value.subarray(12, -16)), cipher.final()]).toString('utf8');
  },
};
export const testVault = (directory: string) => new BackupVault(directory, testProtection);
export async function backupText(vault: BackupVault, id: string): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of vault.read(`${id}.bak.enc`, 10 * 1024 ** 3)) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
