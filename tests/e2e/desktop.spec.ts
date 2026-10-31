import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import metadata from '../../package.json' with { type: 'json' };
import { fixtureUserKey, sshFixture } from '../fixtures/ssh-server';

test('connection help explains fields without submitting or changing the form', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'sshdrop-help-'));
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete environment.ELECTRON_RUN_AS_NODE;
  environment.SSHDROP_USER_DATA_DIR = userData;
  const application = await electron.launch({
    args: ['.'],
    env: environment,
    chromiumSandbox: true,
  });
  try {
    const page = await application.firstWindow();
    await page.getByText('New to SSH? Start here', { exact: true }).click();
    await expect(page.getByText('ssh -p 2222 deploy@203.0.113.10', { exact: true })).toBeVisible();
    await expect(page.getByText(/compare the server fingerprint/)).toBeVisible();
    await page.getByText('New to SSH? Start here', { exact: true }).click();
    await page.getByLabel('Host', { exact: true }).fill('server.example.com');
    const fields = [
      ['Host', 'without https://'],
      ['Username', 'hosting dashboard login'],
      ['Port', '22 is the usual SSH port.'],
      ['Authentication', 'does not enable it on the server'],
      ['Password', 'not your hosting website password'],
      ['Starting directory', 'Terminal cd commands do not change'],
    ];
    for (const [label, explanation] of fields) {
      await page.getByRole('button', { name: `Help with ${label}`, exact: true }).click();
      const panel = page.getByRole('note', { name: `${label} help`, exact: true });
      await expect(panel).toBeVisible();
      await expect(panel).toContainText(explanation);
      await page.getByRole('button', { name: `Close ${label} help`, exact: true }).click();
      await expect(panel).not.toBeVisible();
    }
    const hostHelp = page.getByRole('button', { name: 'Help with Host', exact: true });
    await hostHelp.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('note', { name: 'Host help', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('note', { name: 'Host help', exact: true })).not.toBeVisible();
    await expect(hostHelp).toBeFocused();
    await hostHelp.click();
    await page.getByLabel('Host', { exact: true }).click();
    await expect(page.getByRole('note', { name: 'Host help', exact: true })).not.toBeVisible();
    await expect(page.getByLabel('Host', { exact: true })).toHaveValue('server.example.com');
    await expect(page.getByLabel('Port', { exact: true })).toHaveValue('22');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByText('No active connection', { exact: true })).toBeVisible();
    await page.getByLabel('Authentication', { exact: true }).selectOption('key');
    await page.getByRole('button', { name: 'Help with Private key', exact: true }).click();
    await expect(page.getByRole('note', { name: 'Private key help', exact: true })).toContainText(
      'not the .pub',
    );
    await page.getByRole('button', { name: 'Help with Key passphrase', exact: true }).click();
    await expect(
      page.getByRole('note', { name: 'Private key help', exact: true }),
    ).not.toBeVisible();
    await expect(
      page.getByRole('note', { name: 'Key passphrase help', exact: true }),
    ).toContainText('different from your server account password');
    await page.screenshot({ path: 'artifacts/connection-help.png' });
  } finally {
    await application.close();
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('desktop boots, exposes only the app bridge, and validates requests', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'sshdrop-desktop-'));
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete environment.ELECTRON_RUN_AS_NODE;
  environment.SSHDROP_USER_DATA_DIR = userData;
  const application = await electron.launch({
    chromiumSandbox: true,
    args: ['.', `--user-data-dir=${userData}`],
    env: environment,
  });
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('heading', { name: 'Make yourself at remote.' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connect to server' })).toBeVisible();
    await expect(page.getByText(`v${metadata.version}`, { exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => ({
        require: typeof (window as unknown as Record<string, unknown>).require,
        process: typeof (window as unknown as Record<string, unknown>).process,
        bridge: typeof window.sshdrop.connect,
      })),
    ).toEqual({ require: 'undefined', process: 'undefined', bridge: 'function' });
    const result = await page.evaluate(() =>
      window.sshdrop.connect({
        host: 'invalid host',
        port: 22,
        username: 'tester',
        auth: 'password',
        password: 'test',
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: 'Invalid request. Check the fields and try again.',
    });
    const rendererMetrics = await application.evaluate(({ app }) =>
      app.getAppMetrics().filter((item) => item.type === 'Tab'),
    );
    if (process.platform !== 'linux')
      expect(rendererMetrics.some((item) => item.sandboxed === true)).toBe(true);
    const policy = await page
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute('content');
    expect(policy).toContain("script-src 'self';");
    expect(policy).toContain("connect-src 'none'");
    expect(await page.evaluate(() => window.sshdrop.info())).toMatchObject({
      ok: true,
      value: { version: metadata.version, description: metadata.description },
    });
    await page.screenshot({ path: 'artifacts/desktop.png' });
  } finally {
    await application.close();
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('desktop connects, browses, transfers, reconnects with a key, and disconnects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sshdrop-workflow-'));
  const fixture = await sshFixture();
  const source = join(directory, 'uploaded.txt');
  const destination = join(directory, 'downloaded.txt');
  const keyfile = join(directory, 'test-private-key');
  await writeFile(source, 'uploaded through the desktop');
  await writeFile(keyfile, fixtureUserKey);
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete environment.ELECTRON_RUN_AS_NODE;
  environment.SSHDROP_USER_DATA_DIR = directory;
  const application = await electron.launch({
    args: ['.'],
    env: environment,
    chromiumSandbox: true,
  });
  try {
    await application.evaluate(
      ({ dialog }, paths) => {
        dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths.source] });
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: paths.destination });
      },
      { source, destination },
    );
    const page = await application.firstWindow();
    await page.getByLabel('Host', { exact: true }).fill('127.0.0.1');
    await page.getByLabel('Username', { exact: true }).fill('tester');
    await page.getByLabel('Port', { exact: true }).fill(String(fixture.port));
    await page.getByLabel('Password', { exact: true }).fill('wrong-password');
    await page.getByRole('button', { name: 'Connect to server' }).click();
    await expect(page.getByRole('alert')).toContainText('authentication');
    await expect(page.locator('.statusbar')).toContainText('Connection failed');
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
    await page.getByLabel('Password', { exact: true }).fill('test-password');
    await page.getByRole('button', { name: 'Connect to server' }).click();
    await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: /hello.txt/ })).toBeVisible();
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
    await page.getByRole('button', { name: /folder/, exact: false }).click();
    await expect(page.getByRole('cell', { name: /nested.txt/ })).toBeVisible();
    await page.getByRole('button', { name: /Parent/ }).click();
    await page.getByRole('button', { name: /Upload file/ }).click();
    await expect(page.getByRole('cell', { name: /uploaded.txt/ })).toBeVisible();
    expect(fixture.files.get('/uploaded.txt')?.toString()).toBe('uploaded through the desktop');
    await page
      .getByRole('row')
      .filter({ hasText: 'hello.txt' })
      .getByRole('button', { name: /Download/ })
      .click();
    await expect
      .poll(async () => readFile(destination, 'utf8').catch(() => ''))
      .toBe('Hello from the remote server.\n');
    await expect(page.getByLabel('File transfers').getByText(/completed/)).toHaveCount(2);
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(page.getByText('No active connection', { exact: true })).toBeVisible();
    await application.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, keyfile);
    await page.getByLabel('Authentication', { exact: true }).selectOption('key');
    await page.getByRole('button', { name: 'Choose private key…' }).click();
    await expect(page.getByRole('button', { name: 'test-private-key', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Connect to server' }).click();
    await expect(page.getByRole('cell', { name: /hello.txt/ })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.locator('.topbar')).toBeInViewport();
    await expect(page.locator('.statusbar')).toBeInViewport();
    await page.screenshot({ path: 'artifacts/connected-desktop.png' });
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  } finally {
    await application.close();
    await fixture.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
