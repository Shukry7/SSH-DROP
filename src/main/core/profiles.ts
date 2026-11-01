import { randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute } from 'node:path';
import { z } from 'zod';
import { profileDetailsSchema } from '../../shared/validation';
import type { ServerProfile } from '../../shared/contracts';
import { readLocalData } from './local-data';

const recordSchema = profileDetailsSchema
  .extend({
    id: z.string().uuid(),
    keyPath: z
      .string()
      .min(1)
      .max(4096)
      .refine(
        (s) =>
          isAbsolute(s) &&
          !Array.from(s).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
      )
      .optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.auth === 'key') !== Boolean(value.keyPath))
      ctx.addIssue({
        code: 'custom',
        message: 'Select a private key for key authentication only.',
      });
  });
type StoredProfile = z.infer<typeof recordSchema>;
const storeSchema = z
  .object({
    version: z.literal(1),
    profiles: z.array(recordSchema).max(100),
  })
  .strict()
  .superRefine(({ profiles }, ctx) => {
    if (
      new Set(profiles.map((p) => p.id)).size !== profiles.length ||
      new Set(profiles.map((p) => p.name.toLowerCase())).size !== profiles.length
    )
      ctx.addIssue({ code: 'custom', message: 'Duplicate saved profiles.' });
  });

function publicProfile({ keyPath, ...profile }: StoredProfile): ServerProfile {
  return { ...profile, ...(keyPath ? { keyName: basename(keyPath) } : {}) };
}

export class ProfileStore {
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  private queue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }

  private async read(): Promise<StoredProfile[]> {
    try {
      return storeSchema.parse(JSON.parse(await readLocalData(this.file))).profiles;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error('Saved profiles could not be read. The file has not been changed.', {
        cause: error,
      });
    }
  }

  private async write(profiles: StoredProfile[]): Promise<void> {
    const data = storeSchema.parse({ version: 1, profiles });
    const contents = JSON.stringify(data, null, 2) + '\n';
    if (Buffer.byteLength(contents, 'utf8') > 1024 * 1024)
      throw new Error(
        'Saved profile details exceed the 1 MB storage limit. Shorten the saved paths or remove unused profiles.',
      );
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
      await rename(temporary, this.file);
    } catch (error) {
      throw new Error(
        'Saved profiles could not be written. Your previous profiles are unchanged.',
        { cause: error },
      );
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  list(): Promise<ServerProfile[]> {
    return this.queue(async () => (await this.read()).map(publicProfile));
  }

  load(id: string): Promise<{ profile: ServerProfile; keyPath?: string }> {
    return this.queue(async () => {
      z.string().uuid().parse(id);
      const record = (await this.read()).find((profile) => profile.id === id);
      if (!record) throw new Error('This saved profile no longer exists.');
      return { profile: publicProfile(record), keyPath: record.keyPath };
    });
  }

  save(value: unknown): Promise<ServerProfile> {
    return this.queue(async () => {
      const input = z.object({ id: z.string().uuid().optional() }).passthrough().parse(value);
      const record = recordSchema.parse({ ...input, id: input.id ?? randomUUID() });
      const profiles = await this.read();
      const index = profiles.findIndex((profile) => profile.id === record.id);
      if (input.id && index < 0) throw new Error('This saved profile no longer exists.');
      if (
        profiles.some(
          (p) => p.id !== record.id && p.name.toLowerCase() === record.name.toLowerCase(),
        )
      )
        throw new Error('A profile with this name already exists. Choose another name.');
      if (index < 0) {
        if (profiles.length >= 100) throw new Error('You can save up to 100 server profiles.');
        profiles.push(record);
      } else profiles[index] = record;
      await this.write(profiles);
      return publicProfile(record);
    });
  }

  delete(id: string): Promise<void> {
    return this.queue(async () => {
      z.string().uuid().parse(id);
      const profiles = await this.read();
      if (!profiles.some((profile) => profile.id === id))
        throw new Error('This saved profile no longer exists.');
      await this.write(profiles.filter((profile) => profile.id !== id));
    });
  }
}
