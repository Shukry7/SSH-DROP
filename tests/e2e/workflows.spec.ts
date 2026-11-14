import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sshFixture } from '../fixtures/ssh-server';
const launch = async (dir: string) => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  env.SSHDROP_USER_DATA_DIR = dir;
  return electron.launch({ args: ['.'], env, chromiumSandbox: true });
};
const connect = async (page: Page, port: number) => {
  await page.getByLabel('Host', { exact: true }).fill('127.0.0.1');
  await page.getByLabel('Port', { exact: true }).fill(String(port));
  await page.getByLabel('Username', { exact: true }).fill('tester');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Connect to server', exact: true }).click();
  await expect(page.getByRole('cell', { name: /hello.txt/ })).toBeVisible();
};
const dialogs = async (app: ElectronApplication) =>
  app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
test('opens only the selected shell folder on request and preserves manual navigation', async () => {
  test.setTimeout(60000);
  const dir = await mkdtemp(join(tmpdir(), 'sshdrop-terminal-directory-'));
  const fixture = await sshFixture();
  const app = await launch(dir);
  try {
    await dialogs(app);
    const page = await app.firstWindow();
    await connect(page, fixture.port);
    const terminal = page.getByRole('region', { name: 'Terminal panel' });
    const openFolder = terminal.getByRole('button', { name: 'Open shell folder' });
    const path = page.getByLabel('Remote directory', { exact: true });
    await expect(openFolder).toBeDisabled();
    fixture.writeTerminal(Buffer.from('\x1b]7;file://fixture/folder'));
    fixture.writeTerminal(Buffer.from('\x1b\\'));
    await expect(openFolder).toBeEnabled();
    await expect(path).toHaveValue('/');
    await terminal.getByRole('button', { name: 'New terminal' }).click();
    await expect(terminal.getByRole('tab', { name: 'Terminal 2' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(openFolder).toBeDisabled();
    fixture.writeTerminal(Buffer.from('\x1b]7;file:///missing\x07'));
    await expect(openFolder).toBeEnabled();
    await openFolder.click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(path).toHaveValue('/');
    fixture.writeTerminal(Buffer.from('\x1b]7;https://fixture/folder\x07'));
    await expect(openFolder).toBeDisabled();
    await terminal.getByRole('tab', { name: 'Terminal 1' }).click();
    await openFolder.click();
    await expect(path).toHaveValue('/folder');
    await expect(page.getByRole('cell', { name: /nested\.txt/ })).toBeVisible();
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(openFolder).toHaveCount(0);
  } finally {
    await app.close();
    await fixture.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
test('terminal tabs preserve output, confirm closing, and clear on disconnect', async () => {
  test.setTimeout(60000);
  const dir = await mkdtemp(join(tmpdir(), 'sshdrop-terminal-tabs-'));
  const fixture = await sshFixture();
  const app = await launch(dir);
  try {
    await dialogs(app);
    const page = await app.firstWindow();
    await connect(page, fixture.port);
    const terminal = page.getByRole('region', { name: 'Terminal panel' });
    const first = terminal.getByRole('tab', { name: 'Terminal 1', exact: true });
    const second = terminal.getByRole('tab', { name: 'Terminal 2', exact: true });
    const visibleRows = terminal.getByRole('tabpanel').locator('.xterm-rows');
    fixture.writeTerminal(Buffer.from('FIRST-TAB-OUTPUT\r\n'));
    await expect(visibleRows).toContainText('FIRST-TAB-OUTPUT');
    await terminal.getByRole('button', { name: 'New terminal' }).click();
    await expect(second).toHaveAttribute('aria-selected', 'true');
    fixture.writeTerminal(Buffer.from('SECOND-TAB-OUTPUT\r\n'));
    await expect(visibleRows).toContainText('SECOND-TAB-OUTPUT');
    await expect(visibleRows).not.toContainText('FIRST-TAB-OUTPUT');
    await second.focus();
    await second.press('ArrowLeft');
    await expect(first).toBeFocused();
    await expect(visibleRows).toContainText('FIRST-TAB-OUTPUT');
    await expect(visibleRows).not.toContainText('SECOND-TAB-OUTPUT');
    await second.click();
    await terminal.getByRole('button', { name: 'Close terminal' }).click();
    await terminal.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(second).toBeVisible();
    await terminal.getByRole('button', { name: 'Close terminal' }).click();
    await terminal.getByRole('button', { name: 'Close shell', exact: true }).click();
    await expect(second).toHaveCount(0);
    await expect(first).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('cell', { name: /hello.txt/ })).toBeVisible();
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(terminal.getByRole('tab')).toHaveCount(0);
    await expect(terminal.locator('.xterm-rows')).not.toContainText('FIRST-TAB-OUTPUT');
  } finally {
    await app.close();
    await fixture.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
test('workflow library filters, duplicates and imports reviewed definitions without executing them', async () => {
  test.setTimeout(60000);
  const dir = await mkdtemp(join(tmpdir(), 'sshdrop-library-ui-'));
  const exportPath = join(dir, 'export.json');
  let app = await launch(dir);
  try {
    let page = await app.firstWindow();
    await dialogs(app);
    await page.getByRole('button', { name: 'New workflow', exact: true }).click();
    await page.getByLabel('Workflow name', { exact: true }).fill('Service status');
    await page.getByLabel('Workflow group name', { exact: true }).fill('Operations');
    await page.getByRole('button', { name: 'Save workflow', exact: true }).click();
    await page.getByRole('button', { name: 'Duplicate workflow', exact: true }).click();
    await expect(page.getByLabel('Workflow name', { exact: true })).toHaveValue(
      'Service status (copy)',
    );
    await expect(
      page.getByRole('checkbox', {
        name: 'Ask for confirmation before running (recommended)',
        exact: true,
      }),
    ).toBeChecked();
    await page.getByLabel('Workflow group name', { exact: true }).fill('Examples');
    await page.getByRole('button', { name: 'Save workflow', exact: true }).click();
    const select = page.getByLabel('Saved workflow', { exact: true });
    await expect(select.locator('option')).toHaveCount(3);
    await page.getByLabel('Search workflows', { exact: true }).fill('(copy)');
    await expect(select.locator('option')).toHaveCount(2);
    await page.getByLabel('Search workflows', { exact: true }).fill('');
    await page.getByLabel('Workflow group', { exact: true }).selectOption('Operations');
    await expect(select.locator('option')).toHaveCount(2);
    await select.selectOption({ label: 'Service status' });
    await app.evaluate(({ dialog }, exportPath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: exportPath });
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [exportPath] });
      dialog.showMessageBox = async (...args: unknown[]) => {
        Object.assign(globalThis, { libraryWarning: args.at(-1) });
        return { response: 1, checkboxChecked: false };
      };
    }, exportPath);
    await page.getByRole('button', { name: 'Export workflow', exact: true }).click();
    await expect
      .poll(() => readFile(exportPath, 'utf8').catch(() => ''))
      .toContain('sshdrop-workflow');
    expect(
      await app.evaluate(
        () => (globalThis as unknown as { libraryWarning: unknown }).libraryWarning,
      ),
    ).toMatchObject({
      defaultId: 0,
      cancelId: 0,
      detail: expect.stringContaining('readable text'),
    });
    const exported = JSON.parse(await readFile(exportPath, 'utf8'));
    exported.workflow.confirmBeforeRun = false;
    await writeFile(exportPath, JSON.stringify(exported));
    const before = await readFile(join(dir, 'workflows.json'), 'utf8');
    await page.getByRole('button', { name: 'Import workflow', exact: true }).click();
    await expect(page.getByText(/Review every imported command/)).toBeVisible();
    await expect(
      page.getByRole('checkbox', {
        name: 'Ask for confirmation before running (recommended)',
        exact: true,
      }),
    ).toBeChecked();
    expect(await readFile(join(dir, 'workflows.json'), 'utf8')).toBe(before);
    await page.getByLabel('Workflow name', { exact: true }).fill('Reviewed import');
    await page.getByRole('button', { name: 'Save workflow', exact: true }).click();
    await expect(select.locator('option')).toHaveCount(4);
    const stored = JSON.parse(await readFile(join(dir, 'workflows.json'), 'utf8')).workflows;
    expect(new Set(stored.map((item: { id: string }) => item.id)).size).toBe(3);
    expect(
      stored.find((item: { name: string }) => item.name === 'Reviewed import').confirmBeforeRun,
    ).toBe(true);
    await app.close();
    app = await launch(dir);
    page = await app.firstWindow();
    await page.getByLabel('Workflow group', { exact: true }).selectOption('Examples');
    await expect(page.getByLabel('Saved workflow', { exact: true }).locator('option')).toHaveCount(
      2,
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('saved workflows preview literal variables, require confirmation, fail-stop, persist globally and delete', async () => {
  test.setTimeout(90000);
  const dir = await mkdtemp(join(tmpdir(), 'sshdrop-workflow-ui-'));
  const scripts: string[] = [];
  const fixture = await sshFixture({
    exec: (command, stream) => {
      scripts.push(command);
      stream.write('reviewed results\n');
      stream.exit(command.includes('false') ? 7 : 0);
      stream.end();
    },
  });
  let app = await launch(dir);
  try {
    await dialogs(app);
    let page = await app.firstWindow();
    await connect(page, fixture.port);
    await page.getByRole('button', { name: 'Example workflow', exact: true }).click();
    await expect(page.getByLabel('Workflow working directory')).toHaveValue('~');
    await expect(page.getByLabel('Workflow steps')).toHaveValue(
      "pwd\nuname -s\nprintf '%s\\n' {{message}}",
    );
    await page.getByRole('button', { name: 'Cancel edit', exact: true }).click();
    await page.getByRole('button', { name: 'New workflow', exact: true }).click();
    await page.getByLabel('Workflow name', { exact: true }).fill('User checks');
    await page.getByLabel('Workflow working directory').fill('/srv/sample-app');
    await page.getByLabel('Workflow steps').fill('echo {{user_id}}\nfalse\necho NEVER');
    await page.getByLabel('Workflow variables').fill('user_id:text:User ID');
    await page.getByRole('button', { name: 'Save workflow', exact: true }).click();
    const value = '15; touch /NEVER';
    await page.getByLabel('Variable user_id').fill(value);
    await page.getByRole('button', { name: 'Preview workflow', exact: true }).click();
    await expect(page.locator('.workflow-preview')).toContainText("echo '15; touch /NEVER'");
    await page.locator('.workflow-preview').scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'artifacts/workflow-preview.png' });
    expect(scripts).toHaveLength(0);
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async (...args: unknown[]) => {
        const options = args.at(-1) as import('electron').MessageBoxOptions;
        if (
          options.defaultId !== 0 ||
          options.cancelId !== 0 ||
          !options.detail?.includes("echo '15; touch /NEVER'")
        )
          throw new Error('Unsafe preview');
        return { response: 0, checkboxChecked: false };
      };
    });
    await page.getByRole('button', { name: 'Confirm and run workflow' }).click();
    await expect(page.locator('.workflow-preview')).toHaveCount(0);
    expect(scripts).toHaveLength(0);
    await dialogs(app);
    await page.getByRole('button', { name: 'Preview workflow', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm and run workflow' }).click();
    await expect(page.getByRole('group', { name: 'Workflow results' })).toContainText('failed');
    expect(scripts).toHaveLength(2);
    expect(scripts[0]).toContain("echo '15; touch /NEVER'");
    await page.getByRole('button', { name: 'Run again', exact: true }).click();
    await expect(page.getByLabel('Variable user_id')).toHaveValue('');
    await expect(page.getByRole('status').filter({ hasText: 'Run again starts' })).toBeVisible();
    expect(scripts).toHaveLength(2);
    expect(await readFile(join(dir, 'workflows.json'), 'utf8')).not.toContain(value);
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(page.getByRole('group', { name: 'Workflow results' })).toHaveCount(0);
    await expect(page.getByLabel('Variable user_id')).toHaveValue('');
    await app.close();
    app = await launch(dir);
    page = await app.firstWindow();
    await dialogs(app);
    await page.getByLabel('Saved workflow', { exact: true }).selectOption({ label: 'User checks' });
    await expect(page.getByLabel('Variable user_id')).toHaveValue('');
    await page.getByRole('button', { name: 'Edit workflow', exact: true }).click();
    await page.getByLabel('Workflow name', { exact: true }).fill('User checks edited');
    await page.getByRole('button', { name: 'Save workflow', exact: true }).click();
    await expect(
      page.getByLabel('Saved workflow', { exact: true }).locator('option:checked'),
    ).toHaveText('User checks edited');
    await page.getByRole('button', { name: 'Delete workflow', exact: true }).click();
    await expect(page.getByLabel('Saved workflow', { exact: true }).locator('option')).toHaveCount(
      1,
    );
  } finally {
    await app.close();
    await fixture.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
test('stale workflow confirmation cannot execute after reconnect and unsafe IPC is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sshdrop-workflow-stale-'));
  let executions = 0;
  const fixture = await sshFixture({
    exec: (_cmd, s) => {
      executions++;
      s.exit(0);
      s.end();
    },
  });
  const app = await launch(dir);
  try {
    await dialogs(app);
    const page = await app.firstWindow();
    await connect(page, fixture.port);
    await page.getByRole('button', { name: 'New workflow', exact: true }).click();
    await page.getByRole('button', { name: 'Save workflow', exact: true }).click();
    await page.getByLabel('Variable message').fill('15');
    await page.getByRole('button', { name: 'Preview workflow', exact: true }).click();
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () =>
        new Promise((resolve) => {
          (globalThis as unknown as { releaseWorkflow?: () => void }).releaseWorkflow = () =>
            resolve({ response: 1, checkboxChecked: false });
        });
    });
    await page.getByRole('button', { name: 'Confirm and run workflow' }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () => typeof (globalThis as unknown as { releaseWorkflow?: unknown }).releaseWorkflow,
        ),
      )
      .toBe('function');
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await dialogs(app);
    await connect(page, fixture.port);
    await app.evaluate(() => {
      (globalThis as unknown as { releaseWorkflow: () => void }).releaseWorkflow();
    });
    await expect(page.getByRole('alert').filter({ hasText: 'connection changed' })).toBeVisible();
    expect(executions).toBe(0);
    const saved = await page.evaluate(async () => {
      const r = await window.sshdrop.workflows();
      if (!r.ok) throw new Error(r.error);
      return r.value[0];
    });
    const oldPreview = await page.evaluate(
      async (id) => window.sshdrop.previewWorkflow({ id, values: { message: 'sample text' } }),
      saved.id,
    );
    expect(oldPreview.ok).toBe(true);
    await page.evaluate(
      async (w) => window.sshdrop.saveWorkflow({ ...w, steps: ['echo changed'] }),
      saved,
    );
    if (oldPreview.ok)
      expect(
        await page.evaluate((token) => window.sshdrop.runWorkflow(token), oldPreview.value.token),
      ).toMatchObject({ ok: false });
    expect(executions).toBe(0);
    expect(
      await page.evaluate(() => window.sshdrop.runWorkflow('arbitrary command')),
    ).toMatchObject({ ok: false });
    expect(
      await page.evaluate(() => window.sshdrop.previewWorkflow({ id: '../../file', values: {} })),
    ).toMatchObject({ ok: false });
  } finally {
    await app.close();
    await fixture.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
test('terminal screen fits fully after viewport and font layout changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sshdrop-terminal-fit-'));
  const fixture = await sshFixture();
  const app = await launch(dir);
  try {
    await dialogs(app);
    const page = await app.firstWindow();
    await connect(page, fixture.port);
    fixture.writeTerminal(
      Buffer.from(
        Array.from({ length: 80 }, (_, i) => `log row ${i}\r\n`).join('') + 'BOTTOM-ROW-MARKER',
      ),
    );
    await expect(page.locator('.xterm-rows')).toContainText('BOTTOM-ROW-MARKER');
    for (const [width, height] of [
      [1000, 700],
      [1440, 940],
      [1100, 720],
    ]) {
      await page.setViewportSize({ width, height });
      await page.getByLabel('Terminal panel', { exact: true }).scrollIntoViewIfNeeded();
      await expect
        .poll(() =>
          page.evaluate(() => {
            const panel = document.querySelector('.terminal-container')!.getBoundingClientRect();
            const surface = document.querySelector('.terminal-surface')!.getBoundingClientRect();
            const screen = document.querySelector('.xterm-screen')!.getBoundingClientRect();
            return (
              screen.height > 0 &&
              screen.bottom <= surface.bottom + 1 &&
              surface.bottom <= panel.bottom + 1 &&
              screen.right <= surface.right + 1
            );
          }),
        )
        .toBe(true);
    }
    await expect.poll(() => fixture.getSize().rows).toBeGreaterThan(5);
    await page.screenshot({ path: 'artifacts/terminal-fit.png' });
  } finally {
    await app.close();
    await fixture.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
