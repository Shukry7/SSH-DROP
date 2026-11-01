import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sshFixture } from '../fixtures/ssh-server';

test('a lost transfer keeps a generic warning across reconnect without replaying or retaining its filename', async () => {
  test.setTimeout(60000);
  const directory = await mkdtemp(join(tmpdir(), 'sshdrop-transfer-ui-'));
  const source = join(directory, 'private-test-upload.bin');
  await writeFile(source, Buffer.alloc(8 * 1024 * 1024, 42));
  const fixture = await sshFixture({ slow: true });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  env.SSHDROP_USER_DATA_DIR = directory;
  const application = await electron.launch({ args: ['.'], env, chromiumSandbox: true });
  try {
    await application.evaluate(({ dialog }, path) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, source);
    const page = await application.firstWindow();
    await page.getByLabel('Host', { exact: true }).fill('127.0.0.1');
    await page.getByLabel('Username', { exact: true }).fill('tester');
    await page.getByLabel('Port', { exact: true }).fill(String(fixture.port));
    await page.getByLabel('Password', { exact: true }).fill('test-password');
    await page.getByRole('button', { name: 'Connect to server' }).click();
    await expect(page.getByRole('cell', { name: /hello.txt/ })).toBeVisible();
    await page.getByRole('button', { name: /Upload file/ }).click();
    await expect
      .poll(async () =>
        Number(await page.getByLabel('Progress for private-test-upload.bin').getAttribute('value')),
      )
      .toBeGreaterThan(0);
    expect(fixture.files.has('/private-test-upload.bin')).toBe(false);
    fixture.drop();
    await expect(page.locator('.connection-pill')).toContainText('No active connection');
    const warning = page
      .getByRole('alert')
      .filter({ hasText: 'A transfer was interrupted or needs inspection.' });
    await expect(warning).toBeVisible();
    await expect(warning).not.toContainText('private-test-upload.bin');
    await expect(page.getByRole('region', { name: 'File transfers' })).toHaveCount(0);
    await page.getByLabel('Password', { exact: true }).fill('test-password');
    await page.getByRole('button', { name: 'Connect to server' }).click();
    await expect(page.getByRole('cell', { name: /hello.txt/ })).toBeVisible();
    await expect(warning).toBeVisible();
    expect(fixture.files.has('/private-test-upload.bin')).toBe(false);
    await page.screenshot({ path: 'artifacts/transfer-interruption-warning.png' });
    await page.getByRole('button', { name: 'Dismiss transfer warning' }).click();
    await expect(warning).toHaveCount(0);
  } finally {
    await application.close();
    await fixture.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
