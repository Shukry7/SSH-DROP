import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readWorkflowImport,
  serializeWorkflow,
  workflowExportLimit,
  writeWorkflowExport,
} from '../../src/main/core/workflow-library';
import { WorkflowStore } from '../../src/main/core/workflow-store';
import type { Workflow } from '../../src/shared/workflows';

const workflow = (): Workflow => ({
  id: randomUUID(),
  name: 'Status check',
  description: 'Show a generic message',
  group: 'Operations',
  directory: '~',
  steps: ["printf '%s\\n' {{message}}"],
  variables: [{ name: 'message', type: 'text', label: 'Message' }],
  minutes: 1,
  followLast: false,
  confirmBeforeRun: false,
});

describe('reviewable workflow definition files', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'sshdrop-workflow-library-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('round-trips grouped definitions with a new ID and confirmation enabled without saving', async () => {
    const original = workflow();
    const file = join(directory, 'export.json');
    await writeWorkflowExport(file, original, () => {});
    const imported = await readWorkflowImport(file);
    expect(imported).toEqual({ ...original, id: expect.any(String), confirmBeforeRun: true });
    expect(imported.id).not.toBe(original.id);
    const store = new WorkflowStore(join(directory, 'workflows.json'));
    expect(await store.list()).toEqual([]);
    await store.save(original);
    await store.save(imported);
    expect(await store.list()).toHaveLength(2);
  });
  it('keeps an existing export file intact and removes incomplete cancelled exports', async () => {
    const file = join(directory, 'export.json');
    await writeFile(file, 'existing');
    await expect(writeWorkflowExport(file, workflow(), () => {})).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(await readFile(file, 'utf8')).toBe('existing');
    let checks = 0;
    const cancelled = join(directory, 'cancelled.json');
    await expect(
      writeWorkflowExport(cancelled, workflow(), () => {
        if (++checks === 2) throw new Error('workspace changed');
      }),
    ).rejects.toThrow('workspace changed');
    await expect(readFile(cancelled)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects oversized, unsupported and malformed imports without changing saved definitions', async () => {
    const file = join(directory, 'export.json');
    const invalid = [
      'x'.repeat(workflowExportLimit + 1),
      JSON.stringify({ format: 'sshdrop-workflow', version: 2, workflow: workflow() }),
      serializeWorkflow(workflow()).replace(
        '"group": "Operations"',
        '"group": "Operations", "password": "example"',
      ),
      serializeWorkflow({ ...workflow(), steps: ['echo "{{message}}"'] }),
    ];
    for (const contents of invalid) {
      await writeFile(file, contents);
      await expect(readWorkflowImport(file)).rejects.toThrow();
    }
    expect(await new WorkflowStore(join(directory, 'workflows.json')).list()).toEqual([]);
  });
  it('reads legacy definitions without groups and persists new group assignments', async () => {
    const legacy = workflow();
    delete legacy.group;
    const file = join(directory, 'workflows.json');
    await writeFile(file, JSON.stringify({ version: 1, workflows: [legacy] }));
    const store = new WorkflowStore(file);
    expect((await store.list())[0].group).toBeUndefined();
    await store.save({ ...legacy, group: 'Operations' });
    expect((await new WorkflowStore(file).list())[0].group).toBe('Operations');
  });
});
