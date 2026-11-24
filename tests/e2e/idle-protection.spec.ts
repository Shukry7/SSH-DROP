import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  const app = await electron.launch({ args: ['.'], env, chromiumSandbox: true });
  await app.firstWindow();
  await app.evaluate(({ dialog, BrowserWindow }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    BrowserWindow.getAllWindows()[0].focus();
  });
  return app;
}
async function connect(page: Page, port: number) {
  await page.getByLabel('Host', { exact: true }).fill('127.0.0.1');
  await page.getByLabel('Port', { exact: true }).fill(String(port));
  await page.getByLabel('Username', { exact: true }).fill('tester');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Connect to server', exact: true }).click();
  await expect(page.getByRole('cell', { name: /hello.txt/ })).toBeVisible();
}
async function advance(app: ElectronApplication, ms: number) {
  await app.evaluate(({ powerMonitor }, amount) => {
    const clock = globalThis as unknown as {
      idleTestClock?: { original: () => number; offset: number };
    };
    clock.idleTestClock ??= { original: Date.now, offset: 0 };
    clock.idleTestClock.offset += amount;
    Date.now = () => clock.idleTestClock!.original() + clock.idleTestClock!.offset;
    powerMonitor.emit('resume');
  }, ms);
}
async function enable(page: Page) {
  await page.getByRole('button', { name: 'Idle protection settings', exact: true }).click();
  await page.getByLabel('Idle timeout', { exact: true }).selectOption('10');
  await page.getByRole('button', { name: 'Apply idle settings', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: 'Idle session protection', exact: true }),
  ).toHaveCount(0);
}

