import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { defaultIdleSettings, idleSettingsSchema, type IdleSettings } from '../../shared/idle';
import { readLocalData } from './local-data';
const schema = z.object({ version: z.literal(1), settings: idleSettingsSchema }).strict();

export class IdleSettingsStore {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string) {}
  async read(): Promise<IdleSettings> {
    try {
      return schema.parse(JSON.parse(await readLocalData(this.file, 16384))).settings;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...defaultIdleSettings };
      throw new Error(
        'Idle protection settings are invalid or unreadable. The file was preserved.',
        { cause: error },
      );
    }
  }
  save(settings: IdleSettings, check: () => void): Promise<IdleSettings> {
    const next = this.pending.then(async () => {
      const value = idleSettingsSchema.parse(settings);
      await this.read();
      check();
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, 'wx', 0o600);
        try {
          await file.writeFile(JSON.stringify({ version: 1, settings: value }) + '\n');
          await file.sync();
        } finally {
          await file.close();
        }
        check();
        await rename(temporary, this.file);
        return value;
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    });
    this.pending = next.catch(() => undefined);
    return next;
  }
}
