import { open } from 'node:fs/promises';

export async function readLocalData(file: string, maximum = 1024 * 1024): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximum)
      throw new Error('Local data exceeds the safety limit or is not a file.');
    const buffer = Buffer.alloc(maximum + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > maximum) throw new Error('Local data exceeds the safety limit.');
    return buffer.toString('utf8', 0, offset);
  } finally {
    await handle.close();
  }
}
