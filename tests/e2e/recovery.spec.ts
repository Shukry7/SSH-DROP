import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sshFixture } from '../fixtures/ssh-server';

test('Windows OS key protection wraps and unwraps a disposable value without plaintext fallback', async () => {
  test.skip(
    process.platform !== 'win32',
    'Real Linux/macOS keychains require interactive device validation.',
  );
  const directory = await mkdtemp(join(tmpdir(), 'sshdrop-os-key-'));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  env.SSHDROP_USER_DATA_DIR = directory;
  delete env.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({ args: ['.'], env, chromiumSandbox: true });
  try {
    const result = await application.evaluate(async ({ safeStorage }) => {
      const available = await safeStorage.isAsyncEncryptionAvailable();
      if (!available) return { available, verified: false, exposed: false };
      const probe = 'Disposable SSHDrop OS key-store verification';
      const wrapped = await safeStorage.encryptStringAsync(probe);
      const unwrapped = await safeStorage.decryptStringAsync(wrapped);
      return {
        available,
        verified: unwrapped.result === probe,
        exposed: wrapped.includes(Buffer.from(probe)),
      };
    });
    expect(result).toEqual({ available: true, verified: true, exposed: false });
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('desktop confirms replacement, guards rollback, restores a copy and hides recovery on disconnect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sshdrop-recovery-ui-'));
  const fixture = await sshFixture({ atomicReplace: true });
  const destination = join(directory, 'local-original.txt');
  const portable = join(directory, 'test.sshdrop-backup');
  const restored = join(directory, 'portable-copy.txt');
  const backupPassphrase = 'test-only portable backup passphrase';
  const appData = join(directory, 'app-data');
  await writeFile(destination, 'local original');
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  env.SSHDROP_USER_DATA_DIR = appData;
  delete env.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({ args: ['.'], env, chromiumSandbox: true });
  try {
    await application.evaluate(
      ({ dialog, safeStorage }, { destination, mockKeyStore }) => {
        // Exercise real Windows protection. Linux/macOS CI has no interactive keychain.
        // Production still refuses unavailable/plaintext OS providers.
        if (mockKeyStore) {
          safeStorage.isAsyncEncryptionAvailable = async () => true;
          safeStorage.isEncryptionAvailable = () => true;
          safeStorage.getSelectedStorageBackend = () => 'gnome_libsecret';
          safeStorage.encryptStringAsync = async (value) => Buffer.from(value, 'utf8');
          safeStorage.decryptStringAsync = async (value) => ({
            result: value.toString('utf8'),
            shouldReEncrypt: false,
          });
          safeStorage.encryptString = (value) => Buffer.from(value, 'utf8');
          safeStorage.decryptString = (value) => value.toString('utf8');
        }
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination });
        dialog.showMessageBox = async (...args: unknown[]) => {
          const options = args.at(-1) as import('electron').MessageBoxOptions;
          if (options.title === 'File already exists') {
            if (
              options.defaultId !== 0 ||
              options.cancelId !== 0 ||
              !options.detail?.includes('encrypted')
            )
              throw new Error('Unsafe conflict confirmation');
            return { response: 2, checkboxChecked: false };
          }
          return { response: 1, checkboxChecked: false };
        };
      },
      { destination, mockKeyStore: process.platform !== 'win32' },
    );
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
    await expect(recovery).toContainText('Encrypted');
    const stored = await readdir(join(appData, 'backups'));
    expect(stored).toContain('recovery.enc');
    expect(stored.some((name) => name.endsWith('.bak'))).toBe(false);
    expect(await readFile(destination, 'utf8')).toBe('Hello from the remote server.\n');
    await application.evaluate(({ safeStorage }) => {
      safeStorage.isAsyncEncryptionAvailable = async () => false;
      safeStorage.isEncryptionAvailable = () => false;
    });
    await recovery.getByRole('button', { name: 'Restore copy' }).click();
    await expect(page.getByRole('alert')).toContainText('preserved');
    expect((await readdir(directory)).some((name) => name.includes('(copy '))).toBe(false);
    await application.evaluate(({ safeStorage }) => {
      safeStorage.isAsyncEncryptionAvailable = async () => true;
      safeStorage.isEncryptionAvailable = () => true;
    });
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
    await application.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
      dialog.showMessageBox = async (...args: unknown[]) => {
        const options = args.at(-1) as import('electron').MessageBoxOptions;
        if (
          options.title !== 'Export encrypted backup' ||
          options.defaultId !== 0 ||
          !options.detail?.includes(filePath)
        )
          throw new Error('Export warning missing');
        return { response: 1, checkboxChecked: false };
      };
    }, portable);
    await recovery.getByRole('button', { name: 'Export encrypted backup', exact: true }).click();
    const exportForm = page.getByRole('dialog', { name: 'Export encrypted backup' });
    await exportForm.getByLabel('Backup passphrase', { exact: true }).fill(backupPassphrase);
    await exportForm.getByLabel('Repeat backup passphrase').fill('mismatched test passphrase');
    await exportForm.getByRole('button', { name: 'Choose files' }).click();
    await expect(exportForm.getByRole('alert')).toContainText('do not match');
    await expect(readFile(portable)).rejects.toMatchObject({ code: 'ENOENT' });
    await exportForm.getByLabel('Repeat backup passphrase').fill(backupPassphrase);
    await exportForm.getByRole('button', { name: 'Choose files' }).click();
    await expect(recovery.getByRole('status')).toContainText('Encrypted backup exported');
    const encrypted = await readFile(portable);
    expect(encrypted.includes(Buffer.from('local original'))).toBe(false);
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
    await application.evaluate(
      ({ dialog, safeStorage }, { portable, restored }) => {
        safeStorage.isAsyncEncryptionAvailable = async () => false;
        safeStorage.isEncryptionAvailable = () => false;
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [portable] });
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: restored });
        dialog.showMessageBox = async (...args: unknown[]) => {
          const options = args.at(-1) as import('electron').MessageBoxOptions;
          if (
            options.title !== 'Restore an unencrypted copy' ||
            options.defaultId !== 0 ||
            !options.detail?.includes(restored)
          )
            throw new Error('Restore warning missing');
          return { response: 1, checkboxChecked: false };
        };
      },
      { portable, restored },
    );
    await page.getByRole('button', { name: 'Open portable backup', exact: true }).click();
    const restoreForm = page.getByRole('dialog', { name: 'Open portable backup' });
    await restoreForm.getByLabel('Backup passphrase').fill('wrong test portable passphrase');
    await restoreForm.getByRole('button', { name: 'Choose files' }).click();
    await expect(restoreForm.getByRole('alert')).toContainText('Wrong passphrase or damaged');
    await expect(readFile(restored)).rejects.toMatchObject({ code: 'ENOENT' });
    await restoreForm.getByLabel('Backup passphrase').fill(backupPassphrase);
    await restoreForm.getByRole('button', { name: 'Choose files' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Restored to a new local copy' }),
    ).toBeVisible();
    expect(await readFile(restored, 'utf8')).toBe('local original');
    expect(await readFile(portable)).toEqual(encrypted);
  } finally {
    await application.close();
    await fixture.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
