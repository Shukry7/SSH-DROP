import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sshFixture } from '../fixtures/ssh-server';

test('connection tabs isolate files, shell output, drafts and delayed uploads', async () => {
  test.setTimeout(120000);
  const root = await mkdtemp(join(tmpdir(), 'sshdrop-connection-tabs-'));
  const local = join(root, 'tab-one-upload.txt');
  await writeFile(local, 'tab one payload');
  const first = await sshFixture({ atomicReplace: true });
  const second = await sshFixture({ atomicReplace: true });
  first.files.set('/first-only.txt', Buffer.from('first file'));
  second.files.set('/second-only.txt', Buffer.from('second file'));
  const app = await electron.launch({
    args: ['.'],
    chromiumSandbox: true,
    env: { ...process.env, SSHDROP_USER_DATA_DIR: root },
  });
  try {
    await app.evaluate(({ dialog }, local) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      dialog.showOpenDialog = async () => {
        await new Promise<void>((resolve) =>
          Object.assign(globalThis, { finishTabPicker: resolve }),
        );
        return { canceled: false, filePaths: [local] };
      };
    }, local);
    let page = await app.firstWindow();
    const connect = async (port: number, filename: string) => {
      const workspace = page.locator('.connection-workspace:visible');
      await workspace.getByLabel('Host', { exact: true }).fill('127.0.0.1');
      await workspace.getByLabel('Port', { exact: true }).fill(String(port));
      await workspace.getByLabel('Username', { exact: true }).fill('tester');
      await workspace.getByLabel('Password', { exact: true }).fill('test-password');
      await page.getByRole('button', { name: 'Connect to server', exact: true }).click();
      await expect(page.getByRole('cell', { name: new RegExp(filename) })).toBeVisible();
    };
    const tab = (index: number) =>
      page
        .getByRole('tablist', { name: 'SSH connections' })
        .getByRole('tab', { name: new RegExp(`^Connection ${index}( |$)`) });
    await connect(first.port, 'first-only');
    await page.getByRole('button', { name: 'New connection tab' }).click();
    await expect(tab(2)).toHaveAttribute('aria-selected', 'true');
    await connect(second.port, 'second-only');
    await expect(page.locator('.xterm-rows:visible')).toContainText('fixture-ready');
    await tab(1).click();
    await expect(page.locator('.xterm-rows:visible')).toContainText('fixture-ready');
    await tab(2).click();
    first.writeTerminal(Buffer.from('output-from-first\r\n'));
    second.writeTerminal(Buffer.from('output-from-second\r\n'));
    const terminal = () => page.locator('.xterm-rows:visible');
    await expect(terminal()).toContainText('output-from-second');
    await expect(terminal()).not.toContainText('output-from-first');
    await tab(1).click();
    await expect(terminal()).toContainText('output-from-first');
    await expect(page.getByRole('cell', { name: /second-only/ })).toHaveCount(0);
    await page
      .getByRole('row')
      .filter({ hasText: 'first-only.txt' })
      .getByRole('button', { name: 'Edit text', exact: true })
      .click();
    const editor = page.getByRole('dialog', { name: 'Edit remote text file' });
    await editor.getByRole('textbox', { name: 'Remote file contents' }).fill('first tab draft');
    await editor.getByRole('button', { name: 'Back to files' }).click();
    await page.getByRole('button', { name: /Upload files/ }).click();
    await expect.poll(() => app.evaluate(() => 'finishTabPicker' in globalThis)).toBe(true);
    await tab(2).click();
    await app.evaluate(() =>
      (globalThis as unknown as { finishTabPicker: () => void }).finishTabPicker(),
    );
    await expect
      .poll(() => first.files.get('/tab-one-upload.txt')?.toString())
      .toBe('tab one payload');
    expect(second.files.has('/tab-one-upload.txt')).toBe(false);
    await expect(page.getByRole('button', { name: 'Open editors (1)' })).toHaveCount(0);
    await tab(1).click();
    await page.getByRole('button', { name: 'Open editors (1)' }).click();
    await expect(editor.getByRole('textbox', { name: 'Remote file contents' })).toContainText(
      'first tab draft',
    );
    await editor.getByRole('button', { name: 'Back to files' }).click();
    await page.getByRole('button', { name: 'Close connection tab' }).click();
    await expect(tab(1)).toHaveCount(0);
    await expect(page.getByRole('cell', { name: /second-only/ })).toBeVisible();
    const stale = await page.evaluate(() => window.sshdrop.list('/'));
    expect(stale).toMatchObject({ ok: false, error: 'This connection tab is closed.' });
    const nextWindow = app.waitForEvent('window');
    await page.evaluate(() => window.sshdrop.idleEnd()).catch(() => undefined);
    page = await nextWindow;
    await expect(page.getByRole('heading', { name: 'Your session has ended' })).toBeVisible();
    await page.getByRole('button', { name: 'Return to connection screen' }).click();
    await expect(tab(1)).toBeVisible();
    await expect(tab(2)).toHaveCount(0);
    await expect(page.getByLabel('Host', { exact: true })).toHaveValue('');
  } finally {
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().forEach((window) => window.destroy()),
    );
    await app.close();
    await Promise.all([first.close(), second.close()]);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
