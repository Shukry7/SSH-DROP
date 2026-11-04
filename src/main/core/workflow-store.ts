import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { workflowSchema, type Workflow } from '../../shared/workflows';
import { readLocalData } from './local-data';
const schema = z
  .object({ version: z.literal(1), workflows: z.array(workflowSchema).max(100) })
  .strict()
  .refine((v) => new Set(v.workflows.map((w) => w.id)).size === v.workflows.length);
export class WorkflowStore {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string) {}
  private queue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.pending.then(fn);
    this.pending = next.catch(() => undefined);
    return next;
  }
  private async read(): Promise<Workflow[]> {
    try {
      return schema.parse(JSON.parse(await readLocalData(this.file, 2 * 1024 * 1024))).workflows;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error('Saved workflows are invalid or unreadable. The file was preserved.', {
        cause: error,
      });
    }
  }
  list() {
    return this.queue(() => this.read());
  }
  save(input: Workflow) {
    return this.queue(async () => {
      const value = workflowSchema.parse(input);
      const list = await this.read();
      const index = list.findIndex((w) => w.id === value.id);
      if (index < 0) list.push(value);
      else list[index] = value;
      await this.write(list);
      return value;
    });
  }
  delete(id: string) {
    return this.queue(async () => {
      z.string().uuid().parse(id);
      const list = await this.read();
      await this.write(list.filter((w) => w.id !== id));
    });
  }
  private async write(workflows: Workflow[]) {
    const bytes = JSON.stringify(schema.parse({ version: 1, workflows }), null, 2) + '\n';
    if (Buffer.byteLength(bytes) > 2 * 1024 * 1024)
      throw new Error('Workflow storage limit reached (2 MiB).');
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    try {
      const file = await open(tmp, 'wx', 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(tmp, this.file);
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
  }
}
