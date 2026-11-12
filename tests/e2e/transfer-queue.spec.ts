import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
async function connect(page: Page, port: number) {
  await page.getByLabel('Host', { exact: true }).fill('127.0.0.1');
  await page.getByLabel('Port', { exact: true }).fill(String(port));
  await page.getByLabel('Username', { exact: true }).fill('tester');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Connect to server' }).click();
  await expect(page.getByRole('cell', { name: /hello.txt/ })).toBeVisible();
}
async function dialogs(application: ElectronApplication, paths: string[], folder: string) {
  await application.evaluate(
    ({ dialog }, { paths, folder }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      dialog.showOpenDialog = async (...args: unknown[]) => {
        const options = args.at(-1) as import('electron').OpenDialogOptions;
        if (options.properties?.includes('openDirectory'))
          return { canceled: false, filePaths: [folder] };
        if (!options.properties?.includes('multiSelections'))
          throw new Error('Multi-file upload picker missing');
        return { canceled: false, filePaths: paths };
      };
    },
    { paths, folder },
  );
}

test('trusted drops confirm the displayed folder and reject synthetic and directory drops', async () => {
  test.setTimeout(60000);
  const directory = await mkdtemp(join(tmpdir(), 'sshdrop-drop-ui-'));
  const source = join(directory, 'drop.txt');
  await writeFile(source, 'desktop drop bytes');
  const fixture = await sshFixture();
  const application = await launch(directory);
  try {
    await dialogs(application, [], directory);
    const page = await application.firstWindow();
    await connect(page, fixture.port);
    const explorer = page.getByRole('region', { name: 'Remote file explorer' });
    await explorer.getByRole('button', { name: /▰ folder/ }).click();
    await expect(explorer).toHaveAttribute('data-sshdrop-upload-directory', '/folder');
    const heading = explorer.getByRole('heading', { name: /Files/ });
    const cdp = await page.context().newCDPSession(page);
    const drop = async (files: string[]) => {
      await heading.scrollIntoViewIfNeeded();
      const box = await heading.boundingBox();
      if (!box) throw new Error('The file explorer is outside the viewport.');
      const data = { items: [], files, dragOperationsMask: 1 };
      for (const type of ['dragEnter', 'dragOver', 'drop'] as const)
        await cdp.send('Input.dispatchDragEvent', { type, data, x: box.x + 4, y: box.y + 4 });
    };
    const setApproval = (response: number) =>
      application.evaluate(({ dialog }, response) => {
        Object.assign(globalThis, { lastDropDialog: undefined });
        dialog.showMessageBox = async (...args: unknown[]) => {
          Object.assign(globalThis, { lastDropDialog: args.at(-1) });
          return { response, checkboxChecked: false };
        };
      }, response);
    const lastDialog = () =>
      application.evaluate(
        () => (globalThis as unknown as { lastDropDialog?: unknown }).lastDropDialog,
      );
    await setApproval(0);
    await heading.evaluate((element) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File(['spoof'], 'synthetic.txt'));
      element.dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }),
      );
    });
    expect(await lastDialog()).toBeUndefined();
    await drop([directory]);
    await expect(page.getByRole('alert')).toContainText('Drop regular files');
    expect(await lastDialog()).toBeUndefined();
    await drop([source]);
    await expect.poll(lastDialog).toMatchObject({
      title: 'Upload dropped files',
      message: expect.stringContaining('/folder'),
      detail: expect.stringContaining('drop.txt'),
      defaultId: 0,
      cancelId: 0,
    });
    expect(fixture.files.has('/folder/drop.txt')).toBe(false);
    await setApproval(1);
    await drop([source]);
    await expect(page.getByRole('cell', { name: /drop\.txt/ })).toBeVisible();
    expect(fixture.files.get('/folder/drop.txt')?.toString()).toBe('desktop drop bytes');
    expect(fixture.files.has('/drop.txt')).toBe(false);
    await writeFile(source, 'would replace the existing file');
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async (...args: unknown[]) => {
        const options = args.at(-1) as import('electron').MessageBoxOptions;
        Object.assign(globalThis, { lastDropDialog: options });
        return {
          response: options.title === 'Upload dropped files' ? 1 : 0,
          checkboxChecked: false,
        };
      };
    });
    await drop([source]);
    await expect.poll(lastDialog).toMatchObject({ title: 'File already exists', defaultId: 0 });
    await expect(
      page.getByRole('group', { name: 'Transfer drop.txt', exact: true }).first(),
    ).toContainText('cancelled');
    expect(fixture.files.get('/folder/drop.txt')?.toString()).toBe('desktop drop bytes');
    await cdp.detach();
  } finally {
    await application.close();
    await fixture.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('folder pickers and default-Cancel warnings gate verified copies and merges', async () => {
  test.setTimeout(60000);
  const directory = await mkdtemp(join(tmpdir(), 'sshdrop-folder-ui-'));
  const source = join(directory, 'tree');
  const destination = join(directory, 'downloads');
  await mkdir(join(source, 'empty'), { recursive: true });
  await mkdir(destination);
  await writeFile(join(source, 'content.txt'), 'folder desktop bytes');
  const fixture = await sshFixture();
  const application = await launch(directory);
  try {
    await dialogs(application, [], destination);
    const page = await application.firstWindow();
    await connect(page, fixture.port);
    await application.evaluate(({ dialog }, source) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
      dialog.showMessageBox = async (...args: unknown[]) => {
        const options = args.at(-1) as import('electron').MessageBoxOptions;
        if (
          options.title !== 'Copy folder' ||
          options.defaultId !== 0 ||
          options.cancelId !== 0 ||
          !options.message.includes('/tree')
        )
          throw new Error('Folder safety confirmation missing');
        return { response: 0, checkboxChecked: false };
      };
    }, source);
    await page.getByRole('button', { name: 'Upload folder', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Upload folder', exact: true })).toBeEnabled();
    expect(fixture.directories.has('/tree')).toBe(false);
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    await page.getByRole('button', { name: 'Upload folder', exact: true }).click();
    await expect(page.getByRole('group', { name: 'Transfer tree', exact: true })).toContainText(
      'completed',
    );
    expect(fixture.files.get('/tree/content.txt')?.toString()).toBe('folder desktop bytes');
    expect(fixture.directories.has('/tree/empty')).toBe(true);
    await application.evaluate(({ dialog }, destination) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [destination] });
    }, destination);
    await page
      .getByRole('row')
      .filter({ has: page.getByRole('button', { name: /tree/, exact: false }) })
      .getByRole('button', { name: 'Download ↓', exact: true })
      .click();
    await expect
      .poll(() => readFile(join(destination, 'tree', 'content.txt'), 'utf8').catch(() => ''))
      .toBe('folder desktop bytes');
    expect(
      await page.evaluate(() => window.sshdrop.uploadFolder('/alias/../target')),
    ).toMatchObject({ ok: false });
    expect(await page.evaluate(() => window.sshdrop.downloadFolder('/bad/../tree'))).toMatchObject({
      ok: false,
    });
    await writeFile(join(source, 'content.txt'), 'changed bytes');
    await writeFile(join(source, 'new.txt'), 'new bytes');
    await application.evaluate(({ dialog }, source) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
      dialog.showMessageBox = async (...args: unknown[]) => {
        const options = args.at(-1) as import('electron').MessageBoxOptions;
        if (options.defaultId !== 0 || options.cancelId !== 0) throw new Error('Unsafe default');
        if (options.title === 'File already exists') {
          if (options.buttons?.[0] !== 'Skip file') throw new Error('Missing skip option');
          return { response: 0, checkboxChecked: false };
        }
        if (
          options.title === 'Merge into existing folder?' &&
          !options.detail?.includes('File conflicts: 1.')
        )
          throw new Error('Missing merge preview');
        return { response: 1, checkboxChecked: false };
      };
    }, source);
    await page.getByRole('button', { name: 'Upload folder', exact: true }).click();
    await expect(
      page.getByRole('group', { name: 'Transfer tree', exact: true }).first(),
    ).toContainText('1 of 2 files copied · 1 skipped');
    expect(fixture.files.get('/tree/content.txt')?.toString()).toBe('folder desktop bytes');
    expect(fixture.files.get('/tree/new.txt')?.toString()).toBe('new bytes');
    await page.screenshot({ path: 'artifacts/folder-transfers.png' });
  } finally {
    await application.close();
    await fixture.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('multi-file uploads and selected downloads use the queue and reject unsafe IPC', async () => {
  test.setTimeout(60000);
  const directory = await mkdtemp(join(tmpdir(), 'sshdrop-queue-ui-'));
  const folder = join(directory, 'downloads');
  await mkdir(folder);
  const paths = [join(directory, 'first.txt'), join(directory, 'second.txt')];
  await writeFile(paths[0], 'first queue file');
  await writeFile(paths[1], 'second queue file');
  const fixture = await sshFixture();
  const application = await launch(directory);
  try {
    await dialogs(application, paths, folder);
    const page = await application.firstWindow();
    await connect(page, fixture.port);
    await page.getByRole('button', { name: /Upload file/ }).click();
    await expect(
      page.getByRole('group', { name: 'Transfer first.txt', exact: true }),
    ).toContainText('completed');
    await expect(
      page.getByRole('group', { name: 'Transfer second.txt', exact: true }),
    ).toContainText('completed');
    await expect(page.getByRole('cell', { name: /second.txt/ })).toBeVisible();
    expect(fixture.files.get('/first.txt')?.toString()).toBe('first queue file');
    await page.getByLabel('Select first.txt', { exact: true }).check();
    const selectionBox = await page.getByLabel('Select first.txt', { exact: true }).boundingBox();
    const filenameBox = await page.getByRole('button', { name: /first\.txt/ }).boundingBox();
    expect(
      selectionBox &&
        filenameBox &&
        Math.abs(
          selectionBox.y + selectionBox.height / 2 - filenameBox.y - filenameBox.height / 2,
        ) < 4,
    ).toBe(true);
    await page.getByLabel('Select second.txt', { exact: true }).check();
    await page.getByRole('button', { name: 'Download selected (2)' }).click();
    await expect
      .poll(async () => readFile(join(folder, 'first.txt'), 'utf8').catch(() => ''))
      .toBe('first queue file');
    await expect
      .poll(async () => readFile(join(folder, 'second.txt'), 'utf8').catch(() => ''))
      .toBe('second queue file');
    expect(
      await page.evaluate(() => window.sshdrop.downloadMany(['/folder/../escape'])),
    ).toMatchObject({ ok: false });
    expect(
      await page.evaluate(() => window.sshdrop.downloadMany(Array(101).fill('/hello.txt'))),
    ).toMatchObject({ ok: false });
    expect(
      await page.evaluate(() =>
        window.sshdrop.downloadMany([
          { local: '/arbitrary', remote: '/hello.txt' },
        ] as unknown as string[]),
      ),
    ).toMatchObject({ ok: false });
    expect(
      await page.evaluate(
        () => typeof (window as unknown as { ipcRenderer?: unknown }).ipcRenderer,
      ),
    ).toBe('undefined');
    for (let index = 0; index < 110; index++)
      fixture.files.set(
        `/bulk-${String(index).padStart(3, '0')}.txt`,
        Buffer.from('bulk selection'),
      );
    await page.getByRole('button', { name: /Refresh/ }).click();
    await page.getByLabel('Select first 100 files', { exact: true }).check();
    await expect(page.getByLabel('Select first 100 files', { exact: true })).toBeChecked();
    await expect(page.getByRole('button', { name: 'Download selected (100)' })).toBeEnabled();
    await expect(page.getByLabel('Select bulk-109.txt', { exact: true })).toBeDisabled();
    await page.screenshot({ path: 'artifacts/multi-file-queue.png' });
  } finally {
    await application.close();
    await fixture.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('waiting cancellation, failure pause and explicit continuation never retry the failed file', async () => {
  test.setTimeout(60000);
  const directory = await mkdtemp(join(tmpdir(), 'sshdrop-queue-pause-'));
  const paths = ['large-upload.bin', 'cancel-waiting.txt', 'missing.txt', 'continue.txt'].map(
    (name) => join(directory, name),
  );
  await writeFile(paths[0], Buffer.alloc(2 * 1024 * 1024, 88));
  await writeFile(paths[1], 'must not run');
  await writeFile(paths[3], 'continue once');
  const fixture = await sshFixture({ slow: true });
  const application = await launch(directory);
  try {
    await dialogs(application, paths, directory);
    const page = await application.firstWindow();
    await connect(page, fixture.port);
    await page.getByRole('button', { name: /Upload file/ }).click();
    const waiting = page.getByRole('group', { name: 'Transfer cancel-waiting.txt', exact: true });
    await expect(waiting).toContainText('queued');
    await waiting.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(waiting).toContainText('cancelled');
    await expect(page.getByText('Queue paused after', { exact: false })).toBeVisible({
      timeout: 20000,
    });
    expect(fixture.files.has('/cancel-waiting.txt')).toBe(false);
    expect(fixture.files.has('/continue.txt')).toBe(false);
    await page.getByRole('button', { name: 'Continue queue', exact: true }).click();
    await expect(
      page.getByRole('group', { name: 'Transfer continue.txt', exact: true }),
    ).toContainText('completed');
    expect(fixture.files.get('/continue.txt')?.toString()).toBe('continue once');
    expect(fixture.files.has('/missing.txt')).toBe(false);
  } finally {
    await application.close();
    await fixture.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('disconnect during a multi-file picker discards the stale selection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sshdrop-queue-picker-'));
  const source = join(directory, 'stale.txt');
  await writeFile(source, 'must not upload');
  const fixture = await sshFixture();
  const application = await launch(directory);
  try {
    await dialogs(application, [source], directory);
    const page = await application.firstWindow();
    await connect(page, fixture.port);
    await application.evaluate(({ dialog }) => {
      dialog.showOpenDialog = () =>
        new Promise((resolve) => Object.assign(globalThis, { finishQueuePicker: resolve }));
    });
    await page.getByRole('button', { name: /Upload file/ }).click();
    await expect
      .poll(() =>
        application.evaluate(
          () => typeof (globalThis as unknown as { finishQueuePicker?: unknown }).finishQueuePicker,
        ),
      )
      .toBe('function');
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await page.getByLabel('Password', { exact: true }).fill('test-password');
    await page.getByRole('button', { name: 'Connect to server' }).click();
    await expect(page.getByRole('cell', { name: /hello.txt/ })).toBeVisible();
    await application.evaluate(
      (_electron, source) =>
        (globalThis as unknown as { finishQueuePicker(value: unknown): void }).finishQueuePicker({
          canceled: false,
          filePaths: [source],
        }),
      source,
    );
    await page.evaluate(() => window.sshdrop.info());
    expect(fixture.files.has('/stale.txt')).toBe(false);
    await expect(page.getByRole('region', { name: 'File transfers' })).toHaveCount(0);
  } finally {
    await application.close();
    await fixture.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
