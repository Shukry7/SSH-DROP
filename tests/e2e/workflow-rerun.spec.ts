import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sshFixture } from '../fixtures/ssh-server';

test('run again reviews latest definitions, clears values and never bypasses confirmation', async () => {
  test.setTimeout(90000);
  const dir = await mkdtemp(join(tmpdir(), 'sshdrop-workflow-rerun-'));
  const scripts: string[] = [];
  const fixture = await sshFixture({
    exec: (command, stream) => {
      scripts.push(command);
      if (command.includes('WAIT_FOR_STOP')) return;
      stream.write('done\n');
      stream.exit(0);
      stream.end();
    },
  });
  const env = Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  env.SSHDROP_USER_DATA_DIR = dir;
  const app = await electron.launch({ args: ['.'], env, chromiumSandbox: true });
  const approve = () =>
    app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
  try {
    await approve();
    const page = await app.firstWindow();
    await page.getByLabel('Host', { exact: true }).fill('127.0.0.1');
    await page.getByLabel('Port', { exact: true }).fill(String(fixture.port));
    await page.getByLabel('Username', { exact: true }).fill('tester');
    await page.getByLabel('Password', { exact: true }).fill('test-password');
    await page.getByRole('button', { name: 'Connect to server', exact: true }).click();
    await expect(page.getByRole('cell', { name: /hello.txt/ })).toBeVisible();
    await page.getByRole('button', { name: 'New workflow', exact: true }).click();
    await expect(
      page.getByText('Maximum runtime per command (minutes, 1–120)', { exact: true }),
    ).toBeVisible();
    await expect(page.locator('#workflow-timeout-help')).toContainText('not a delay');
    await page.getByRole('button', { name: 'Save workflow', exact: true }).click();
    await page.getByLabel('Variable message').fill('first value');
    await page.getByRole('button', { name: 'Preview workflow', exact: true }).click();
    await expect(page.locator('.workflow-preview')).toContainText('30 minutes per command');
    await page.getByRole('button', { name: 'Confirm and run workflow' }).click();
    await expect(
      page.getByRole('group', { name: 'Workflow results' }).locator('.toolbar strong'),
    ).toHaveText('Step 1: completed');
    expect(scripts).toHaveLength(1);
    const saved = await page.evaluate(async () => {
      const r = await window.sshdrop.workflows();
      if (!r.ok) throw new Error(r.error);
      return r.value[0];
    });
    await page.evaluate(async (workflow) => {
      const r = await window.sshdrop.saveWorkflow({
        ...workflow,
        steps: ['echo UPDATED {{message}}'],
      });
      if (!r.ok) throw new Error(r.error);
    }, saved);
    await page.getByLabel('Saved workflow', { exact: true }).selectOption('');
    await page.getByRole('button', { name: 'Run again', exact: true }).click();
    await expect(page.getByLabel('Saved workflow', { exact: true })).toHaveValue(saved.id);
    await expect(page.getByLabel('Variable message')).toHaveValue('');
    await expect(page.locator('.workflow-preview')).toHaveCount(0);
    expect(scripts).toHaveLength(1);
    await page.getByLabel('Variable message').fill('second value');
    await page.getByRole('button', { name: 'Preview workflow', exact: true }).click();
    await expect(page.locator('.workflow-preview')).toContainText("echo UPDATED 'second value'");
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    });
    await page.getByRole('button', { name: 'Confirm and run workflow' }).click();
    await expect(page.locator('.workflow-preview')).toHaveCount(0);
    expect(scripts).toHaveLength(1);
    await approve();
    await page.getByRole('button', { name: 'Preview workflow', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm and run workflow' }).click();
    await expect.poll(() => scripts.length).toBe(2);
    await expect(
      page.getByRole('group', { name: 'Workflow results' }).locator('.toolbar strong'),
    ).toHaveText('Step 1: completed');
    expect(scripts[1]).toContain("echo UPDATED 'second value'");
    expect(await readFile(join(dir, 'workflows.json'), 'utf8')).not.toContain('second value');
    await page.evaluate(async (workflow) => {
      const r = await window.sshdrop.saveWorkflow({
        ...workflow,
        variables: [],
        steps: ['echo WAIT_FOR_STOP'],
      });
      if (!r.ok) throw new Error(r.error);
    }, saved);
    await page.getByRole('button', { name: 'Run again', exact: true }).click();
    await expect(page.locator('.workflow-preview')).toContainText('WAIT_FOR_STOP');
    expect(scripts).toHaveLength(2);
    await page.getByRole('button', { name: 'Confirm and run workflow' }).click();
    await expect(
      page.getByRole('button', { name: 'Stop workflow / following logs' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Run again', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Stop workflow / following logs' }).click();
    await expect(page.getByRole('group', { name: 'Workflow results' })).toContainText('stopped');
    await page.getByRole('button', { name: 'Run again', exact: true }).click();
    await expect(page.locator('.workflow-preview')).toContainText('WAIT_FOR_STOP');
    expect(scripts).toHaveLength(3);
    await page.getByRole('button', { name: 'Cancel preview', exact: true }).click();
    await page.getByRole('button', { name: 'Delete workflow', exact: true }).click();
    await page.getByRole('button', { name: 'Run again', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'workflow was deleted' })).toBeVisible();
    expect(scripts).toHaveLength(3);
  } finally {
    await app.close();
    await fixture.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('confirmation opt-out is explicit, persisted and respected by run again', async () => {
  test.setTimeout(90000);
  const dir = await mkdtemp(join(tmpdir(), 'sshdrop-workflow-optout-'));
  const scripts: string[] = [];
  const fixture = await sshFixture({
    exec: (command, stream) => {
      scripts.push(command);
      if (command.includes('WAIT_FOR_STOP')) return;
      stream.write('done\n');
      stream.exit(0);
      stream.end();
    },
  });
  const env = Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  env.SSHDROP_USER_DATA_DIR = dir;
  const app = await electron.launch({ args: ['.'], env, chromiumSandbox: true });
  const approve = () =>
    app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
  try {
    await approve();
    const page = await app.firstWindow();
    await page.getByLabel('Host', { exact: true }).fill('127.0.0.1');
    await page.getByLabel('Port', { exact: true }).fill(String(fixture.port));
    await page.getByLabel('Username', { exact: true }).fill('tester');
    await page.getByLabel('Password', { exact: true }).fill('test-password');
    await page.getByRole('button', { name: 'Connect to server', exact: true }).click();
    await expect(page.getByRole('cell', { name: /hello.txt/ })).toBeVisible();

    await page.getByRole('button', { name: 'New workflow', exact: true }).click();
    const confirmation = page.getByRole('checkbox', {
      name: 'Ask for confirmation before running (recommended)',
      exact: true,
    });
    await expect(confirmation).toBeChecked();
    await confirmation.uncheck();
    await page.getByLabel('Workflow steps').fill('echo generic-check');
    await page.getByLabel('Workflow variables').fill('');
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async (...args: unknown[]) => {
        const options = args.at(-1) as import('electron').MessageBoxOptions;
        if (options.title !== 'Disable workflow run confirmation' || options.defaultId !== 0)
          throw new Error('Missing opt-out warning');
        return { response: 0, checkboxChecked: false };
      };
    });
    await page.getByRole('button', { name: 'Save workflow', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'not saved' })).toBeVisible();
    expect(await page.evaluate(async () => window.sshdrop.workflows())).toMatchObject({
      ok: true,
      value: [],
    });
    await approve();
    await page.getByRole('button', { name: 'Save workflow', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Run confirmation is off' }),
    ).toBeVisible();
    expect(
      JSON.parse(await readFile(join(dir, 'workflows.json'), 'utf8')).workflows[0].confirmBeforeRun,
    ).toBe(false);
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => {
        throw new Error('Unexpected run dialog');
      };
    });
    await page.getByRole('button', { name: 'Preview workflow', exact: true }).click();
    await page.getByRole('button', { name: 'Run workflow', exact: true }).click();
    await expect(
      page.getByRole('group', { name: 'Workflow results' }).locator('.toolbar strong'),
    ).toHaveText('Step 1: completed');
    expect(scripts).toHaveLength(1);
    await page.getByRole('button', { name: 'Run again', exact: true }).click();
    await expect.poll(() => scripts.length).toBe(2);
    await expect(
      page.getByRole('group', { name: 'Workflow results' }).locator('.toolbar strong'),
    ).toHaveText('Step 1: completed');
    await expect(page.locator('.workflow-preview')).toHaveCount(0);
    await page.getByRole('button', { name: 'Edit workflow', exact: true }).click();
    await expect(confirmation).not.toBeChecked();
    await confirmation.check();
    await page.getByRole('button', { name: 'Save workflow', exact: true }).click();
    await page.getByRole('button', { name: 'Run again', exact: true }).click();
    await expect(page.locator('.workflow-preview')).toContainText('generic-check');
    expect(scripts).toHaveLength(2);
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    });
    await page.getByRole('button', { name: 'Confirm and run workflow' }).click();
    await expect(page.locator('.workflow-preview')).toHaveCount(0);
    expect(scripts).toHaveLength(2);
  } finally {
    await app.close();
    await fixture.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
