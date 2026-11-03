import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { TransferQueue, type QueuedFile, type QueuedJob } from '../../src/main/core/transfer-queue';
import { downloadSelection } from '../../src/main/core/download-selection';
import { downloadSelectionSchema } from '../../src/shared/validation';
import type { QueueState, TransferUpdate } from '../../src/shared/contracts';

const file = (name: string): QueuedFile => ({
  direction: 'upload',
  local: join(tmpdir(), name),
  remote: `/${name}`,
});
const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};
describe('bounded main-owned transfer queue', () => {
  const setup = () => {
    const runs: { job: QueuedJob; task: ReturnType<typeof deferred> }[] = [];
    const updates: TransferUpdate[] = [];
    const states: QueueState[] = [];
    const queue = new TransferQueue(
      async (job) => {
        const task = deferred();
        runs.push({ job, task });
        await task.promise;
      },
      (item) => updates.push(item),
      (state) => states.push(state),
    );
    return { queue, runs, updates, states };
  };
  it('runs one file at a time in selection order and accepts additions while busy', async () => {
    const { queue, runs, updates, states } = setup();
    queue.enqueue([file('first'), file('second')]);
    queue.enqueue([file('third')]);
    expect(runs.map((r) => r.job.remote)).toEqual(['/first']);
    expect(updates.map((r) => r.status)).toEqual(['queued', 'queued', 'queued']);
    runs[0].task.resolve();
    await settle();
    expect(runs[1].job.remote).toBe('/second');
    runs[1].task.resolve();
    await settle();
    expect(runs[2].job.remote).toBe('/third');
    runs[2].task.resolve();
    await settle();
    expect(queue.size).toBe(0);
    expect(states.at(-1)).toEqual({ pending: 0, active: false, paused: false });
  });
  it('cancels a waiting file without running it or stopping the active file', async () => {
    const { queue, runs, updates } = setup();
    queue.enqueue([file('first'), file('second'), file('third')]);
    const id = updates[1].id;
    expect(queue.cancel(id)).toBe(true);
    expect(queue.cancel(id)).toBe(false);
    expect(updates.at(-1)?.status).toBe('cancelled');
    expect(queue.cancel(runs[0].job.id)).toBe(false);
    runs[0].task.resolve();
    await settle();
    expect(runs[1].job.remote).toBe('/third');
    runs[1].task.resolve();
    await settle();
  });
  it('pauses on failure and continues only remaining files after an explicit resume', async () => {
    const { queue, runs, updates, states } = setup();
    queue.enqueue([file('first'), file('second')]);
    runs[0].task.reject(new Error('uncertain publication'));
    await settle();
    expect(queue.isPaused).toBe(true);
    expect(runs).toHaveLength(1);
    queue.enqueue([file('third')]);
    expect(runs).toHaveLength(1);
    expect(states.at(-1)).toEqual({ pending: 2, active: false, paused: true });
    queue.resume();
    expect(runs[1].job.remote).toBe('/second');
    expect(runs.filter((r) => r.job.id === updates[0].id)).toHaveLength(1);
    runs[1].task.resolve();
    await settle();
    runs[2].task.resolve();
    await settle();
  });
  it('does not let an old completion or failure alter a new connection queue', async () => {
    const { queue, runs, states } = setup();
    queue.enqueue([file('old'), file('never-run')]);
    queue.clear();
    queue.enqueue([file('new'), file('new-second')]);
    runs[0].task.reject(new Error('late disconnect'));
    await settle();
    expect(queue.isPaused).toBe(false);
    expect(queue.activeId).toBe(runs[1].job.id);
    runs[1].task.resolve();
    await settle();
    expect(runs[2].job.remote).toBe('/new-second');
    runs[2].task.resolve();
    await settle();
    expect(states.at(-1)?.pending).toBe(0);
    expect(runs.some((r) => r.job.remote === '/never-run')).toBe(false);
  });
  it('clears an empty paused queue when its remaining item is cancelled', async () => {
    const { queue, runs, updates } = setup();
    queue.enqueue([file('bad'), file('waiting')]);
    runs[0].task.reject(new Error('failed'));
    await settle();
    expect(queue.cancel(updates[1].id)).toBe(true);
    expect(queue.isPaused).toBe(false);
    expect(queue.size).toBe(0);
  });
  it('validates entire batches and enforces limits and conservative destination collisions', () => {
    const { queue, updates } = setup();
    for (const input of [
      [],
      [file('first'), { ...file('bad'), local: 'relative' }],
      [file('same'), file('SAME')],
      [file('é'), file('e\u0301')],
      [file('bad\nname')],
      Array.from({ length: 101 }, (_, i) => file(`${i}`)),
    ])
      expect(() => queue.enqueue(input)).toThrow();
    expect(updates).toEqual([]);
    queue.enqueue(Array.from({ length: 100 }, (_, i) => file(`${i}`)));
    expect(() => queue.enqueue([file('overflow')])).toThrow('Queue limit');
    queue.clear();
  });
});

describe('safe native-folder download selection', () => {
  it('accepts bounded canonical file paths and maps them under the selected folder', () => {
    const paths = ['/one.txt', '/folder/two.txt'];
    expect(downloadSelection(tmpdir(), paths, 'linux')).toEqual(
      paths.map((remote) => ({
        direction: 'download',
        remote,
        local: join(tmpdir(), remote.split('/').at(-1)!),
      })),
    );
    expect(() => downloadSelection('relative', paths)).toThrow('destination folder');
  });
  it.each([
    [],
    ['/'],
    ['/folder/'],
    ['/folder/../escape'],
    ['/folder\\escape'],
    ['/bad\nname'],
    ['/bad/\u202espoof'],
    ['/same', '/same'],
    Array.from({ length: 101 }, (_, i) => `/${i}`),
  ])('rejects invalid selection %j', (paths) => {
    expect(downloadSelectionSchema.safeParse(paths).success).toBe(false);
  });
  it.each([
    'CON',
    'NUL.txt',
    'COM1.bin',
    'LPT9',
    'unsafe:stream',
    'trail.',
    'trail ',
    'bad?name',
    'quote"',
  ])('rejects unsafe Windows local name %s', (name) => {
    expect(() => downloadSelection(tmpdir(), [`/${name}`], 'win32')).toThrow('unsafe on Windows');
  });
  it('does not expose paths in queue state notifications', () => {
    const changed = vi.fn();
    const queue = new TransferQueue(
      async () => undefined,
      () => undefined,
      changed,
    );
    queue.enqueue([file('private-path')]);
    expect(JSON.stringify(changed.mock.calls)).not.toContain('private-path');
    queue.clear();
  });
});
