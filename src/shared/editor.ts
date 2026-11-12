import { z } from 'zod';
import { actionDirectorySchema, actionNameSchema } from './validation';

export const editorLimit = 1024 * 1024;
export const openEditorSchema = z
  .object({ directory: actionDirectorySchema, name: actionNameSchema })
  .strict();
export const saveEditorSchema = z
  .object({ token: z.string().uuid(), text: z.string().max(editorLimit) })
  .strict();
export interface EditorDocument {
  token: string;
  path: string;
  text: string;
}
export const editorTokenSchema = z.string().uuid();
export const acceptEditorReviewSchema = z
  .object({ token: editorTokenSchema, reviewToken: editorTokenSchema, keepDraft: z.boolean() })
  .strict();
export interface EditorComparison {
  reviewToken: string;
  text: string;
  changed: boolean;
  lineEndings: 'LF' | 'CRLF';
  bom: boolean;
}
