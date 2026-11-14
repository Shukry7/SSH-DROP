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
  })
  .strict()
  .refine((item) => !item.uploadStage || (!!item.hash && !item.destinationKey));

export const folderCheckpointSchema = z
  .object({
    parentKey: z.string().max(256),
    entries: z.array(entry).min(1).max(100),
  })
  .strict();
export type FolderCheckpoint = z.infer<typeof folderCheckpointSchema>;
export const folderCheckpointByteLimit = 128 * 1024 ** 2;
