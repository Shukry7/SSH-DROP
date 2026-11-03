import { isAbsolute, join, posix } from 'node:path';
import { downloadSelectionSchema } from '../../shared/validation';
import type { QueuedFile } from './transfer-queue';

export function downloadSelection(
  directory: string,
  input: string[],
  platform = process.platform,
): QueuedFile[] {
  if (!isAbsolute(directory)) throw new Error('Choose a local destination folder.');
  return downloadSelectionSchema.parse(input).map((remote) => {
    const name = posix.basename(remote);
    if (
      platform === 'win32' &&
      (/[<>:"|?*]/.test(name) ||
        /[. ]$/.test(name) ||
        /^(?:CON|CONIN\$|CONOUT\$|CLOCK\$|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(name))
    )
      throw new Error(
        'A selected filename is unsafe on Windows. Download that file separately and choose a different local name.',
      );
    return { direction: 'download', local: join(directory, name), remote };
  });
}
