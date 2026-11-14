import { z } from 'zod';
import { actionDirectorySchema, actionNameSchema } from './validation';

export const openImageSchema = z
  .object({
    directory: actionDirectorySchema,
    name: actionNameSchema,
    requestId: z.string().uuid(),
  })
  .strict();
export const imageRequestSchema = z.string().uuid();
export interface ImagePreview {
  path: string;
  width: number;
  height: number;
  format: string;
  size: number;
  firstFrame: boolean;
  dataUrl: string;
}
