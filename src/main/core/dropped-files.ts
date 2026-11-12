import type { BigIntStats } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { actionDirectorySchema, actionNameSchema, childPath } from '../../shared/validation';
import type { QueuedFile } from './transfer-queue';

const droppedFilesSchema = z
  .object({
    directory: actionDirectorySchema,
    files: z.array(z.string().max(4096).refine(isAbsolute)).min(1).max(100),
  })
  .strict();

export function droppedFileFingerprint(stats: BigIntStats): string {
  if (!stats.isFile() || stats.nlink !== 1n)
    throw new Error(
      'Drop regular files without symbolic links or hard links. Use Upload folder for folders.',
    );
  return [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].join(':');
}

export async function readDroppedFileFingerprint(path: string): Promise<string> {
  const stats = await lstat(path, { bigint: true }).catch(() => {
    throw new Error('A dropped file could not be read. Drop it again or use Upload files.');
  });
  return droppedFileFingerprint(stats);
}

export async function inspectDroppedFiles(input: unknown) {
  const { directory, files } = droppedFilesSchema.parse(input);
  const names = files.map((path) => actionNameSchema.parse(basename(path)));
  if (new Set(names.map((name) => name.normalize('NFC').toLowerCase())).size !== names.length)
    throw new Error('The dropped files have colliding names. Upload them separately.');
  const jobs = await Promise.all(
    files.map(async (file, index): Promise<QueuedFile> => {
      const parent = await realpath(dirname(file)).catch(() => {
        throw new Error(
          'A dropped file location could not be read. Drop it again or use Upload files.',
        );
      });
      const local = join(parent, names[index]);
      const remote = childPath(directory, names[index]);
      if (
        Buffer.byteLength(remote) > 4096 ||
        local.length > 4096 ||
        /[\u202a-\u202e\u2066-\u2069]/.test(local) ||
        Array.from(local).some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        )
      )
        throw new Error('A dropped file path is too long or contains unsupported characters.');
      return {
        direction: 'upload',
        local,
        remote,
        sourceFingerprint: await readDroppedFileFingerprint(local),
      };
    }),
  );
  return { directory, jobs };
}
