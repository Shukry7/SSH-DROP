import { PassThrough } from 'node:stream';
import type { ClientChannel } from 'ssh2';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWorkflow, workflowLimits } from '../../src/main/core/workflow-runner';
import type { WorkflowPlan, WorkflowUpdate } from '../../src/shared/workflows';
const plan: WorkflowPlan = {
  name: 'test',
  directory: '/',
  commands: ['one'],
  scripts: ['one'],
  followLast: false,
  minutes: 1,
};
const channel = () => {
  const c = new PassThrough() as PassThrough & {
    stderr: PassThrough;
    signal: () => void;
    close: () => void;
  };
  c.stderr = new PassThrough();
  c.signal = () => {};
  c.close = () => c.emit('close');
  return c;
};
describe('workflow request deadlines and uncertain exits', () => {
  afterEach(() => vi.useRealTimers());
  it('bounds channel opening and closes a late result without starting later steps', async () => {
    vi.useFakeTimers();
    const updates: WorkflowUpdate[] = [];
    let reply: ((error: Error | undefined, c: ClientChannel) => void) | undefined;
    const running = runWorkflow(
      plan,
      'test',
      (_script, cb) => {
        reply = cb;
      },
      new AbortController().signal,
      () => true,
      (u) => updates.push(u),
    );
    await vi.advanceTimersByTimeAsync(workflowLimits.open + 1);
    await running;
    expect(updates.at(-1)?.status).toBe('failed');
    const c = channel();
    const closed = vi.spyOn(c, 'close');
    reply!(undefined, c as unknown as ClientChannel);
    expect(closed).toHaveBeenCalled();
  });
  it('times out running steps and sends a stop signal', async () => {
    vi.useFakeTimers();
    const c = channel();
    const signal = vi.spyOn(c, 'signal');
    const updates: WorkflowUpdate[] = [];
    const running = runWorkflow(
      plan,
      'test',
      (_s, cb) => cb(undefined, c as unknown as ClientChannel),
      new AbortController().signal,
      () => true,
      (u) => updates.push(u),
    );
    await vi.advanceTimersByTimeAsync(60001);
    await running;
    expect(signal).toHaveBeenCalled();
    expect(updates.at(-1)?.message).toContain('timed out');
  });
  it('does not call a stream closed without an exit status successful', async () => {
    const c = channel();
    const updates: WorkflowUpdate[] = [];
    const running = runWorkflow(
      plan,
      'test',
      (_s, cb) => cb(undefined, c as unknown as ClientChannel),
      new AbortController().signal,
      () => true,
      (u) => updates.push(u),
    );
    c.emit('close');
    await running;
    expect(updates.at(-1)?.message).toContain('uncertain');
  });
  it('reports opening errors and suppresses events for a discarded connection', async () => {
    const updates: WorkflowUpdate[] = [];
    await runWorkflow(
      plan,
      'test',
      (_s, cb) => cb(new Error('denied'), undefined as unknown as ClientChannel),
      new AbortController().signal,
      () => true,
      (u) => updates.push(u),
    );
    expect(updates.at(-1)?.message).toBe('denied');
    const opened = vi.fn();
    await runWorkflow(
      plan,
      'test',
      opened,
      new AbortController().signal,
      () => false,
      (u) => updates.push(u),
    );
    expect(opened).not.toHaveBeenCalled();
  });
});
