import { posix } from 'node:path';
import { z } from 'zod';

const hasControl = (value: string) =>
  Array.from(value).some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );

export const connectionSchema = z
  .object({
    host: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .refine((s) => !/[\s/\\]/.test(s) && !hasControl(s), 'Enter a hostname or IP address.'),
    port: z.number().int().min(1).max(65535),
    username: z
      .string()
      .min(1)
      .max(128)
      .refine((s) => !hasControl(s)),
    auth: z.enum(['password', 'key']),
    password: z.string().max(4096).optional(),
    keyId: z.string().uuid().optional(),
    passphrase: z.string().max(4096).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.auth === 'password' && !value.password)
      ctx.addIssue({ code: 'custom', path: ['password'], message: 'Enter a password.' });
    if (value.auth === 'key' && !value.keyId)
      ctx.addIssue({ code: 'custom', path: ['keyId'], message: 'Select a private key.' });
  });
export const remotePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((s) => s.startsWith('/') && !s.includes('\0'), 'Use an absolute remote path.');
export const terminalInputSchema = z.string().max(65536);
export const terminalSizeSchema = z
  .object({ cols: z.number().int().min(2).max(1000), rows: z.number().int().min(1).max(1000) })
  .strict();
export const transferIdSchema = z.string().uuid();

export function remotePath(value: string): string {
  return posix.normalize(remotePathSchema.parse(value));
}
export function childPath(directory: string, name: string): string {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0'))
    throw new Error('Invalid remote filename.');
  return posix.join(remotePath(directory), name);
}
