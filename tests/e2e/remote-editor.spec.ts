import { test, expect, _electron as electron, type Locator } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sshFixture } from '../fixtures/ssh-server';

async function expectDraft(contents: Locator, text: string) {
  await expect
    .poll(async () => (await contents.locator('.cm-line').allTextContents()).join('\n'))
    .toBe(text);
}

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
    await expectDraft(contents, 'Hello from the remote server.\n');
    await expect(editor.getByRole('combobox', { name: 'Highlighting' })).toHaveValue('plain');
    await contents.fill('x'.repeat(1048577));
    await expectDraft(contents, 'Hello from the remote server.\n');
    await expect(editor.getByRole('status')).toHaveText('No unsaved changes');
    await expect(editor.locator('.cm-lineNumbers')).toContainText('1');
    await editor.getByRole('combobox', { name: 'Highlighting' }).selectOption('javascript');
    await contents.fill('const greeting = "hello";\nconsole.log(greeting);');
    await expect(editor.locator('.cm-content .cm-line span').first()).toHaveCSS(
      'color',
      'rgb(196, 167, 255)',
    );
    await expect(editor.locator('.cm-lineNumbers')).toContainText('2');
    await contents.press('ControlOrMeta+z');
    await expectDraft(contents, 'Hello from the remote server.\n');
    await contents.press('ControlOrMeta+Shift+z');
    await expectDraft(contents, 'const greeting = "hello";\nconsole.log(greeting);');
    await page.screenshot({ path: 'artifacts/editor-highlighting.png' });
    await editor.getByRole('combobox', { name: 'Highlighting' }).selectOption('plain');
    await expectDraft(contents, 'const greeting = "hello";\nconsole.log(greeting);');
    await expect(editor.locator('.cm-content .cm-line span')).toHaveCount(0);
    await contents.fill('edited through the desktop\n');
    await contents.press('ControlOrMeta+f');
    await expect(editor.getByRole('searchbox', { name: 'Find in draft' })).toBeFocused();
    await editor.getByRole('searchbox', { name: 'Find in draft' }).fill('desktop');
    await editor.getByRole('button', { name: 'Next match' }).click();
    expect(await contents.evaluate(() => window.getSelection()?.toString())).toBe('desktop');
    await editor.getByRole('button', { name: 'Previous match' }).click();
    expect(await contents.evaluate(() => window.getSelection()?.toString())).toBe('desktop');
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
    await expectDraft(contents, 'edited through the desktop\n');
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
    await expectDraft(contents, 'second draft');
    await editor.getByRole('button', { name: 'Compare with server' }).click();
    await expect(editor.getByRole('textbox', { name: 'Reviewed server version' })).toHaveValue(
      'external update',
    );
    await expectDraft(contents, 'second draft');
    await page.screenshot({ path: 'artifacts/editor-comparison.png' });
    fixture.files.set('/hello.txt', Buffer.from('newer external update'));
    await editor.getByRole('button', { name: 'Keep my draft' }).click();
    await expect(editor.getByRole('alert')).toContainText('server changed again');
    await editor.getByRole('button', { name: 'Refresh comparison' }).click();
    await expect(editor.getByRole('textbox', { name: 'Reviewed server version' })).toHaveValue(
      'newer external update',
    );
    await editor.getByRole('button', { name: 'Keep my draft' }).click();
    await expect(editor.getByRole('textbox', { name: 'Reviewed server version' })).toHaveCount(0);
    expect(fixture.files.get('/hello.txt')?.toString()).toBe('newer external update');
    await expectDraft(contents, 'second draft');
    await editor.getByRole('button', { name: 'Save changes' }).click();
    await expect(editor.getByRole('status')).toHaveText('No unsaved changes');
    expect(fixture.files.get('/hello.txt')?.toString()).toBe('second draft');
    await contents.fill('discard only after review');
    fixture.files.set('/hello.txt', Buffer.from('reload from server'));
    await editor.getByRole('button', { name: 'Compare with server' }).click();
    await editor.getByRole('button', { name: 'Use server text' }).click();
    await expectDraft(contents, 'reload from server');
    await expect(editor.getByRole('status')).toHaveText('No unsaved changes');
    await contents.fill('draft retained after network loss');
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
