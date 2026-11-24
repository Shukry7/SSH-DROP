import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    const remember = page.getByRole('checkbox', {
      name: 'Remember new file and folder transfers in this connection',
    });
    await remember.click();
    await expect(remember).toBeChecked();
    await page.getByRole('button', { name: /Upload files/ }).click();
    await expect.poll(() => fixture.openedFiles.some((path) => path.endsWith('.part'))).toBe(true);
    await app.close();
    stall.length = 0;
    app = await launch();
    page = await connect();
    const panel = page.getByRole('region', { name: 'Saved transfers' });
    const retry = panel.getByRole('button', { name: 'Review upload resume' });
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

test('reviews a partial folder download and continues only after approval', async () => {
  test.skip(process.platform !== 'win32', 'Requires real Windows OS key protection.');
  test.setTimeout(120000);
  const dir = await mkdtemp(join(tmpdir(), 'sshdrop-saved-folder-ui-'));
  const remote = '/sample-tree';
  const unfinished = remote + '/b.txt';
  let interrupt = true;
  const shouldStall = (): boolean =>
    interrupt && fixture.openedFiles.filter((path) => path === unfinished).length >= 2;
  const fixture = await sshFixture({ stallReadAt: shouldStall });
  fixture.directories.add(remote);
  fixture.files.set(remote + '/a.txt', Buffer.from('first'));
  fixture.files.set(unfinished, Buffer.from('second'));
  const app = await electron.launch({
    args: ['.'],
    chromiumSandbox: true,
    env: { ...process.env, SSHDROP_USER_DATA_DIR: join(dir, 'app') },
  });
  try {
    await app.evaluate(({ dialog }, destination) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [destination] });
      dialog.showMessageBox = async (...args: unknown[]) => {
        const options = args.at(-1) as import('electron').MessageBoxOptions;
        if (options.title === 'Retry saved transfer') {
          const state = globalThis as typeof globalThis & {
            allowFolderRetry?: boolean;
            folderReview?: unknown;
          };
          state.folderReview = options;
          return { response: state.allowFolderRetry ? 1 : 0, checkboxChecked: false };
        }
        return { response: 1, checkboxChecked: false };
      };
    }, dir);
    const page = await app.firstWindow();
    await page.getByLabel('Host', { exact: true }).fill('127.0.0.1');
    await page.getByLabel('Port', { exact: true }).fill(String(fixture.port));
    await page.getByLabel('Username', { exact: true }).fill('tester');
    await page.getByLabel('Password', { exact: true }).fill('test-password');
    await page.getByRole('button', { name: 'Connect to server', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Saved transfers' });
    await panel.getByRole('checkbox').click();
    await expect(panel.getByRole('checkbox')).toBeChecked();
    await page
      .getByRole('row')
      .filter({ hasText: 'sample-tree' })
      .getByRole('button', { name: 'Download ↓', exact: true })
      .click();
    await expect.poll(shouldStall).toBe(true);
    fixture.drop();
    await expect(panel).toHaveCount(0);
    interrupt = false;
    await page.getByLabel('Password', { exact: true }).fill('test-password');
    await page.getByRole('button', { name: 'Reconnect to server', exact: true }).click();
    const retry = panel.getByRole('button', { name: 'Review folder download' });
    await expect(panel.getByText('1 of 2 files recorded as copied')).toBeVisible();
    await retry.click();
    await expect
      .poll(() => app.evaluate(() => Reflect.get(globalThis, 'folderReview')))
      .toMatchObject({
        defaultId: 0,
        cancelId: 0,
        detail: expect.stringContaining('1 of 2 files recorded as copied'),
      });
    const destination = join(dir, 'sample-tree');
    await expect(readFile(join(destination, 'b.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await app.evaluate(() => Object.assign(globalThis, { allowFolderRetry: true }));
    await retry.click();
    await expect(page.getByRole('group', { name: 'Transfer sample-tree' })).toContainText(
      'completed',
    );
    expect(await readFile(join(destination, 'a.txt'), 'utf8')).toBe('first');
    expect(await readFile(join(destination, 'b.txt'), 'utf8')).toBe('second');
    await expect(retry).toHaveCount(0);
  } finally {
    await app.close();
    await fixture.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
