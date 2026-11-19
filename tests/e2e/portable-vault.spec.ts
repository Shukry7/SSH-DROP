import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sshFixture } from '../fixtures/ssh-server';

test('rotates, exports and imports a recovery vault across app data directories and restores an imported copy', async () => {
  test.setTimeout(120000);
  const directory = await mkdtemp(join(tmpdir(), 'sshdrop-vault-ui-'));
  const fixture = await sshFixture();
  const destination = join(directory, 'original.txt');
  const archive = join(directory, 'recovery.sshdrop-vault');
  const restored = join(directory, 'restored.txt');
  const passphrase = 'disposable whole vault passphrase';
  await writeFile(destination, 'earlier contents');
  const launch = async (name: string) => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    env.SSHDROP_USER_DATA_DIR = join(directory, name);
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await electron.launch({ args: ['.'], env, chromiumSandbox: true });
    await app.evaluate(
      ({ dialog, safeStorage }, { destination, mock }) => {
        if (mock) {
          safeStorage.isAsyncEncryptionAvailable = async () => true;
          safeStorage.isEncryptionAvailable = () => true;
          safeStorage.getSelectedStorageBackend = () => 'gnome_libsecret';
          safeStorage.encryptStringAsync = async (value) => Buffer.from(value);
          safeStorage.decryptStringAsync = async (value) => ({
            result: value.toString(),
            shouldReEncrypt: false,
          });
          safeStorage.encryptString = (value) => Buffer.from(value);
          safeStorage.decryptString = (value) => value.toString();
        }
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination });
        dialog.showMessageBox = async (...args: unknown[]) => {
          const options = args.at(-1) as import('electron').MessageBoxOptions;
          if (options.defaultId !== 0 || options.cancelId !== 0)
            throw new Error('Unsafe dialog default');
          return {
            response: options.title === 'File already exists' ? 2 : 1,
            checkboxChecked: false,
          };
        };
      },
      { destination, mock: process.platform !== 'win32' },
    );
    return app;
  };
  let app = await launch('source');
  const connect = async () => {
    const page = await app.firstWindow();
    await page.getByLabel('Host', { exact: true }).fill('127.0.0.1');
    await page.getByLabel('Port', { exact: true }).fill(String(fixture.port));
    await page.getByLabel('Username', { exact: true }).fill('tester');
    await page.getByLabel('Password', { exact: true }).fill('test-password');
    await page.getByRole('button', { name: 'Connect to server', exact: true }).click();
    return page;
  };
  try {
    let page = await connect();
    await page
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: /hello\.txt/ }) })
      .getByRole('button', { name: /Download/ })
      .click();
    await expect(
      page.getByRole('region', { name: 'Recovery backups' }).locator('.recovery-record'),
    ).toHaveCount(1);
    const keyFile = join(directory, 'source', 'backups', 'vault-key.json');
    const originalKey = await readFile(keyFile);
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    });
    await page.getByText('Vault tools', { exact: true }).click();
    const rotate = page.getByRole('button', { name: 'Rotate recovery vault key', exact: true });
    await rotate.click();
    await expect(rotate).toBeEnabled();
    expect(await readFile(keyFile)).toEqual(originalKey);
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async (...args: unknown[]) => {
        const options = args.at(-1) as import('electron').MessageBoxOptions;
        if (options.defaultId !== 0 || options.cancelId !== 0)
          throw new Error('Unsafe rotation default');
        return { response: 1, checkboxChecked: false };
      };
    });
    await rotate.click();
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: 'Recovery vault key rotated and all backups verified.' }),
    ).toBeVisible();
    expect(await readFile(keyFile)).not.toEqual(originalKey);
    expect(JSON.parse(await readFile(keyFile, 'utf8')).previous).toBeUndefined();
    await page.getByText('Vault tools', { exact: true }).click();
    await app.evaluate(({ dialog }, archive) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: archive });
    }, archive);
    await page.getByText('Vault tools', { exact: true }).click();
    await page.getByRole('button', { name: 'Export recovery vault', exact: true }).click();
    const exportForm = page.getByRole('dialog', { name: 'Export recovery vault' });
    await exportForm.getByLabel('Backup passphrase', { exact: true }).fill(passphrase);
    await exportForm.getByLabel('Repeat backup passphrase').fill(passphrase);
    await exportForm.getByRole('button', { name: 'Choose files' }).click();
    await expect(exportForm).toHaveCount(0);
    const bytes = await readFile(archive);
    expect(bytes.includes(Buffer.from('earlier contents'))).toBe(false);
    await app.close();
    await mkdir(join(directory, 'imported'), { recursive: true });
    app = await launch('imported');
    page = await app.firstWindow();
    await app.evaluate(({ dialog }, archive) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [archive] });
    }, archive);
    await page.getByText('Vault tools', { exact: true }).click();
    await page.getByRole('button', { name: 'Import recovery vault', exact: true }).click();
    const importForm = page.getByRole('dialog', { name: 'Import recovery vault' });
    await importForm
      .getByLabel('Backup passphrase', { exact: true })
      .fill('wrong but long enough passphrase');
    await importForm.getByRole('button', { name: 'Choose files' }).click();
    await expect(importForm.getByRole('alert')).toContainText('Wrong passphrase');
    await importForm.getByLabel('Backup passphrase', { exact: true }).fill(passphrase);
    await importForm.getByRole('button', { name: 'Choose files' }).click();
    await expect(importForm).toHaveCount(0);
    await page.getByText('Vault tools', { exact: true }).click();
    expect(await page.evaluate(() => window.sshdrop.importVault('short'))).toMatchObject({
      ok: false,
    });
    await connect();
    const recovery = page.getByRole('region', { name: 'Recovery backups' });
    await expect(recovery.locator('.recovery-record')).toHaveCount(1);
    await expect(recovery).toContainText('Imported, restore-copy only');
    await expect(recovery.getByRole('button', { name: 'Roll back', exact: true })).toBeDisabled();
    const records = await page.evaluate(() => window.sshdrop.recovery());
    if (!records.ok) throw new Error(records.error);
    const result = await page.evaluate(
      (id) => window.sshdrop.recover({ id, action: 'rollback' }),
      records.value[0].id,
    );
    expect(result).toMatchObject({ ok: false });
    await app.evaluate(({ dialog }, restored) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: restored });
    }, restored);
    await recovery.getByRole('button', { name: 'Restore copy', exact: true }).click();
    await expect.poll(() => readFile(restored, 'utf8').catch(() => '')).toBe('earlier contents');
    expect(await readFile(destination, 'utf8')).toBe('Hello from the remote server.\n');
  } finally {
    await app.close();
    await fixture.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
