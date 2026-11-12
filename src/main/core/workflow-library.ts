import { randomUUID } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import { z } from 'zod';
import { workflowSchema, renderWorkflow, type Workflow } from '../../shared/workflows';
import { readLocalData } from './local-data';

export const workflowExportLimit = 128 * 1024;
const documentSchema = z
  .object({
    format: z.literal('sshdrop-workflow'),
    version: z.literal(1),
    workflow: workflowSchema,
  })
  .strict();

export function serializeWorkflow(workflow: Workflow): string {
  return (
    JSON.stringify(
      documentSchema.parse({ format: 'sshdrop-workflow', version: 1, workflow }),
      null,
      2,
    ) + '\n'
  );
}

export async function readWorkflowImport(path: string): Promise<Workflow> {
  const { workflow } = documentSchema.parse(
    JSON.parse(await readLocalData(path, workflowExportLimit)),
  );
  renderWorkflow(
    workflow,
    Object.fromEntries(
      workflow.variables.map((variable) => [
        variable.name,
        variable.type === 'integer' ? '0' : 'example',
      ]),
    ),
  );
  return { ...workflow, id: randomUUID(), confirmBeforeRun: true };
}

export async function writeWorkflowExport(
  path: string,
  workflow: Workflow,
  check: () => void,
): Promise<void> {
  const contents = serializeWorkflow(workflow);
  if (Buffer.byteLength(contents) > workflowExportLimit)
    throw new Error('Workflow export exceeds 128 KiB.');
  check();
  const file = await open(path, 'wx', 0o600);
  try {
    check();
    await file.writeFile(contents);
    await file.sync();
    check();
  } catch (error) {
    await file.close();
    await unlink(path).catch(() => undefined);
    throw error;
  }
  await file.close();
}
