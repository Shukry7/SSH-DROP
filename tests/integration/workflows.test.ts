import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowStore } from '../../src/main/core/workflow-store';
import { renderWorkflow, type Workflow } from '../../src/shared/workflows';
import { Session } from '../../src/main/core/session';
import type { SessionEvent } from '../../src/shared/contracts';
import { sshFixture } from '../fixtures/ssh-server';
import { workflowLimits } from '../../src/main/core/workflow-runner';
const definition = (): Workflow => ({
  id: randomUUID(),
  name: 'Test',
  description: 'Disposable commands',
  directory: '~/test space',
  steps: ['printf %s {{user_id}}', 'echo second'],
  variables: [{ name: 'user_id', type: 'text', label: 'User ID' }],
  minutes: 1,
  followLast: false,
});
describe('global workflow storage and guarded SSH execution', () => {
  const cleanup: (() => Promise<void>)[] = [];
  const oldLimits = { ...workflowLimits };
  afterEach(async () => {
    Object.assign(workflowLimits, oldLimits);
    for (const fn of cleanup.reverse()) await fn();
    cleanup.length = 0;
  });
  const dir = async () => {
    const d = await mkdtemp(join(tmpdir(), 'sshdrop-commands-'));
    cleanup.push(() => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    return d;
  };
  it('persists definitions across store instances, serializes changes and preserves corrupt data', async () => {
    const file = join(await dir(), 'workflows.json');
    const store = new WorkflowStore(file);
    const a = definition(),
      b = definition();
    await Promise.all([store.save(a), store.save(b)]);
    expect(await new WorkflowStore(file).list()).toHaveLength(2);
    await store.save({ ...a, name: 'Edited' });
    expect((await store.list())[0].name).toBe('Edited');
    await store.delete(b.id);
    expect(await store.list()).toHaveLength(1);
    await writeFile(file, 'corrupt');
    await expect(store.save(a)).rejects.toThrow('preserved');
    expect(await readFile(file, 'utf8')).toBe('corrupt');
  });
  it('rejects over-limit and invalid stored definitions without replacing existing data', async () => {
    const file = join(await dir(), 'workflows.json');
    const store = new WorkflowStore(file);
    const a = definition();
    await store.save(a);
    const bytes = await readFile(file, 'utf8');
    await expect(store.save({ ...a, steps: Array(33).fill('echo hi') })).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(bytes);
    await expect(store.delete('../anything')).rejects.toThrow();
  });
  it('loads older definitions with confirmation enabled and persists explicit opt-outs', async () => {
    const file = join(await dir(), 'workflows.json');
    const original = definition();
    await writeFile(file, JSON.stringify({ version: 1, workflows: [original] }));
    const store = new WorkflowStore(file);
    expect((await store.list())[0].confirmBeforeRun).toBe(true);
    await store.save({ ...original, confirmBeforeRun: false });
    expect((await new WorkflowStore(file).list())[0].confirmBeforeRun).toBe(false);
  });
  const connect = async (exec: NonNullable<Parameters<typeof sshFixture>[0]>['exec']) => {
    const fixture = await sshFixture({ exec });
    const events: SessionEvent[] = [];
    const session = new Session({ verify: async () => true }, (event) => events.push(event));
    cleanup.push(async () => {
      session.disconnect();
      await fixture.close();
    });
    await session.connect({
      host: '127.0.0.1',
      port: fixture.port,
      username: 'tester',
      password: 'test-password',
    });
    return { session, events, fixture };
  };
  it('executes separate steps in the chosen directory, streams output and stops on nonzero exit', async () => {
    const scripts: string[] = [];
    const { session, events } = await connect((cmd, stream) => {
      scripts.push(cmd);
      stream.write('output 日本語\n');
      stream.stderr.write('error stream\n');
      stream.exit(scripts.length === 2 ? 7 : 0);
      stream.end();
    });
    const w = { ...definition(), steps: ['echo first', 'false', 'echo NEVER'], variables: [] };
    await session.executeWorkflow(renderWorkflow(w, {}), randomUUID());
    expect(scripts).toHaveLength(2);
    expect(scripts[0]).toContain('"$HOME"/');
    const updates = events.filter((e) => e.type === 'workflow').map((e) => e.update);
    expect(updates.at(-1)).toMatchObject({ status: 'failed', step: 1 });
    expect(updates.map((u) => u.output ?? '').join('')).toContain('日本語');
    expect(updates.at(-1)?.message).toContain('exit 7');
  });
  it('cancels follow mode, prevents overlapping operations, and never runs later steps', async () => {
    let started = false;
    const { session, events } = await connect((_cmd, stream) => {
      started = true;
      stream.write('following\n');
    });
    const w = { ...definition(), steps: ['follow'], variables: [], followLast: true };
    const id = randomUUID();
    const running = session.executeWorkflow(renderWorkflow(w, {}), id);
    await expect.poll(() => started).toBe(true);
    await expect(session.executeWorkflow(renderWorkflow(w, {}), randomUUID())).rejects.toThrow(
      'active',
    );
    expect(() => session.enqueue([])).toThrow('workflow');
    session.stopWorkflow(id);
    await running;
    expect(events.filter((e) => e.type === 'workflow').at(-1)?.update.status).toBe('stopped');
    expect(() => session.stopWorkflow(id)).toThrow('no longer');
  });
  it('bounds output and reports an uncertain result rather than continuing', async () => {
    workflowLimits.output = 16;
    const scripts: string[] = [];
    const { session, events } = await connect((cmd, stream) => {
      scripts.push(cmd);
      stream.write(Buffer.alloc(100));
    });
    await session.executeWorkflow(
      renderWorkflow({ ...definition(), variables: [], steps: ['big output', 'NEVER'] }, {}),
      randomUUID(),
    );
    expect(scripts).toHaveLength(1);
    expect(events.filter((e) => e.type === 'workflow').at(-1)?.update.message).toContain(
      'Output limit',
    );
  });
  it('invalidates old approvals and clears workflow state on disconnect', async () => {
    const { session, events } = await connect((_cmd, stream) => {
      stream.write('start');
    });
    const context = session.workflowContext();
    const id = randomUUID();
    const running = session.executeWorkflow(
      renderWorkflow({ ...definition(), variables: [], steps: ['follow'] }, {}),
      id,
    );
    await expect.poll(() => events.some((e) => e.type === 'workflow')).toBe(true);
    session.disconnect();
    await running;
    expect(context.check).toThrow('changed');
    expect(
      events.some(
        (e) => e.type === 'workflow-warning' && e.message.includes('may still be running'),
      ),
    ).toBe(true);
    expect(events.at(-1)?.type).toBe('terminal-reset');
  });
  it('reports success only after every exit status is zero', async () => {
    const { session, events } = await connect((_cmd, stream) => {
      stream.exit(0);
      stream.end();
    });
    await session.executeWorkflow(
      renderWorkflow({ ...definition(), variables: [], steps: ['one', 'two'] }, {}),
      randomUUID(),
    );
    expect(events.filter((e) => e.type === 'workflow').at(-1)?.update.status).toBe('completed');
  });
});