test('idle countdown requires Stay active, ignores remote output and clears the session at expiry', async () => {
  test.setTimeout(90000);
  const directory = await mkdtemp(join(tmpdir(), 'sshdrop-idle-ui-'));
  const fixture = await sshFixture();
  const app = await launch(directory);
  try {
    let page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Idle protection settings' })).toHaveText(
      'Idle protection off',
    );
    await connect(page, fixture.port);
    await enable(page);
    expect(JSON.parse(await readFile(join(directory, 'idle-settings.json'), 'utf8'))).toEqual({
      version: 1,
      settings: { minutes: 10, notifications: false },
    });
    await advance(app, 300000);
    await expect(page.locator('.xterm-rows')).toContainText('fixture-ready');
    expect(
      await page.evaluate(() => window.sshdrop.input('REMOTE-OUTPUT-IS-NOT-ACTIVITY')),
    ).toMatchObject({ ok: true });
    await expect(page.locator('.xterm-rows')).toContainText('echo:REMOTE-OUTPUT-IS-NOT-ACTIVITY');
    const idleBeforeInput = await page.evaluate(() => window.sshdrop.idleStatus());
    expect(idleBeforeInput.ok && idleBeforeInput.value.seconds <= 300).toBe(true);
    await page.evaluate(() => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    const idleAfterSyntheticInput = await page.evaluate(() => window.sshdrop.idleStatus());
    expect(idleAfterSyntheticInput.ok && idleAfterSyntheticInput.value.seconds <= 300).toBe(true);
    expect(
      await page.evaluate(
        () => typeof (window.sshdrop as unknown as Record<string, unknown>).idleActivity,
      ),
    ).toBe('undefined');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('button', { name: 'Idle protection settings' })).toContainText(
      /09:5\d|10:00/,
    );
    await advance(app, 540000);
    const warning = page.getByRole('dialog', { name: 'Your session is about to end', exact: true });
    await expect(warning).toBeVisible();
    await expect(page.getByRole('timer')).toHaveText(/00:(5\d|60)/);
    await page.keyboard.press('ArrowRight');
    await page.mouse.move(40, 40);
    fixture.writeTerminal(Buffer.from('INCOMING-LOGS-DO-NOT-RESET-IDLE\r\n'));
    await expect(warning).toBeVisible();
    expect(await page.evaluate(() => window.sshdrop.input('echo must-not-run\n'))).toMatchObject({
      ok: false,
    });
    await page.keyboard.press('Escape');
    await expect(warning).toBeVisible();
    await page.screenshot({ path: 'artifacts/idle-countdown.png' });
    await page.getByRole('button', { name: 'Stay active', exact: true }).click();
    await expect(warning).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Idle protection settings' })).toContainText(
      /09:5\d|10:00/,
    );
    await expect(page.getByRole('cell', { name: /hello.txt/ })).toBeVisible();
    // Reload/minimization do not reset the main-owned deadline.
    await advance(app, 540000);
    await page.reload();
    await expect(
      page.getByRole('dialog', { name: 'Your session is about to end', exact: true }),
    ).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
    const nextWindow = app.waitForEvent('window');
    await advance(app, 60000);
    page = await nextWindow;
    await expect(page.getByRole('heading', { name: 'Your session has ended' })).toBeVisible();
    await expect(page.getByRole('cell', { name: /hello.txt/ })).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('INCOMING-LOGS-DO-NOT-RESET-IDLE');
    const blocked = await page.evaluate(async () =>
      Promise.all([
        window.sshdrop.profiles(),
        window.sshdrop.workflows(),
        window.sshdrop.list('/'),
        window.sshdrop.input('echo no\n'),
        window.sshdrop.idleSettings({ minutes: 0, notifications: false }),
        window.sshdrop.connect({
          host: '127.0.0.1',
          port: 22,
          username: 'tester',
          auth: 'password',
          password: 'test',
        }),
      ]),
    );
    expect(blocked.every((result) => !result.ok)).toBe(true);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].restore();
      BrowserWindow.getAllWindows()[0].focus();
    });
    await page.getByRole('button', { name: 'Return to connection screen' }).click();
    await expect(page.getByLabel('Host', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
    await expect(
      page.getByRole('button', { name: 'Connect to server', exact: true }),
    ).toBeEnabled();
    await expect(page.getByText('No active connection', { exact: true })).toBeVisible();
    await page.screenshot({ path: 'artifacts/idle-fresh-connection.png' });
    await page.getByRole('button', { name: 'Idle protection settings' }).click();
    const manualEnd = app.waitForEvent('window');
    await page
      .getByRole('button', { name: 'End session now', exact: true })
      .click()
      .catch((error: Error) => {
        if (!error.message.includes('closed')) throw error;
      });
    page = await manualEnd;
    await expect(page.getByText(/at your request/)).toBeVisible();
  } finally {
    await app.close();
    await fixture.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('idle expiry invalidates pending run approval and sleep ends a running workflow without replay', async () => {
  test.setTimeout(90000);
  const directory = await mkdtemp(join(tmpdir(), 'sshdrop-idle-approval-'));
  let executions = 0;
  const fixture = await sshFixture({
    exec: (_command, stream) => {
      executions++;
      stream.write('running\n');
    },
  });
  const app = await launch(directory);
  try {
    let page = await app.firstWindow();
    await connect(page, fixture.port);
    await enable(page);
    await page.getByRole('button', { name: 'New workflow', exact: true }).click();
    await page.getByLabel('Workflow steps').fill('echo generic-check');
    await page.getByLabel('Workflow variables').fill('');
    await page.getByRole('button', { name: 'Save workflow', exact: true }).click();
    await page.getByRole('button', { name: 'Preview workflow', exact: true }).click();
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () =>
        new Promise((resolve) => {
          (globalThis as unknown as { approveIdleTest?: () => void }).approveIdleTest = () =>
            resolve({ response: 1, checkboxChecked: false });
        });
    });
    await page.getByRole('button', { name: 'Confirm and run workflow' }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () => typeof (globalThis as unknown as { approveIdleTest?: unknown }).approveIdleTest,
        ),
      )
      .toBe('function');
    const replacement = app.waitForEvent('window');
    await advance(app, 600000);
    page = await replacement;
    await expect(page.getByRole('heading', { name: 'Your session has ended' })).toBeVisible();
    await app.evaluate(() =>
      (globalThis as unknown as { approveIdleTest: () => void }).approveIdleTest(),
    );
    expect(executions).toBe(0);
    await page.screenshot({ path: 'artifacts/idle-session-ended.png' });
    await page.getByRole('button', { name: 'Return to connection screen' }).click();
    await app.evaluate(({ dialog, BrowserWindow }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      BrowserWindow.getAllWindows()[0].focus();
    });
    await connect(page, fixture.port);
    await page
      .getByLabel('Saved workflow', { exact: true })
      .selectOption({ label: 'Print a message' });
    await page.getByRole('button', { name: 'Preview workflow', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm and run workflow' }).click();
    await expect.poll(() => executions).toBe(1);
    await expect(
      page.getByRole('button', { name: 'Stop workflow / following logs' }),
    ).toBeVisible();
    const sleeping = app.waitForEvent('window');
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit('suspend'));
    page = await sleeping;
    await expect(page.getByText(/because the computer suspended/)).toBeVisible();
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'));
    expect(executions).toBe(1);
    await expect(page.getByRole('heading', { name: 'Your session has ended' })).toBeVisible();
  } finally {
    await app.close();
    await fixture.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('a native upload picker opened before OS locking cannot enqueue work after reconnect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sshdrop-idle-picker-'));
  const local = join(directory, 'generic-upload.txt');
  await writeFile(local, 'must not upload from a stale picker');
  const fixture = await sshFixture();
  const app = await launch(directory);
  try {
    let page = await app.firstWindow();
    await connect(page, fixture.port);
    await enable(page);
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () =>
        new Promise((resolve) => {
          (
            globalThis as unknown as { finishIdlePicker?: (path: string) => void }
          ).finishIdlePicker = (path) => resolve({ canceled: false, filePaths: [path] });
        });
    });
    await page.getByRole('button', { name: /Upload files/ }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () => typeof (globalThis as unknown as { finishIdlePicker?: unknown }).finishIdlePicker,
        ),
      )
      .toBe('function');
    const replacement = app.waitForEvent('window');
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit('lock-screen'));
    page = await replacement;
    await expect(page.getByRole('heading', { name: 'Your session has ended' })).toBeVisible();
    await page.getByRole('button', { name: 'Return to connection screen' }).click();
    await connect(page, fixture.port);
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () =>
        new Promise((resolve) => {
          (globalThis as unknown as { finishNewIdlePicker?: () => void }).finishNewIdlePicker =
            () => resolve({ canceled: true, filePaths: [] });
        });
    });
    await page.getByRole('button', { name: /Upload files/ }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            typeof (globalThis as unknown as { finishNewIdlePicker?: unknown }).finishNewIdlePicker,
        ),
      )
      .toBe('function');
    await app.evaluate(async (_electron, file) => {
      (globalThis as unknown as { finishIdlePicker: (path: string) => void }).finishIdlePicker(
        file,
      );
      await new Promise((resolve) => setImmediate(resolve));
    }, local);
    expect(await page.evaluate(() => window.sshdrop.upload('/'))).toMatchObject({
      ok: false,
      error: 'Finish the open file selection first.',
    });
    await app.evaluate(() =>
      (globalThis as unknown as { finishNewIdlePicker: () => void }).finishNewIdlePicker(),
    );
    expect(fixture.files.has('/generic-upload.txt')).toBe(false);
    await expect(page.getByRole('cell', { name: /generic-upload.txt/ })).toHaveCount(0);
  } finally {
    await app.close();
    await fixture.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('idle preferences default off, require confirmation, survive restart and preserve corrupt files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sshdrop-idle-settings-'));
  let app = await launch(directory);
  try {
    let page = await app.firstWindow();
    await page.getByRole('button', { name: 'Idle protection settings' }).click();
    await page.getByLabel('Idle timeout', { exact: true }).selectOption('10');
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    });
    await page.getByRole('button', { name: 'Apply idle settings' }).click();
    await expect(page.getByRole('button', { name: 'Idle protection settings' })).toHaveText(
      'Idle protection off',
    );
    expect(
      await page.evaluate(() =>
        window.sshdrop.idleSettings({ minutes: 1 as 5, notifications: false }),
      ),
    ).toMatchObject({ ok: false });
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    await enable(page);
    await app.close();
    app = await launch(directory);
    page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Idle protection settings' })).toContainText(
      /10:00|09:5\d/,
    );
    const next = app.waitForEvent('window');
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit('lock-screen'));
    page = await next;
    await expect(page.getByText(/because the screen locked/)).toBeVisible();
    await app.close();
    await writeFile(join(directory, 'idle-settings.json'), 'corrupt');
    app = await launch(directory);
    page = await app.firstWindow();
    await expect(
      page.getByRole('alert').filter({ hasText: '10-minute safety policy' }),
    ).toBeVisible();
    expect(await readFile(join(directory, 'idle-settings.json'), 'utf8')).toBe('corrupt');
    expect(
      await page.evaluate(() => window.sshdrop.idleSettings({ minutes: 0, notifications: false })),
    ).toMatchObject({ ok: false });
    expect(await readFile(join(directory, 'idle-settings.json'), 'utf8')).toBe('corrupt');
    await writeFile(
      join(directory, 'idle-settings.json'),
      JSON.stringify({ version: 1, settings: { minutes: 10, notifications: false } }),
    );
    expect(
      await page.evaluate(() => window.sshdrop.idleSettings({ minutes: 15, notifications: false })),
    ).toMatchObject({ ok: true, value: { settings: { minutes: 15 } } });
    await expect(
      page.getByRole('alert').filter({ hasText: '10-minute safety policy' }),
    ).toHaveCount(0);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
