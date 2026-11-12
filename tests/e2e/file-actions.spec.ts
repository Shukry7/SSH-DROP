import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sshFixture } from '../fixtures/ssh-server';

async function launch(directory: string) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  env.SSHDROP_USER_DATA_DIR = directory;
  return electron.launch({ args: ['.'], env, chromiumSandbox: true });
}
async function respond(application: ElectronApplication, response: number) {
  await application.evaluate(({ dialog }, response) => {
    dialog.showMessageBox = async (...args: unknown[]) => {
      Object.assign(globalThis, { lastWarning: args.at(-1) });
      return { response, checkboxChecked: false };
    };
  }, response);
}
async function connect(page: Page, port: number, button = 'Connect to server') {
  await page.getByLabel('Host', { exact: true }).fill('127.0.0.1');
  await page.getByLabel('Username', { exact: true }).fill('tester');
  await page.getByLabel('Port', { exact: true }).fill(String(port));
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: button, exact: true }).click();
  await expect(page.getByRole('cell', { name: /hello.txt/ })).toBeVisible();
}

test('remote folder and file actions require confirmation, preserve collisions, and refresh the displayed folder', async () => {
  test.setTimeout(60000);
  const directory = await mkdtemp(join(tmpdir(), 'sshdrop-actions-'));
  const fixture = await sshFixture();
  fixture.symlinks.add('/link');
  const application = await launch(directory);
  try {
    await respond(application, 1);
    const page = await application.firstWindow();
    await connect(page, fixture.port);
    const create = page.getByRole('button', { name: 'New file', exact: true });
    const createFile = page.getByRole('dialog', { name: 'Create remote file', exact: true });
    await create.click();
    await createFile.getByLabel('New name').fill('hello.txt');
    await createFile.getByRole('button', { name: 'Review change' }).click();
    await expect(createFile.getByRole('alert')).toContainText('already exists');
    await createFile.getByLabel('New name').fill('empty.txt');
    await respond(application, 0);
    await createFile.getByRole('button', { name: 'Review change' }).click();
    await expect(createFile).not.toBeVisible();
    expect(fixture.files.has('/empty.txt')).toBe(false);
    expect(
      await application.evaluate(
        () => (globalThis as unknown as { lastWarning: unknown }).lastWarning,
      ),
    ).toMatchObject({
      defaultId: 0,
      cancelId: 0,
      buttons: ['Cancel', 'Create file'],
      message: expect.stringContaining('/empty.txt'),
      detail: expect.stringContaining('0600'),
    });
    await respond(application, 1);
    await create.click();
    await createFile.getByLabel('New name').fill('empty.txt');
    await createFile.getByRole('button', { name: 'Review change' }).click();
    await expect(page.getByRole('cell', { name: /empty\.txt/ })).toBeVisible();
    expect(fixture.files.get('/empty.txt')).toEqual(Buffer.alloc(0));
    await expect(
      page
        .getByRole('row')
        .filter({ has: page.getByRole('cell', { name: /link/ }) })
        .getByRole('button', { name: 'Delete', exact: true }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'New folder', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Create remote folder' });
    await dialog.getByLabel('New name').fill('../escape');
    await dialog.getByRole('button', { name: 'Review change' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Invalid request');
    expect(fixture.directories.has('/escape')).toBe(false);
    await dialog.getByLabel('New name').fill("new 'quoted' 日本語");
    await respond(application, 0);
    await dialog.getByRole('button', { name: 'Review change' }).click();
    await expect(dialog).not.toBeVisible();
    expect(fixture.directories.has("/new 'quoted' 日本語")).toBe(false);
    await respond(application, 1);
    await page.getByRole('button', { name: 'New folder', exact: true }).click();
    await dialog.getByLabel('New name').fill("new 'quoted' 日本語");
    await dialog.getByRole('button', { name: 'Review change' }).click();
    let row = page
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: /new 'quoted' 日本語/ }) });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Rename', exact: true }).click();
    const rename = page.getByRole('dialog', { name: 'Rename remote item' });
    await rename.getByLabel('New name').fill('folder');
    await rename.getByRole('button', { name: 'Review change' }).click();
    await expect(rename.getByRole('alert')).toContainText('already exists');
    await rename.getByLabel('New name').fill('renamed');
    await rename.getByRole('button', { name: 'Review change' }).click();
    row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: /renamed/ }) });
    await expect(row).toBeVisible();
    await respond(application, 0);
    await row.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByRole('button', { name: 'New folder', exact: true })).toBeEnabled();
    expect(fixture.directories.has('/renamed')).toBe(true);
    const warning = await application.evaluate(
      () => (globalThis as unknown as { lastWarning: unknown }).lastWarning,
    );
    expect(warning).toMatchObject({
      type: 'warning',
      defaultId: 0,
      cancelId: 0,
      buttons: ['Cancel', 'Delete permanently'],
      message: expect.stringContaining('/renamed'),
      detail: expect.stringContaining('cannot be undone'),
    });
    await respond(application, 1);
    await row.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(row).toHaveCount(0);
    expect(fixture.directories.has('/renamed')).toBe(false);
    const nonempty = page
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: /folder/ }) });
    await nonempty.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('server refused');
    expect(fixture.files.has('/folder/nested.txt')).toBe(true);
    const file = page
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: /hello.txt/ }) });
    await file.getByRole('button', { name: 'Rename', exact: true }).click();
    await rename.getByLabel('New name').fill('changed.txt');
    await rename.getByRole('button', { name: 'Review change' }).click();
    const changed = page
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: /changed.txt/ }) });
    await expect(changed).toBeVisible();
    await page.screenshot({ path: 'artifacts/remote-file-actions.png' });
    await changed.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(changed).toHaveCount(0);
    expect(fixture.files.has('/changed.txt')).toBe(false);
  } finally {
    await application.close();
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('disconnecting while a confirmation is pending never applies the old change on reconnect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sshdrop-actions-disconnect-'));
  const fixture = await sshFixture();
  const application = await launch(directory);
  try {
    await respond(application, 1);
    const page = await application.firstWindow();
    await connect(page, fixture.port);
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = () =>
        new Promise((resolve) => {
          Object.assign(globalThis, {
            releaseFileConfirmation: () => resolve({ response: 1, checkboxChecked: false }),
          });
        });
    });
    const file = page
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: /hello.txt/ }) });
    await file.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect
      .poll(() =>
        application.evaluate(
          () =>
            typeof (globalThis as unknown as { releaseFileConfirmation?: unknown })
              .releaseFileConfirmation,
        ),
      )
      .toBe('function');
    await expect(page.getByRole('button', { name: 'New folder', exact: true })).toBeDisabled();
    fixture.drop();
    await expect(page.locator('.connection-pill')).toContainText('Connection lost');
    await application.evaluate(() =>
      (globalThis as unknown as { releaseFileConfirmation: () => void }).releaseFileConfirmation(),
    );
    await expect(page.getByRole('alert')).toContainText('inspect the remote folder');
    expect(fixture.files.has('/hello.txt')).toBe(true);
    await respond(application, 1);
    await connect(page, fixture.port, 'Reconnect to server');
    await expect(file).toBeVisible();
  } finally {
    await application.close();
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('permission failures remain recoverable and unsafe IPC requests never reach confirmation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sshdrop-actions-permissions-'));
  const fixture = await sshFixture({ denyChanges: true });
  const application = await launch(directory);
  try {
    await respond(application, 1);
    const page = await application.firstWindow();
    await connect(page, fixture.port);
    for (const input of [
      { action: 'delete', directory: '/', name: '..', kind: 'directory' },
      { action: 'delete', directory: '/', name: 'folder', kind: 'directory', recursive: true },
      { action: 'rename', directory: '/', name: 'hello.txt', newName: '/etc/shadow', kind: 'file' },
    ]) {
      const result = await page.evaluate(
        (value) =>
          window.sshdrop.fileAction(value as Parameters<typeof window.sshdrop.fileAction>[0]),
        input,
      );
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining('Invalid request'),
      });
    }
    const file = page
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: /hello.txt/ }) });
    await file.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('denied permission');
    await page.getByRole('button', { name: /Refresh/ }).click();
    await expect(file).toBeVisible();
    expect(fixture.files.has('/hello.txt')).toBe(true);
  } finally {
    await application.close();
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});
