import { z } from 'zod';
import { actionNameSchema } from '../../shared/validation';

export const uploadStageSchema = z
  .object({
    name: z.string().regex(/^\.sshdrop-[a-f0-9-]{36}\.part$/),
    uid: z.number().int().nonnegative(),
    gid: z.number().int().nonnegative(),
  })
  .strict();
export type UploadStage = z.infer<typeof uploadStageSchema>;

const entry = z
  .object({
    parts: z.array(actionNameSchema).max(16),
    sourceKey: z.string().max(256),
    hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    destinationKey: z.string().max(256).optional(),
    uploadStage: uploadStageSchema.optional(),
    original: z
      .object({ key: z.string().max(256), hash: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .optional(),
    skipped: z.literal(true).optional(),
    alternate: actionNameSchema.optional(),
    replacementId: z.string().uuid().optional(),
    originalNames: z.array(z.string().max(4096)).max(1000).optional(),
  })
  .strict()
  .refine(
    (item) =>
      (!item.uploadStage || (!!item.hash && !item.destinationKey && !item.original)) &&
      (!item.original ||
        (!!item.hash && (!!item.destinationKey === !!item.alternate || !!item.replacementId))) &&
      (!item.replacementId ||
        (!!item.original && !item.alternate && !item.skipped && !item.uploadStage)) &&
      (!item.alternate || !!item.original) &&
      (!item.skipped || (!!item.original && !item.destinationKey)) &&
      (!item.originalNames || (!item.hash && !!item.destinationKey)),
  );

export const folderCheckpointSchema = z
  .object({
    parentKey: z.string().max(256),
    merge: z.literal(true).optional(),
    entries: z.array(entry).min(1).max(100),
  })
  .strict()
  .refine(({ entries, merge }) =>
    merge
      ? !!entries[0].originalNames
      : entries.every((item) => !item.original && !item.originalNames),
  );
export type FolderCheckpoint = z.infer<typeof folderCheckpointSchema>;
export const folderCheckpointByteLimit = 128 * 1024 ** 2;
