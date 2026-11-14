import { randomUUID } from 'node:crypto';
import { basename, isAbsolute } from 'node:path';
import { z } from 'zod';
import type { QueueState, TransferUpdate } from '../../shared/contracts';
import { remotePathSchema } from '../../shared/validation';

export interface QueuedFile {
  direction: 'upload' | 'download';
  local: string;
  remote: string;
  folder?: true;
  sourceFingerprint?: string;
  recoveryId?: string;
  expectedSourceHash?: string;
}
export interface QueuedJob extends QueuedFile {
  id: string;
}
const safeDisplayPath = (s: string) =>
  !Array.from(s).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
  !/[\u202a-\u202e\u2066-\u2069]/.test(s);
export const queuedFileSchema = z
  .object({
    direction: z.enum(['upload', 'download']),
    local: z.string().max(4096).refine(isAbsolute).refine(safeDisplayPath),
    remote: remotePathSchema.refine(safeDisplayPath),
    folder: z.literal(true).optional(),
    sourceFingerprint: z
      .string()
      .max(160)
      .regex(/^\d+:\d+:\d+:-?\d+:-?\d+$/)
      .optional(),
    recoveryId: z.string().uuid().optional(),
    expectedSourceHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict()
  .refine((job) => !job.sourceFingerprint || (job.direction === 'upload' && !job.folder));

// Only main owns paths. Recovery records never enter the queue automatically.
export class TransferQueue {
  private waiting: QueuedJob[] = [];
  private active?: QueuedJob;
  private paused = false;
  private generation = 0;
  revision = 0;
  constructor(
    private readonly run: (job: QueuedJob) => Promise<void>,
    private readonly update: (item: TransferUpdate) => void,
    private readonly changed: (state: QueueState) => void,
    private readonly removed: (job: QueuedJob, cancelled: boolean) => void = () => {},
  ) {}
  get size() {
    return this.waiting.length + Number(!!this.active);
  }
  get activeId() {
    return this.active?.id;
  }
  get isPaused() {
    return this.paused;
  }
  private state() {
    this.changed({ pending: this.waiting.length, active: !!this.active, paused: this.paused });
  }
  validate(input: QueuedFile[]): QueuedFile[] {
    const files = z.array(queuedFileSchema).min(1).max(100).parse(input);
    if (this.size + files.length > 100)
      throw new Error('Queue limit reached: at most 100 active and waiting files.');
    // Reject ambiguous duplicate destinations within a selection, even on case-insensitive servers.
    const targets = files.map((f) =>
      `${f.direction}:${f.direction === 'upload' ? f.remote : f.local}`
        .normalize('NFC')
        .toLowerCase(),
    );
    if (new Set(targets).size !== targets.length)
      throw new Error(
        'The selection contains colliding destination names. Select those files separately.',
      );
    return files;
  }
  enqueue(input: QueuedFile[], start = true): void {
    const jobs = this.validate(input).map((file) => ({ ...file, id: randomUUID() }));
    this.waiting.push(...jobs);
    this.revision++;
    for (const job of jobs)
      this.update({
        id: job.id,
        name: basename(job.local),
        direction: job.direction,
        transferred: 0,
        total: 0,
        status: 'queued',
      });
    this.state();
    if (start) this.pump();
  }
  start(): void {
    this.pump();
  }
  cancel(id: string): boolean {
    const index = this.waiting.findIndex((job) => job.id === id);
    if (index < 0) return false;
    const [job] = this.waiting.splice(index, 1);
    this.removed(job, true);
    this.revision++;
    this.update({
      id: job.id,
      name: basename(job.local),
      direction: job.direction,
      transferred: 0,
      total: 0,
      status: 'cancelled',
    });
    if (!this.waiting.length && !this.active) this.paused = false;
    this.state();
    return true;
  }
  resume(): void {
    this.paused = false;
    this.revision++;
    this.state();
    this.pump();
  }
  clear(): void {
    this.generation++;
    this.revision++;
    for (const job of this.waiting) this.removed(job, false);
    this.waiting = [];
    this.active = undefined;
    this.paused = false;
    this.state();
  }
  private pump(): void {
    if (this.active || this.paused) return;
    const job = this.waiting.shift();
    if (!job) return;
    const generation = this.generation;
    this.active = job;
    this.state();
    void this.run(job)
      .catch(() => {
        if (generation === this.generation) this.paused = true;
      })
      .finally(() => {
        if (generation !== this.generation || this.active !== job) return;
        this.active = undefined;
        if (!this.waiting.length) this.paused = false;
        this.state();
        this.pump();
      });
  }
}
