import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sshFixture } from '../fixtures/ssh-server';

test('reviews a saved upload after restart and requires a separate retry confirmation', async () => {
  test.skip(process.platform !== 'win32', 'Requires real Windows OS key protection.');
  test.setTimeout(120000);
  const dir = await mkdtemp(join(tmpdir(), 'sshdrop-saved-transfers-ui-'));
  const stall = ['WRITE'];
  const fixture = await sshFixture({ stall });
  const filename = 'saved-upload.txt';
  const local = join(dir, filename);
  const target = '/' + filename;
  await writeFile(local, 'saved bytes');
  const launch = () =>
    electron.launch({
      args: ['.'],
      chromiumSandbox: true,
      env: { ...process.env, SSHDROP_USER_DATA_DIR: join(dir, 'app') },
    });
  let app = await launch();
  try {
    const connect = async () => {
      await app.evaluate(({ dialog }, local) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [local] });
        dialog.showMessageBox = async (...args: unknown[]) => {
          const options = args.at(-1) as import('electron').MessageBoxOptions;
          if (options.title === 'Retry saved transfer') {
            const fixtureState = globalThis as typeof globalThis & {
              approveRetry?: boolean;
              retryDialog?: unknown;
            };
            fixtureState.retryDialog = options;
            return { response: fixtureState.approveRetry ? 1 : 0, checkboxChecked: false };
          }
          return { response: 1, checkboxChecked: false };
        };
      }, local);
      const page = await app.firstWindow();
      await page.getByLabel('Host', { exact: true }).fill('127.0.0.1');
      await page.getByLabel('Port', { exact: true }).fill(String(fixture.port));
      await page.getByLabel('Username', { exact: true }).fill('tester');
      await page.getByLabel('Password', { exact: true }).fill('test-password');
      await page.getByRole('button', { name: 'Connect to server', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Saved transfers' })).toBeVisible();
      return page;
    };
    let page = await connect();
    await page
      .getByRole('checkbox', { name: 'Remember new individual transfers in this connection' })
      .check();
    await page.getByRole('button', { name: /Upload files/ }).click();
    await expect.poll(() => fixture.openedFiles.some((path) => path.endsWith('.part'))).toBe(true);
    await app.close();
    stall.length = 0;
    app = await launch();
    page = await connect();
    const panel = page.getByRole('region', { name: 'Saved transfers' });
    const retry = panel.getByRole('button', { name: 'Review retry' });
    await expect(retry).toBeVisible();
    expect(fixture.files.has(target)).toBe(false);
    await retry.click();
    await expect.poll(() => app.evaluate(() => 'retryDialog' in globalThis)).toBe(true);
    expect(fixture.files.has(target)).toBe(false);
    await app.evaluate(() => Object.assign(globalThis, { approveRetry: true }));
    await retry.click();
    await expect.poll(() => fixture.files.get(target)?.toString()).toBe('saved bytes');
    await expect(retry).toHaveCount(0);
  } finally {
    await app.close();
    await fixture.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
