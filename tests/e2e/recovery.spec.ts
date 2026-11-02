import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sshFixture } from '../fixtures/ssh-server';

test('desktop confirms replacement, guards rollback, restores a copy and hides recovery on disconnect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sshdrop-recovery-ui-'));
  const fixture = await sshFixture({ atomicReplace: true });
  const destination = join(directory, 'local-original.txt');
  await writeFile(destination, 'local original');
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  env.SSHDROP_USER_DATA_DIR = directory;
  delete env.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({ args: ['.'], env, chromiumSandbox: true });
  try {
    await application.evaluate(({ dialog }, destination) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination });
      dialog.showMessageBox = async (...args: unknown[]) => {
        const options = args.at(-1) as import('electron').MessageBoxOptions;
        if (options.title === 'File already exists') {
          if (
            options.defaultId !== 0 ||
            options.cancelId !== 0 ||
            !options.detail?.includes('unencrypted')
          )
            throw new Error('Unsafe conflict confirmation');
          return { response: 2, checkboxChecked: false };
        }
        return { response: 1, checkboxChecked: false };
      };
    }, destination);
    const page = await application.firstWindow();
    await page.getByLabel('Host', { exact: true }).fill('127.0.0.1');
    await page.getByLabel('Port', { exact: true }).fill(String(fixture.port));
    await page.getByLabel('Username', { exact: true }).fill('tester');
    await page.getByLabel('Password', { exact: true }).fill('test-password');
    await page.getByRole('button', { name: 'Connect to server' }).click();
    const recovery = page.getByRole('region', { name: 'Recovery backups' });
    await expect(recovery).toBeVisible();
    await page
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: /hello\.txt/ }) })
      .getByRole('button', { name: 'Download' })
      .click();
    await expect(recovery.locator('.recovery-record')).toHaveCount(1);
    await expect(recovery).toContainText('completed');
    expect(await readFile(destination, 'utf8')).toBe('Hello from the remote server.\n');
    await writeFile(destination, 'external edit');
    await recovery.getByRole('button', { name: 'Roll back' }).click();
    await expect(page.getByRole('alert')).toContainText('destination changed');
    expect(await readFile(destination, 'utf8')).toBe('external edit');
    await recovery.getByRole('button', { name: 'Inspect', exact: true }).click();
    await expect(recovery).toContainText('uncertain');
    await expect(recovery.getByRole('button', { name: 'Roll back' })).toBeDisabled();
    await recovery.getByRole('button', { name: 'Restore copy' }).click();
    await expect
      .poll(async () => (await readdir(directory)).filter((name) => name.includes('(copy ')).length)
      .toBe(1);
    const copy = (await readdir(directory)).find((name) => name.includes('(copy '))!;
    await expect.poll(async () => readFile(join(directory, copy), 'utf8')).toBe('local original');
    expect(await readFile(destination, 'utf8')).toBe('external edit');
    const forged = await page.evaluate(() =>
      window.sshdrop.recover({ id: 'not-a-uuid', action: 'rollback' }),
    );
    expect(forged.ok).toBe(false);
    await expect(recovery.getByRole('button', { name: 'Restore copy' })).toBeEnabled();
    await application.evaluate(({ dialog }, destination) => {
      dialog.showMessageBox = () =>
        new Promise((_resolve, reject) => {
          Object.assign(globalThis, {
            rejectRecoveryDialog: () => reject(new Error(`Stale recovery path: ${destination}`)),
          });
        });
    }, destination);
    await recovery.getByRole('button', { name: 'Restore copy' }).click();
    await expect
      .poll(() =>
        application.evaluate(
          () =>
            typeof (globalThis as unknown as { rejectRecoveryDialog?: unknown })
              .rejectRecoveryDialog,
        ),
      )
      .toBe('function');
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(recovery).toHaveCount(0);
    await application.evaluate(() =>
      (globalThis as unknown as { rejectRecoveryDialog(): void }).rejectRecoveryDialog(),
    );
    // Round-trip after the late rejection so its IPC response has been delivered.
    await page.evaluate(() => window.sshdrop.info());
    await expect(page.getByRole('alert')).toHaveCount(1);
    await expect(page.getByRole('alert')).toContainText('This notice contains no filenames');
    await expect(page.getByRole('button', { name: 'Dismiss error', exact: true })).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('Stale recovery path');
    await expect(page.locator('body')).not.toContainText(destination);
  } finally {
    await application.close();
    await fixture.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
