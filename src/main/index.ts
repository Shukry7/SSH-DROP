import { app, BrowserWindow, dialog, ipcMain, Menu, type IpcMainInvokeEvent } from 'electron';
import { open } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { channels } from '../shared/channels';
import type { Result, SessionEvent } from '../shared/contracts';
import {
  childPath,
  connectionSchema,
  profileInputSchema,
  remotePathSchema,
  terminalInputSchema,
  terminalSizeSchema,
  transferIdSchema,
} from '../shared/validation';
import { HostTrust } from './core/host-trust';
import { Session } from './core/session';
import { ProfileStore } from './core/profiles';
import metadata from '../../package.json';

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
  const profiles = new ProfileStore(join(app.getPath('userData'), 'profiles.json'));
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
    session!.disconnect();
    publish({ type: 'status', connected: false, message: 'Disconnected.' });
  });
  handle(channels.list, (value) => session!.list(remotePathSchema.parse(value)));
  handle(channels.input, (value) => session!.input(terminalInputSchema.parse(value)));
  handle(channels.acknowledge, (value) =>
    session!.acknowledge(z.number().int().positive().parse(value)),
  );
  handle(channels.resize, (value) => {
    const size = terminalSizeSchema.parse(value);
    session!.resize(size.cols, size.rows);
  });
  handle(channels.cancel, (value) => session!.cancel(transferIdSchema.parse(value)));
  handle(channels.upload, async (value) => {
    const directory = remotePathSchema.parse(value);
    const result = await dialog.showOpenDialog(window!, {
      title: 'Upload file',
      properties: ['openFile'],
    });
    const local = result.filePaths[0];
    if (!result.canceled && local)
      await session!.transfer('upload', local, childPath(directory, basename(local)));
  });
  handle(channels.download, async (value) => {
    const remote = remotePathSchema.parse(value);
    const result = await dialog.showSaveDialog(window!, {
      title: 'Download file (choose a new filename)',
      defaultPath: remote.split('/').pop(),
      buttonLabel: 'Download',
    });
    if (!result.canceled && result.filePath)
      await session!.transfer('download', result.filePath, remote);
  });
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
  session = new Session(trust, publish);
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
