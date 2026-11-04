import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  safeStorage,
  type IpcMainInvokeEvent,
} from 'electron';
import { open } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { channels } from '../shared/channels';
import type { Result, SessionEvent } from '../shared/contracts';
import {
  childPath,
  actionDirectorySchema,
  connectionSchema,
  fileActionSchema,
  downloadSelectionSchema,
  profileInputSchema,
  recoveryActionSchema,
  remotePathSchema,
  terminalInputSchema,
  terminalSizeSchema,
  transferIdSchema,
} from '../shared/validation';
import { HostTrust } from './core/host-trust';
import { Session } from './core/session';
import { ProfileStore } from './core/profiles';
import { RecoveryStore } from './core/recovery-store';
import { BackupVault } from './core/backup-vault';
import { osKeyProtection } from './core/os-key-protection';
import { downloadSelection } from './core/download-selection';
import { folderName } from './core/folder-transfer';
import metadata from '../../package.json';
import { WorkflowStore } from './core/workflow-store';
import { renderWorkflow, workflowSchema, workflowValuesSchema } from '../shared/workflows';

let window: BrowserWindow | undefined;
let session: Session | undefined;
const keys = new Map<string, string>();

if (!app.isPackaged && process.env.SSHDROP_USER_DATA_DIR)
  app.setPath('userData', process.env.SSHDROP_USER_DATA_DIR);
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
app.on('second-instance', () => {
  if (window?.isMinimized()) window.restore();
  window?.focus();
});

function trustedSender(event: IpcMainInvokeEvent): void {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  )
    throw new Error('Untrusted application request.');
  const expected =
    !app.isPackaged && process.env.ELECTRON_RENDERER_URL
      ? process.env.ELECTRON_RENDERER_URL
      : pathToFileURL(join(__dirname, '../renderer/index.html')).href;
  if (event.senderFrame.url.split('#')[0] !== new URL(expected).href.split('#')[0])
    throw new Error('Untrusted application page.');
}

function handle<T>(channel: string, operation: (value: unknown) => Promise<T> | T): void {
  ipcMain.handle(channel, async (event, value): Promise<Result<T>> => {
    try {
      trustedSender(event);
      return { ok: true, value: await operation(value) };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof z.ZodError
            ? 'Invalid request. Check the fields and try again.'
            : error instanceof Error
              ? error.message
              : 'The operation failed.',
      };
    }
  });
}

function publish(event: SessionEvent): void {
  if (window && !window.isDestroyed()) window.webContents.send(channels.event, event);
}

