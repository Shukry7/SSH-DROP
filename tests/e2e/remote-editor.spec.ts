import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sshFixture } from '../fixtures/ssh-server';

test('remote editor protects drafts, verifies saves and refuses external edits', async () => {
  test.setTimeout(60000);
  const directory = await mkdtemp(join(tmpdir(), 'sshdrop-editor-ui-'));
  const fixture = await sshFixture({ atomicReplace: true });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  env.SSHDROP_USER_DATA_DIR = directory;
  const application = await electron.launch({ args: ['.'], env, chromiumSandbox: true });
  try {
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async (...args: unknown[]) => {
        const options = args.at(-1) as import('electron').MessageBoxOptions;
        Object.assign(globalThis, { editorWarning: options });
        return {
          response:
            options.title === 'Save edited remote file'
              ? 2
              : options.title === 'Unsaved editor changes'
                ? 0
                : 1,
          checkboxChecked: false,
        };
      };
    });
    const page = await application.firstWindow();
    await page.getByLabel('Host', { exact: true }).fill('127.0.0.1');
    await page.getByLabel('Port', { exact: true }).fill(String(fixture.port));
    await page.getByLabel('Username', { exact: true }).fill('tester');
    await page.getByLabel('Password', { exact: true }).fill('test-password');
    await page.getByRole('button', { name: 'Connect to server', exact: true }).click();
    const row = page
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: /hello\.txt/ }) });
    await row.getByRole('button', { name: 'Edit text', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Edit remote text file' });
    const contents = editor.getByRole('textbox', { name: 'Remote file contents' });
    await expect(contents).toHaveValue('Hello from the remote server.\n');
    await contents.fill('edited through the desktop\n');
    await editor.getByRole('button', { name: 'Close editor' }).click();
    await expect(editor.getByText('Discard this unsaved draft?')).toBeVisible();
    await editor.getByRole('button', { name: 'Keep editing' }).click();
    await application.evaluate(({ app }) => app.quit());
    await expect
      .poll(() =>
        application.evaluate(
          () => (globalThis as unknown as { editorWarning: { title: string } }).editorWarning.title,
        ),
      )
      .toBe('Unsaved editor changes');
    await expect(contents).toHaveValue('edited through the desktop\n');
    await editor.getByRole('button', { name: 'Save changes' }).click();
    await expect(editor.getByRole('status')).toHaveText('No unsaved changes');
    expect(fixture.files.get('/hello.txt')?.toString()).toBe('edited through the desktop\n');
    expect(
      await application.evaluate(
        () => (globalThis as unknown as { editorWarning: unknown }).editorWarning,
      ),
    ).toMatchObject({
      title: 'Save without recovery backup',
      defaultId: 0,
      cancelId: 0,
    });
    await contents.fill('second draft');
    fixture.files.set('/hello.txt', Buffer.from('external update'));
    await editor.getByRole('button', { name: 'Save changes' }).click();
    await expect(editor.getByRole('alert')).toContainText('remote file changed');
    expect(fixture.files.get('/hello.txt')?.toString()).toBe('external update');
    await expect(contents).toHaveValue('second draft');
    fixture.drop();
    await expect(editor.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    await editor.getByRole('button', { name: 'Close editor' }).click();
    await editor.getByRole('button', { name: 'Discard draft' }).click();
    await expect(editor).not.toBeVisible();
  } finally {
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().forEach((window) => window.destroy()),
    );
    await application.close();
    await fixture.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
