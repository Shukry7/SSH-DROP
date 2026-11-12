import { posix } from 'node:path';
import { z } from 'zod';

export const portablePassphrase = z.string().min(16).max(256);
export const portableExportRequest = z
  .object({ id: z.string().uuid(), passphrase: portablePassphrase })
  .strict();

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
export const profileDetailsSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .refine((s) => !hasControl(s)),
    host: connectionSchema.shape.host,
    port: connectionSchema.shape.port,
    username: connectionSchema.shape.username,
    auth: connectionSchema.shape.auth,
    startingDirectory: remotePathSchema.refine((s) => !hasControl(s)),
  })
  .strict();
export const profileInputSchema = profileDetailsSchema
  .extend({
    id: z.string().uuid().optional(),
    keyId: z.string().uuid().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.auth === 'key' && !value.keyId)
      ctx.addIssue({ code: 'custom', path: ['keyId'], message: 'Select a private key.' });
    if (value.auth === 'password' && value.keyId)
      ctx.addIssue({ code: 'custom', path: ['keyId'], message: 'Unexpected private key.' });
  });

export function remotePath(value: string): string {
  return posix.normalize(remotePathSchema.parse(value));
}
export const actionNameSchema = z
  .string()
  .min(1)
  .refine(
    (name) =>
      name !== '.' &&
      name !== '..' &&
      !/[\\/\u202a-\u202e\u2066-\u2069]/.test(name) &&
      !hasControl(name) &&
      Buffer.byteLength(name, 'utf8') <= 255,
    'Use a single filename of at most 255 UTF-8 bytes, without slashes or control characters.',
  );
export const actionDirectorySchema = remotePathSchema.refine(
  (path) =>
    posix.normalize(path) === path &&
    (path === '/' || !path.endsWith('/')) &&
    !hasControl(path) &&
    !/[\\\u202a-\u202e\u2066-\u2069]/.test(path) &&
    Buffer.byteLength(path, 'utf8') <= 4096,
  'Refresh and select a canonical remote directory.',
);
export const downloadSelectionSchema = z
  .array(
    remotePathSchema.refine(
      (path) =>
        path !== '/' &&
        posix.normalize(path) === path &&
        !path.endsWith('/') &&
        actionNameSchema.safeParse(posix.basename(path)).success &&
        !hasControl(path) &&
        !/[\\\u202a-\u202e\u2066-\u2069]/.test(path),
    ),
  )
  .min(1)
  .max(100)
  .refine((paths) => new Set(paths).size === paths.length, 'Select each file only once.');
const actionFields = { directory: actionDirectorySchema, name: actionNameSchema };
export const fileActionSchema = z
  .discriminatedUnion('action', [
    z.object({ action: z.literal('create-file'), ...actionFields }).strict(),
    z.object({ action: z.literal('create-folder'), ...actionFields }).strict(),
    z
      .object({
        action: z.literal('permissions'),
        ...actionFields,
        kind: z.enum(['file', 'directory']),
        expectedMode: z.number().int().min(0).max(0o777),
        mode: z.string().regex(/^[0-7]{3}$/, 'Enter three octal permission digits, such as 640.'),
      })
      .strict(),
    z
      .object({
        action: z.enum(['copy', 'move']),
        ...actionFields,
        destinationDirectory: actionDirectorySchema,
      })
      .strict(),
    z
      .object({
        action: z.literal('rename'),
        ...actionFields,
        newName: actionNameSchema,
        kind: z.enum(['file', 'directory']),
      })
      .strict(),
    z
      .object({ action: z.literal('delete'), ...actionFields, kind: z.enum(['file', 'directory']) })
      .strict(),
  ])
  .superRefine((input, ctx) => {
    for (const name of [input.name, ...('newName' in input ? [input.newName] : [])])
      if (
        Buffer.byteLength(`${input.directory === '/' ? '' : input.directory}/${name}`, 'utf8') >
        4096
      )
        ctx.addIssue({ code: 'custom', message: 'The remote path is too long.' });
    if (input.action === 'rename' && input.name === input.newName)
      ctx.addIssue({ code: 'custom', message: 'Choose a different name.' });
    if ('destinationDirectory' in input) {
      if (input.destinationDirectory === input.directory)
        ctx.addIssue({ code: 'custom', message: 'Choose a different destination folder.' });
      if (Buffer.byteLength(posix.join(input.destinationDirectory, input.name), 'utf8') > 4096)
        ctx.addIssue({ code: 'custom', message: 'The destination path is too long.' });
    }
  });
export function childPath(directory: string, name: string): string {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0'))
    throw new Error('Invalid remote filename.');
  return posix.join(remotePath(directory), name);
}
export const recoveryActionSchema = z
  .object({
    id: z.string().uuid(),
    action: z.enum(['inspect', 'rollback', 'restore-copy', 'delete-backup', 'encrypt-backup']),
  })
  .strict();