function registerAPI(): void {
  let choosingFiles = false;
  const selectFiles = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (choosingFiles) throw new Error('Finish the open file selection first.');
    choosingFiles = true;
    try {
      return await operation();
    } finally {
      choosingFiles = false;
    }
  };
  const profiles = new ProfileStore(join(app.getPath('userData'), 'profiles.json'));
  const workflows = new WorkflowStore(join(app.getPath('userData'), 'workflows.json'));
  let preview:
    | {
        token: string;
        expires: number;
        definition: string;
        id: string;
        check: () => void;
        server: string;
        plan: ReturnType<typeof renderWorkflow>;
      }
    | undefined;
  let confirmingWorkflow = false;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  const discardPreview = () => {
    preview = undefined;
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = undefined;
  };
  const workflowId = z.string().uuid();
  handle(channels.workflows, (value) => {
    z.undefined().parse(value);
    return workflows.list();
  });
  handle(channels.saveWorkflow, async (value) => {
    const w = workflowSchema.parse(value);
    renderWorkflow(
      w,
      Object.fromEntries(w.variables.map((v) => [v.name, v.type === 'integer' ? '0' : 'example'])),
    );
    if (!w.confirmBeforeRun) {
      const confirmation = await dialog.showMessageBox(window!, {
        type: 'warning',
        title: 'Disable workflow run confirmation',
        message: `Allow ${JSON.stringify(w.name)} to run without a confirmation dialog?`,
        detail:
          'Run again can immediately repeat every step on the currently connected server when no variables are required. Commands may delete data, duplicate changes or stop services. This preference applies on every server. Variable values must still be entered again. Inspect uncertain previous outcomes before repeating commands.',
        buttons: ['Cancel', 'Save without run confirmation'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (confirmation.response !== 1)
        throw new Error('Workflow was not saved. Confirmation remains unchanged.');
    }
    const saved = await workflows.save(w);
    discardPreview();
    return saved;
  });
  handle(channels.deleteWorkflow, async (value) => {
    const id = workflowId.parse(value);
    const item = (await workflows.list()).find((w) => w.id === id);
    if (!item) throw new Error('Workflow not found.');
    const result = await dialog.showMessageBox(window!, {
      type: 'warning',
      title: 'Delete saved workflow',
      message: `Delete ${JSON.stringify(item.name)}?`,
      detail:
        'This removes the local shortcut only. It does not stop remote work or undo commands.',
      buttons: ['Cancel', 'Delete workflow'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (result.response === 1) {
      await workflows.delete(id);
      discardPreview();
    }
  });
  handle(channels.previewWorkflow, async (value) => {
    const input = z.object({ id: workflowId, values: workflowValuesSchema }).strict().parse(value);
    const context = session!.workflowContext();
    const w = (await workflows.list()).find((w) => w.id === input.id);
    if (!w) throw new Error('Workflow not found.');
    context.check();
    const plan = renderWorkflow(w, input.values);
    discardPreview();
    preview = {
      id: w.id,
      definition: JSON.stringify(w),
      token: randomUUID(),
      expires: Date.now() + 300000,
      check: context.check,
      server: context.server,
      plan,
    };
    previewTimer = setTimeout(discardPreview, 300000);
    return { token: preview.token, server: preview.server, plan };
  });
  handle(channels.runWorkflow, async (value) => {
    const token = workflowId.parse(value);
    const approved = preview;
    if (
      confirmingWorkflow ||
      !approved ||
      approved.token !== token ||
      Date.now() > approved.expires
    )
      throw new Error('Preview expired or changed. Review the workflow again.');
    discardPreview();
    confirmingWorkflow = true;
    try {
      approved.check();
      if (
        JSON.stringify((await workflows.list()).find((w) => w.id === approved.id)) !==
        approved.definition
      )
        throw new Error('Workflow changed. Preview again.');
      if (approved.plan.confirmBeforeRun !== false) {
        const confirmation = await dialog.showMessageBox(window!, {
          type: 'warning',
          title: 'Run remote workflow',
          message: `Run ${JSON.stringify(approved.plan.name)} on ${approved.server}?`,
          detail: `Remote POSIX shell commands can stop services, permanently delete files or expose data. No general rollback is available. Steps run in separate shells in the shown working directory and stop on nonzero exit. Stop/disconnect cannot guarantee remote processes stop. Nothing is retried automatically.\n\n${approved.plan.scripts.map((s, i) => `STEP ${i + 1}\n${s}`).join('\n\n')}`,
          buttons: ['Cancel', 'Run workflow'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        if (confirmation.response !== 1) return false;
      }
      approved.check();
      if (
        Date.now() > approved.expires ||
        JSON.stringify((await workflows.list()).find((w) => w.id === approved.id)) !==
          approved.definition
      )
        throw new Error('Workflow changed or preview expired. Review again.');
      approved.check();
      void session!.executeWorkflow(approved.plan, token).catch(() => {
        try {
          approved.check();
          publish({
            type: 'workflow',
            update: {
              id: token,
              step: 0,
              status: 'failed',
              message: 'Could not start workflow. Finish active operations, then review again.',
            },
          });
        } catch {
          /* Old connection is discarded. */
        }
      });
      return true;
    } finally {
      confirmingWorkflow = false;
    }
  });
  handle(channels.stopWorkflow, (value) => session!.stopWorkflow(workflowId.parse(value)));
  handle(channels.info, () => ({
    name: 'SSHDrop',
    version: app.getVersion(),
    description: metadata.description,
    platform: process.platform,
  }));
  handle(channels.chooseKey, async () => {
    const result = await dialog.showOpenDialog(window!, {
      title: 'Select SSH private key',
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const id = randomUUID();
    keys.clear();
    keys.set(id, result.filePaths[0]);
    return { id, name: basename(result.filePaths[0]) };
  });
  handle(channels.profiles, (value) => {
    z.undefined().parse(value);
    return profiles.list();
  });
  handle(channels.saveProfile, async (value) => {
    const { keyId, ...details } = profileInputSchema.parse(value);
    const keyPath = keyId ? keys.get(keyId) : undefined;
    if (details.auth === 'key' && !keyPath) throw new Error('Select your private key again.');
    return profiles.save({ ...details, ...(keyPath ? { keyPath } : {}) });
  });
  handle(channels.loadProfile, async (value) => {
    const { profile, keyPath } = await profiles.load(z.string().uuid().parse(value));
    let key = null;
    if (keyPath) {
      const id = randomUUID();
      keys.clear();
      keys.set(id, keyPath);
      key = { id, name: basename(keyPath) };
    }
    return { profile, key };
  });
  handle(channels.deleteProfile, async (value) => {
    const id = z.string().uuid().parse(value);
    const { profile } = await profiles.load(id);
    const result = await dialog.showMessageBox(window!, {
      type: 'question',
      title: 'Delete saved profile',
      message: `Delete the saved profile "${profile.name}"?`,
      detail:
        'This removes only the saved connection details. Server files, private key files, and trusted host identities are kept.',
      buttons: ['Cancel', 'Delete profile'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (result.response !== 1) return false;
    await profiles.delete(id);
    return true;
  });
  handle(channels.connect, async (value) => {
    const input = connectionSchema.parse(value);
    let privateKey: Buffer | undefined;
    if (input.auth === 'key') {
      const file = keys.get(input.keyId!);
      if (!file) throw new Error('Select your private key again.');
      const handle = await open(file, 'r').catch(() => {
        throw new Error('The selected private key could not be opened. Choose the key file again.');
      });
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > 1024 * 1024)
          throw new Error('Select a private key file smaller than 1 MB.');
        const buffer = Buffer.alloc(1024 * 1024 + 1);
        const { bytesRead } = await handle.read(buffer);
        if (bytesRead > 1024 * 1024) {
          buffer.fill(0);
          throw new Error('The selected private key file is too large.');
        }
        privateKey = buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    }
    try {
      await session!.connect({
        host: input.host,
        port: input.port,
        username: input.username,
        ...(input.auth === 'key'
          ? { privateKey, passphrase: input.passphrase }
          : { password: input.password }),
      });
    } finally {
      privateKey?.fill(0);
    }
  });
  handle(channels.disconnect, () => {
    discardPreview();
    session!.disconnect();
    publish({ type: 'status', connected: false, message: 'Disconnected.' });
  });
  handle(channels.list, (value) => session!.list(remotePathSchema.parse(value)));
  handle(channels.recovery, (value) => {
    z.undefined().parse(value);
    return session!.recovery();
  });
  handle(channels.recover, (value) => session!.recover(recoveryActionSchema.parse(value)));
  handle(channels.fileAction, (value) =>
    session!.changeFile(fileActionSchema.parse(value), async (warning) => {
      const result = await dialog.showMessageBox(window!, {
        type: warning.button === 'Delete permanently' ? 'warning' : 'question',
        title: warning.title,
        message: warning.message,
        detail: warning.detail,
        buttons: ['Cancel', warning.button],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return result.response === 1;
    }),
  );
  handle(channels.input, (value) => session!.input(terminalInputSchema.parse(value)));
  handle(channels.acknowledge, (value) =>
    session!.acknowledge(z.number().int().positive().parse(value)),
  );
  handle(channels.resize, (value) => {
    const size = terminalSizeSchema.parse(value);
    session!.resize(size.cols, size.rows);
  });
  handle(channels.cancel, (value) => session!.cancel(transferIdSchema.parse(value)));
  handle(channels.resumeQueue, async (value) => {
    z.undefined().parse(value);
    await session!.resumeQueue(
      async () =>
        (
          await dialog.showMessageBox(window!, {
            type: 'warning',
            title: 'Continue transfer queue',
            message: 'Continue the remaining queued files?',
            detail:
              'Inspect the failed or cancelled operation and its destination first. The failed file will not be retried. Remaining files keep their originally selected destinations and each conflict still requires confirmation. Nothing is replayed after disconnect.',
            buttons: ['Cancel', 'Continue remaining files'],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          })
        ).response === 1,
    );
  });
  handle(channels.upload, (value) =>
    selectFiles(async () => {
      const directory = remotePathSchema.parse(value);
      const lease = session!.lease();
      const result = await dialog.showOpenDialog(window!, {
        title: 'Upload file',
        properties: ['openFile', 'multiSelections'],
      });
      lease();
      if (!result.canceled && result.filePaths.length > 100)
        throw new Error('Select at most 100 files per upload batch.');
      if (!result.canceled && result.filePaths.length)
        session!.enqueue(
          result.filePaths.map((local) => ({
            direction: 'upload',
            local,
            remote: childPath(directory, basename(local)),
          })),
        );
    }),
  );
  const confirmFolder = async (source: string, destination: string) =>
    (
      await dialog.showMessageBox(window!, {
        type: 'warning',
        title: 'Copy folder into a new destination',
        message: `Copy ${JSON.stringify(source)} into new folder ${JSON.stringify(destination)}?`,
        detail:
          'Up to 100 items (including folders), 16 levels and 10 GiB. Links and special files are refused. Existing destination folders are refused; files are never merged or overwritten. New folders request owner-only permissions. Cancellation or connection failure can leave a partial copy. Inspect it before retrying; completed files are not automatically removed or resumed. Sources and destination folders must stay unchanged during the copy.',
        buttons: ['Cancel', 'Copy folder'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
    ).response === 1;
  handle(channels.uploadFolder, (value) =>
    selectFiles(async () => {
      const directory = actionDirectorySchema.parse(value);
      const lease = session!.lease();
      const result = await dialog.showOpenDialog(window!, {
        title: 'Choose upload folder',
        properties: ['openDirectory'],
      });
      lease();
      if (result.canceled || !result.filePaths[0]) return;
      const local = result.filePaths[0];
      const remote = childPath(directory, folderName(basename(local)));
      if (!(await confirmFolder(local, remote))) return;
      lease();
      session!.enqueue([{ direction: 'upload', local, remote, folder: true }]);
    }),
  );
  handle(channels.downloadFolder, (value) =>
    selectFiles(async () => {
      const remote = downloadSelectionSchema.parse([value])[0];
      const lease = session!.lease();
      const result = await dialog.showOpenDialog(window!, {
        title: 'Choose parent folder for download',
        properties: ['openDirectory'],
      });
      lease();
      if (result.canceled || !result.filePaths[0]) return;
      const name = folderName(remote.split('/').pop()!);
      const local = join(result.filePaths[0], name);
      if (!(await confirmFolder(remote, local))) return;
      lease();
      session!.enqueue([{ direction: 'download', local, remote, folder: true }]);
    }),
  );
  handle(channels.download, (value) =>
    selectFiles(async () => {
      const remote = remotePathSchema.parse(value);
      const lease = session!.lease();
      const result = await dialog.showSaveDialog(window!, {
        title: 'Download file',
        defaultPath: remote.split('/').pop(),
        buttonLabel: 'Download',
      });
      lease();
      if (!result.canceled && result.filePath)
        session!.enqueue([{ direction: 'download', local: result.filePath, remote }]);
    }),
  );
  handle(channels.downloadMany, (value) =>
    selectFiles(async () => {
      const paths = downloadSelectionSchema.parse(value);
      const lease = session!.lease();
      const result = await dialog.showOpenDialog(window!, {
        title: 'Choose download folder',
        properties: ['openDirectory'],
      });
      lease();
      if (!result.canceled && result.filePaths[0])
        session!.enqueue(downloadSelection(result.filePaths[0], paths));
    }),
  );
}

function createWindow(): void {
  Menu.setApplicationMenu(null);
  window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 960,
    minHeight: 700,
    title: `SSHDrop ${app.getVersion()}`,
    backgroundColor: '#0b1017',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      partition: 'sshdrop-session',
      devTools: !app.isPackaged,
    },
  });
  const trust = new HostTrust(
    join(app.getPath('userData'), 'known-hosts.json'),
    async ({ host, port, fingerprint }) => {
      const result = await dialog.showMessageBox(window!, {
        type: 'warning',
        title: 'Verify server identity',
        message: `Trust ${host}:${port}?`,
        detail: `Compare this fingerprint with the server administrator through a trusted channel.\n\n${fingerprint}\n\nTrusting this identity allows SSHDrop to authenticate to this server.`,
        buttons: ['Cancel', 'Trust and connect'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return result.response === 1;
    },
  );
  session = new Session(trust, publish, undefined, {
    store: new RecoveryStore(
      join(app.getPath('userData'), 'backups'),
      new BackupVault(join(app.getPath('userData'), 'backups'), osKeyProtection(safeStorage)),
    ),
    confirm: async (approval) => {
      const result = await dialog.showMessageBox(window!, {
        type: 'warning',
        title: approval.title,
        message: approval.title,
        detail: approval.detail,
        buttons: approval.buttons,
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return result.response;
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.on('closed', () => {
    session?.disconnect();
    keys.clear();
    window = undefined;
  });
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL)
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void window.loadFile(join(__dirname, '../renderer/index.html'));
}

void app.whenReady().then(() => {
  if (!ownsInstance) return;
  app.setAppUserModelId('io.github.shukry7.sshdrop');
  app.setAboutPanelOptions({
    applicationName: 'SSHDrop',
    applicationVersion: app.getVersion(),
    copyright: '© 2026 SSHDrop contributors',
  });
  registerAPI();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => session?.disconnect());
