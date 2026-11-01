import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProfileInput } from '../../src/shared/contracts';
import { fixtureUserKey, sshFixture } from '../fixtures/ssh-server';

function launch(userData: string) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  env.SSHDROP_USER_DATA_DIR = userData;
  return electron.launch({ args: ['.'], env, chromiumSandbox: true });
}

test('saved password profiles survive restart, connect, edit, cancel deletion, and delete without storing secrets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sshdrop-profile-ui-'));
  const fixture = await sshFixture();
  let application = await launch(directory);
  try {
    let page = await application.firstWindow();
    await expect(page.getByRole('button', { name: 'Save profile', exact: true })).toBeEnabled();
    await page.getByLabel('Host', { exact: true }).fill('127.0.0.1');
    await page.getByLabel('Port', { exact: true }).fill(String(fixture.port));
    await page.getByLabel('Username', { exact: true }).fill('tester');
    await page.getByLabel('Starting directory', { exact: true }).fill('/folder');
    await page.getByLabel('Profile name', { exact: true }).fill('My test server');
    // Saving is independent of authentication: a password is not required to save a profile.
    await page.getByRole('button', { name: 'Save profile', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Profile saved');
    await page.getByLabel('Password', { exact: true }).fill('never-persist-this');
    await page.getByRole('button', { name: 'Save profile changes', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Profile saved');
    const stored = JSON.parse(await readFile(join(directory, 'profiles.json'), 'utf8'));
    expect(stored.profiles[0]).toEqual({
      id: expect.any(String),
      name: 'My test server',
      host: '127.0.0.1',
      port: fixture.port,
      username: 'tester',
      auth: 'password',
      startingDirectory: '/folder',
    });
    expect(JSON.stringify(stored)).not.toContain('never-persist-this');
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
    await application.close();
    expect(
      JSON.parse(await readFile(join(directory, 'profiles.json'), 'utf8')).profiles,
    ).toHaveLength(1);
    application = await launch(directory);
    page = await application.firstWindow();
    await expect(page.getByRole('button', { name: 'Save profile', exact: true })).toBeEnabled();
    expect(await page.evaluate(() => window.sshdrop.profiles())).toMatchObject({
      ok: true,
      value: [{ name: 'My test server' }],
    });
    await expect(page.getByLabel('Saved server', { exact: true }).locator('option')).toHaveCount(2);
    await page
      .getByLabel('Saved server', { exact: true })
      .selectOption({ label: 'My test server' });
    await expect(page.getByLabel('Host', { exact: true })).toHaveValue('127.0.0.1');
    await expect(page.getByLabel('Port', { exact: true })).toHaveValue(String(fixture.port));
    await expect(page.getByLabel('Starting directory', { exact: true })).toHaveValue('/folder');
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    await page.getByLabel('Password', { exact: true }).fill('test-password');
    await page.getByRole('button', { name: 'Connect to server', exact: true }).click();
    await expect(page.getByRole('cell', { name: /nested.txt/ })).toBeVisible();
    await expect(page.getByLabel('Saved server', { exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await page.getByLabel('Profile name', { exact: true }).fill('Renamed server');
    await page.getByRole('button', { name: 'Save profile changes', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Profile saved');
    expect(
      JSON.parse(await readFile(join(directory, 'profiles.json'), 'utf8')).profiles,
    ).toHaveLength(1);
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    });
    await page.getByRole('button', { name: 'Delete profile', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Delete profile', exact: true })).toBeEnabled();
    expect(
      JSON.parse(await readFile(join(directory, 'profiles.json'), 'utf8')).profiles,
    ).toHaveLength(1);
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    await page.screenshot({ path: 'artifacts/saved-profiles.png' });
    await page.getByRole('button', { name: 'Delete profile', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Profile deleted');
    expect(JSON.parse(await readFile(join(directory, 'profiles.json'), 'utf8')).profiles).toEqual(
      [],
    );
    await expect(page.getByLabel('Host', { exact: true })).toHaveValue('');
  } finally {
    await application.close();
    await fixture.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('key profiles restore native key handles after restart and report missing keys without saving secrets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sshdrop-key-profile-'));
  const fixture = await sshFixture();
  const keyfile = join(directory, 'identity');
  await writeFile(keyfile, fixtureUserKey);
  let application = await launch(directory);
  try {
    let page = await application.firstWindow();
    await expect(page.getByRole('button', { name: 'Save profile', exact: true })).toBeEnabled();
    await application.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, keyfile);
    await page.getByLabel('Host', { exact: true }).fill('127.0.0.1');
    await page.getByLabel('Port', { exact: true }).fill(String(fixture.port));
    await page.getByLabel('Username', { exact: true }).fill('tester');
    await page.getByLabel('Authentication', { exact: true }).selectOption('key');
    await page.getByRole('button', { name: 'Choose private key…', exact: true }).click();
    await page.getByLabel('Key passphrase', { exact: true }).fill('never-save-passphrase');
    await page.getByLabel('Profile name', { exact: true }).fill('Key server');
    await page.getByRole('button', { name: 'Save profile', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Profile saved');
    const contents = await readFile(join(directory, 'profiles.json'), 'utf8');
    expect(JSON.parse(contents).profiles[0].keyPath).toBe(keyfile);
    expect(contents).not.toContain('never-save-passphrase');
    expect(contents).not.toContain('PRIVATE KEY');
    expect(await page.evaluate(() => window.sshdrop.profiles())).not.toHaveProperty(
      'value.0.keyPath',
    );
    await application.close();
    application = await launch(directory);
    page = await application.firstWindow();
    await expect(page.getByRole('button', { name: 'Save profile', exact: true })).toBeEnabled();
    expect(await page.evaluate(() => window.sshdrop.profiles())).toMatchObject({
      ok: true,
      value: [{ name: 'Key server' }],
    });
    await expect(page.getByLabel('Saved server', { exact: true }).locator('option')).toHaveCount(2);
    await page.getByLabel('Saved server', { exact: true }).selectOption({ label: 'Key server' });
    await expect(page.getByRole('button', { name: 'identity', exact: true })).toBeVisible();
    await expect(page.getByLabel('Key passphrase', { exact: true })).toHaveValue('');
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    await page.getByRole('button', { name: 'Connect to server', exact: true }).click();
    await expect(page.getByRole('cell', { name: /hello.txt/ })).toBeVisible();
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await rm(keyfile);
    await page.getByRole('button', { name: 'Connect to server', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Choose the key file again');
    await expect(
      page.getByRole('button', { name: 'Connect to server', exact: true }),
    ).toBeEnabled();
    // The server/key can be repaired without deleting the profile or restarting the app.
    await writeFile(keyfile, fixtureUserKey);
    await page.getByRole('button', { name: 'Connect to server', exact: true }).click();
    await expect(page.getByRole('cell', { name: /hello.txt/ })).toBeVisible();
  } finally {
    await application.close();
    await fixture.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('profile IPC rejects secret fields, arbitrary paths, and stale handles; corrupt storage is preserved', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sshdrop-profile-errors-'));
  const application = await launch(directory);
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('button', { name: 'Save profile', exact: true })).toBeEnabled();
    const results = await page.evaluate(async () => {
      const valid = {
        name: 'Test',
        host: 'localhost',
        port: 22,
        username: 'tester',
        auth: 'password' as const,
        startingDirectory: '/',
      };
      return Promise.all([
        window.sshdrop.saveProfile({ ...valid, password: 'secret' } as ProfileInput),
        window.sshdrop.saveProfile({
          ...valid,
          auth: 'key',
          keyPath: '/arbitrary/file',
        } as ProfileInput),
        window.sshdrop.saveProfile({
          ...valid,
          auth: 'key',
          keyId: '00000000-0000-4000-8000-000000000001',
        }),
        window.sshdrop.loadProfile('../file'),
        window.sshdrop.deleteProfile('../file'),
      ]);
    });
    for (const result of results) expect(result.ok).toBe(false);
    expect(await page.evaluate(() => window.sshdrop.profiles())).toEqual({ ok: true, value: [] });
    await writeFile(join(directory, 'profiles.json'), 'corrupt data');
    await page.reload();
    await expect(page.getByRole('alert')).toContainText('Saved profiles could not be read');
    await expect(page.getByRole('button', { name: 'Save profile', exact: true })).toBeDisabled();
    // A broken profiles file must not prevent an unsaved manual connection.
    await expect(page.getByLabel('Host', { exact: true })).toBeEnabled();
    expect(await readFile(join(directory, 'profiles.json'), 'utf8')).toBe('corrupt data');
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
