import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
      dialog.showMessageBox = async () =>
        new Promise((resolve) => {
          (globalThis as unknown as { releaseTrust?: () => void }).releaseTrust = () =>
            resolve({ response: 1, checkboxChecked: false });
        });
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, source);
    const page = await application.firstWindow();
    await page.getByLabel('Host', { exact: true }).fill('127.0.0.1');
    await page.getByLabel('Username', { exact: true }).fill('tester');
    await page.getByLabel('Port', { exact: true }).fill(String(fixture.port));
    await page.getByLabel('Password', { exact: true }).fill('test-password');
    await page.getByRole('button', { name: 'Connect to server' }).click();
    await expect
      .poll(() =>
        application.evaluate(
          () => typeof (globalThis as unknown as { releaseTrust?: unknown }).releaseTrust,
        ),
      )
      .toBe('function');
    await expect(page.locator('.connection-pill')).toContainText('Connecting');
    await page.getByRole('button', { name: 'Cancel connection attempt', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Connect to server', exact: true }),
    ).toBeEnabled();
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
    await application.evaluate(async ({ dialog }) => {
      (globalThis as unknown as { releaseTrust: () => void }).releaseTrust();
      await new Promise((resolve) => setImmediate(resolve));
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    await expect(readFile(join(directory, 'known-hosts.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(fixture.shellRequests()).toBe(0);
    await page.getByLabel('Password', { exact: true }).fill('test-password');
    await page.getByRole('button', { name: 'Connect to server', exact: true }).click();
    await expect(page.getByRole('cell', { name: /hello.txt/ })).toBeVisible();
    await page.getByRole('button', { name: /Upload file/ }).click();
    await expect
      .poll(async () =>
        Number(await page.getByLabel('Progress for private-test-upload.bin').getAttribute('value')),
      )
      .toBeGreaterThan(0);
    expect(fixture.files.has('/private-test-upload.bin')).toBe(false);
    fixture.drop();
    await expect(page.locator('.connection-pill')).toContainText('Connection lost');
    const warning = page
      .getByRole('alert')
      .filter({ hasText: 'A transfer was interrupted or needs inspection.' });
    await expect(warning).toBeVisible();
    await expect(warning).not.toContainText('private-test-upload.bin');
    await expect(page.getByRole('region', { name: 'File transfers' })).toHaveCount(0);
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Host', { exact: true })).toHaveValue('127.0.0.1');
    expect(fixture.shellRequests()).toBe(1);
    await page.getByLabel('Password', { exact: true }).fill('test-password');
    await page.getByRole('button', { name: 'Reconnect to server', exact: true }).click();
    await expect(page.getByRole('cell', { name: /hello.txt/ })).toBeVisible();
    expect(fixture.shellRequests()).toBe(2);
    await expect(warning).toBeVisible();
    expect(fixture.files.has('/private-test-upload.bin')).toBe(false);
    await page.screenshot({ path: 'artifacts/transfer-interruption-warning.png' });
    await page.getByRole('button', { name: 'Dismiss transfer warning' }).click();
    await expect(warning).toHaveCount(0);
    fixture.closeShell();
    await expect(page.getByLabel('Terminal panel')).toContainText('SHELL CLOSED');
    await expect(page.locator('.connection-pill')).toContainText('tester@127.0.0.1');
    await expect(page.getByRole('cell', { name: /hello.txt/ })).toBeVisible();
    expect(await page.evaluate(() => window.sshdrop.input('echo should-not-run\n'))).toMatchObject({
      ok: false,
    });
  } finally {
    await application.close();
    await fixture.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
