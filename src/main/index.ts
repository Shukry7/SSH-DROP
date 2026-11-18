import { TransferRecovery } from './core/transfer-recovery';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  powerMonitor,
  safeStorage,
  type IpcMainInvokeEvent,
  type MessageBoxOptions,
  type OpenDialogOptions,
  type SaveDialogOptions,
  type Rectangle,
} from 'electron';
import { AsyncLocalStorage } from 'node:async_hooks';
import { open } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
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
import { inspectDroppedFiles } from './core/dropped-files';
import metadata from '../../package.json';
import { WorkflowStore } from './core/workflow-store';
import {
  openEditorSchema,
  saveEditorSchema,
  editorTokenSchema,
  acceptEditorReviewSchema,
} from '../shared/editor';
import { readWorkflowImport, writeWorkflowExport } from './core/workflow-library';
import { openImageSchema, imageRequestSchema } from '../shared/image-preview';
import { renderWorkflow, workflowSchema, workflowValuesSchema } from '../shared/workflows';
import { IdleProtection } from './core/idle-protection';
import { IdleSettingsStore } from './core/idle-settings';
import { idleSettingsSchema, type IdleState } from '../shared/idle';
import { portableBackupLimit } from '../shared/portable-backup';
import { portableExportRequest, portablePassphrase } from '../shared/validation';
import { openPortable, sealPortable, writePortableCopy } from './core/portable-backup';

let window: BrowserWindow | undefined;
let vaultBusy = false;
const primaryWorkspace = 'primary';
type WorkflowPreview = {
  token: string;
  expires: number;
  definition: string;
  id: string;
  check: () => void;
  server: string;
  plan: ReturnType<typeof renderWorkflow>;
};
interface Workspace {
  id: string;
  number: number;
  server?: string;
  session: Session;
  keys: Map<string, string>;
  lifetime: AbortController;
  pendingConnection?: AbortController;
  preview?: WorkflowPreview;
  previewTimer?: ReturnType<typeof setTimeout>;
  confirmingWorkflow?: string;
}
const workspaces = new Map<string, Workspace>();
let workspaceNumber = 0;
let createWorkspace: (id: string) => Workspace;
const requestWorkspace = new AsyncLocalStorage<Workspace | undefined>();
function currentWorkspace(): Workspace {
  const workspace = requestWorkspace.getStore();
  if (!workspace || workspaces.get(workspace.id) !== workspace)
    throw new Error('This connection tab is closed.');
  return workspace;
}
function discardPreview(workspace: Workspace) {
  workspace.preview = undefined;
  if (workspace.previewTimer) clearTimeout(workspace.previewTimer);
  workspace.previewTimer = undefined;
}
function closeWorkspace(workspace: Workspace) {
  workspaces.delete(workspace.id);
  workspace.lifetime.abort();
  workspace.pendingConnection?.abort(new Error('Connection attempt cancelled.'));
  discardPreview(workspace);
  workspace.keys.clear();
  workspace.session.disconnect();
}
function closeAllWorkspaces() {
  for (const workspace of workspaces.values()) closeWorkspace(workspace);
}
let protection: IdleProtection;
let idleStore: IdleSettingsStore;
let idleSettingsError: string | undefined;
let rebuildingWindow = false;
let discardPendingRequests = () => {};
const operationLease = new AsyncLocalStorage<() => void>();
const nativeWarnings = new Set<AbortController>();
const protectionControls = new Set<string>([
  channels.idleStatus,
  channels.idleStayActive,
  channels.idleEnd,
  channels.idleReturn,
  channels.info,
  channels.disconnect,
  channels.cancelConnect,
  channels.acknowledge,
  channels.cancel,
  channels.stopWorkflow,
]);
function checkOperation(): void {
  operationLease.getStore()?.();
  if (requestWorkspace.getStore()) currentWorkspace();
  protection.assertActive();
}
async function messageBox(options: MessageBoxOptions) {
  checkOperation();
  const controller = new AbortController();
  nativeWarnings.add(controller);
  try {
    const workspace = requestWorkspace.getStore();
    const signal = AbortSignal.any([
      controller.signal,
      ...(options.signal ? [options.signal] : []),
      ...(workspace ? [workspace.lifetime.signal] : []),
    ]);
    const detail =
      workspace && workspaces.size > 1
        ? `Connection ${workspace.number}${workspace.server ? ` · ${workspace.server}` : ''}\n\n${options.detail ?? ''}`
        : options.detail;
    const result = await dialog.showMessageBox(window!, { ...options, detail, signal });
    signal.throwIfAborted();
    checkOperation();
    return result;
  } finally {
    nativeWarnings.delete(controller);
  }
}
async function openDialog(options: OpenDialogOptions) {
  checkOperation();
  const result = await dialog.showOpenDialog(window!, options);
  checkOperation();
  return result;
}
async function saveDialog(options: SaveDialogOptions) {
  checkOperation();
  const result = await dialog.showSaveDialog(window!, options);
  checkOperation();
  return result;
}
function idleState(): IdleState {
  return {
    ...protection.snapshot(),
    ...(idleSettingsError ? { settingsError: idleSettingsError } : {}),
  };
}

if (!app.isPackaged && process.env.SSHDROP_USER_DATA_DIR)
  app.setPath('userData', process.env.SSHDROP_USER_DATA_DIR);
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
app.on('second-instance', () => {
  if (window?.isMinimized()) window.restore();
  window?.show();
  window?.focus();
});

function trustedSender(event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>): void {
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
  ipcMain.handle(channel, async (event, value, workspaceId): Promise<Result<T>> => {
    try {
      trustedSender(event);
      if (vaultBusy && !protectionControls.has(channel))
        throw new Error('Wait for the recovery vault operation to finish.');
      const lease = protectionControls.has(channel) ? undefined : protection.lease();
      const id =
        workspaceId === undefined ? primaryWorkspace : z.string().uuid().parse(workspaceId);
      const workspace = workspaces.get(id);
      if (workspaceId !== undefined && !workspace)
        throw new Error('This connection tab is closed.');
      const owner = window;
      return await requestWorkspace.run(workspace, () =>
        operationLease.run(lease ?? (() => undefined), async () => {
          const result = await operation(value);
          lease?.();
          if (
            channel !== channels.idleEnd &&
            (window !== owner ||
              (workspace &&
                workspaces.get(id) !== workspace &&
                channel !== channels.closeWorkspace))
          )
            throw new Error('The workspace changed.');
          return { ok: true, value: result };
        }),
      );
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

function publish(event: SessionEvent, workspace?: Workspace): void {
  if (event.type !== 'idle' && protection?.snapshot().phase === 'shielded') return;
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
    try {
      window.webContents.send(channels.event, event, workspace?.id);
    } catch {
      /* Closing a renderer must not prevent session cleanup. */
    }
  }
}

function registerAPI(): void {
  ipcMain.on(channels.idleActivity, (event, value) => {
    try {
      trustedSender(event);
      z.undefined().parse(value);
      protection.activity();
    } catch {
      /* Ignore activity from untrusted frames or malformed messages. */
    }
  });
  handle(channels.idleStatus, (value) => {
    z.undefined().parse(value);
    return idleState();
  });
  handle(channels.idleStayActive, (value) => {
    z.undefined().parse(value);
    protection.stayActive();
  });
  handle(channels.idleEnd, (value) => {
    z.undefined().parse(value);
    protection.end('manual');
  });
  handle(channels.idleReturn, (value) => {
    z.undefined().parse(value);
    protection.returnToConnection();
  });
  handle(channels.idleSettings, async (value) => {
    const settings = idleSettingsSchema.parse(value);
    const result = await messageBox({
      type: 'warning',
      title: 'Change idle session protection',
      message: settings.minutes
        ? `End the session after ${settings.minutes} minutes of inactivity?`
        : 'Turn off automatic idle session protection?',
      detail:
        'When enabled, the final minute shows a countdown. Expiry, OS screen locking (where supported) or sleep disconnects SSH and clears the workspace, including unsaved inputs. Active transfers and workflows may be interrupted; remote processes may continue. This is session protection, not an authenticated vault for saved local profiles or workflow definitions. It supplements the operating system screen lock.',
      buttons: ['Cancel', 'Apply settings'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (result.response !== 1) return idleState();
    const saved = await idleStore.save(settings, checkOperation);
    checkOperation();
    idleSettingsError = undefined;
    protection.configure(saved);
    return idleState();
  });
  let choosingFiles: string | undefined;
  const selectFiles = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (choosingFiles) throw new Error('Finish the open file selection first.');
    const selection = randomUUID();
    choosingFiles = selection;
    try {
      return await operation();
    } finally {
      if (choosingFiles === selection) choosingFiles = undefined;
    }
  };
  const profiles = new ProfileStore(join(app.getPath('userData'), 'profiles.json'));
  const workflows = new WorkflowStore(join(app.getPath('userData'), 'workflows.json'));
  discardPendingRequests = () => {
    choosingFiles = undefined;
  };
  handle(channels.createWorkspace, (value) => {
    z.undefined().parse(value);
    if (workspaces.size >= 4) throw new Error('Close a connection tab before opening another.');
    const workspace = createWorkspace(randomUUID());
    return { id: workspace.id, number: workspace.number };
  });
  handle(channels.closeWorkspace, async (value) => {
    z.undefined().parse(value);
    const workspace = currentWorkspace();
    if (workspaces.size === 1) throw new Error('Keep at least one connection tab open.');
    const approval = await messageBox({
      type: 'warning',
      title: 'Close connection tab',
      message: 'Disconnect and close this connection tab?',
      detail: 'Unsaved drafts will be lost. Running transfers and workflows may be interrupted.',
      buttons: ['Cancel', 'Close connection'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (approval.response !== 1) return false;
    if (workspaces.size === 1) throw new Error('Keep at least one connection tab open.');
    closeWorkspace(workspace);
    return true;
  });
  const workflowId = z.string().uuid();
  handle(channels.workflows, (value) => {
    z.undefined().parse(value);
    return workflows.list();
  });
  handle(channels.importWorkflow, (value) =>
    selectFiles(async () => {
      z.undefined().parse(value);
      const selection = await openDialog({
        title: 'Import workflow for review',
        properties: ['openFile'],
        filters: [{ name: 'SSHDrop workflow', extensions: ['json'] }],
      });
      if (selection.canceled || !selection.filePaths[0]) return null;
      const workflow = await readWorkflowImport(selection.filePaths[0]).catch(() => {
        throw new Error(
          'The workflow file is invalid, unsupported, or exceeds 128 KiB. Nothing was imported.',
        );
      });
      checkOperation();
      return workflow;
    }),
  );
  handle(channels.exportWorkflow, (value) =>
    selectFiles(async () => {
      const id = workflowId.parse(value);
      const workflow = (await workflows.list()).find((item) => item.id === id);
      if (!workflow) throw new Error('Workflow not found.');
      const approval = await messageBox({
        type: 'warning',
        title: 'Export workflow definition',
        message: `Export ${JSON.stringify(workflow.name)}?`,
        detail:
          'The file contains the saved commands, description, working directory, variable definitions, group, and execution settings as readable text. Check for secrets and private server details before sharing. Entered variable values and command results are excluded.',
        buttons: ['Cancel', 'Choose export location'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (approval.response !== 1) return false;
      const destination = await saveDialog({
        title: 'Export workflow definition',
        defaultPath: 'workflow-export.json',
        filters: [{ name: 'SSHDrop workflow', extensions: ['json'] }],
      });
      if (destination.canceled || !destination.filePath) return false;
      await writeWorkflowExport(destination.filePath, workflow, checkOperation).catch(() => {
        throw new Error('Could not export the workflow. Choose a new writable filename.');
      });
      return true;
    }),
  );
  handle(channels.saveWorkflow, async (value) => {
    const w = workflowSchema.parse(value);
    renderWorkflow(
      w,
      Object.fromEntries(w.variables.map((v) => [v.name, v.type === 'integer' ? '0' : 'example'])),
    );
    if (!w.confirmBeforeRun) {
      const confirmation = await messageBox({
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
    discardPreview(currentWorkspace());
    return saved;
  });
  handle(channels.deleteWorkflow, async (value) => {
    const id = workflowId.parse(value);
    const item = (await workflows.list()).find((w) => w.id === id);
    if (!item) throw new Error('Workflow not found.');
    const result = await messageBox({
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
      discardPreview(currentWorkspace());
    }
  });
  handle(channels.previewWorkflow, async (value) => {
    const input = z.object({ id: workflowId, values: workflowValuesSchema }).strict().parse(value);
    const workspace = currentWorkspace();
    const context = workspace.session.workflowContext();
    const w = (await workflows.list()).find((w) => w.id === input.id);
    if (!w) throw new Error('Workflow not found.');
    context.check();
    const plan = renderWorkflow(w, input.values);
    discardPreview(currentWorkspace());
    const preview = {
      id: w.id,
      definition: JSON.stringify(w),
      token: randomUUID(),
      expires: Date.now() + 300000,
      check: context.check,
      server: context.server,
      plan,
    };
    workspace.preview = preview;
    workspace.previewTimer = setTimeout(() => discardPreview(workspace), 300000);
    return { token: preview.token, server: preview.server, plan };
  });
  handle(channels.runWorkflow, async (value) => {
    const token = workflowId.parse(value);
    const workspace = currentWorkspace();
    const approved = workspace.preview;
    if (
      workspace.confirmingWorkflow ||
      !approved ||
      approved.token !== token ||
      Date.now() > approved.expires
    )
      throw new Error('Preview expired or changed. Review the workflow again.');
    discardPreview(currentWorkspace());
    workspace.confirmingWorkflow = token;
    try {
      approved.check();
      if (
        JSON.stringify((await workflows.list()).find((w) => w.id === approved.id)) !==
        approved.definition
      )
        throw new Error('Workflow changed. Preview again.');
      if (approved.plan.confirmBeforeRun !== false) {
        const confirmation = await messageBox({
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
      void workspace.session.executeWorkflow(approved.plan, token).catch(() => {
        try {
          approved.check();
          publish(
            {
              type: 'workflow',
              update: {
                id: token,
                step: 0,
                status: 'failed',
                message: 'Could not start workflow. Finish active operations, then review again.',
              },
            },
            workspace,
          );
        } catch {
          /* Old connection is discarded. */
        }
      });
      return true;
    } finally {
      if (workspace.confirmingWorkflow === token) workspace.confirmingWorkflow = undefined;
    }
  });
  handle(channels.stopWorkflow, (value) =>
    currentWorkspace().session.stopWorkflow(workflowId.parse(value)),
  );
  handle(channels.info, () => ({
    name: 'SSHDrop',
    version: app.getVersion(),
    description: metadata.description,
    platform: process.platform,
  }));
  handle(channels.chooseKey, async () => {
    const result = await openDialog({
      title: 'Select SSH private key',
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const id = randomUUID();
    currentWorkspace().keys.clear();
    currentWorkspace().keys.set(id, result.filePaths[0]);
    return { id, name: basename(result.filePaths[0]) };
  });
  handle(channels.profiles, (value) => {
    z.undefined().parse(value);
    return profiles.list();
  });
  handle(channels.saveProfile, async (value) => {
    const { keyId, ...details } = profileInputSchema.parse(value);
    const keyPath = keyId ? currentWorkspace().keys.get(keyId) : undefined;
    if (details.auth === 'key' && !keyPath) throw new Error('Select your private key again.');
    return profiles.save({ ...details, ...(keyPath ? { keyPath } : {}) });
  });
  handle(channels.loadProfile, async (value) => {
    const { profile, keyPath } = await profiles.load(z.string().uuid().parse(value));
    checkOperation();
    let key = null;
    if (keyPath) {
      const id = randomUUID();
      currentWorkspace().keys.clear();
      currentWorkspace().keys.set(id, keyPath);
      key = { id, name: basename(keyPath) };
    }
    return { profile, key };
  });
  handle(channels.deleteProfile, async (value) => {
    const id = z.string().uuid().parse(value);
    const { profile } = await profiles.load(id);
    const result = await messageBox({
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
    const workspace = currentWorkspace();
    if (workspace.pendingConnection)
      throw new Error('A connection attempt is already in progress.');
    const owner = currentWorkspace().session;
    const ownerWindow = window;
    const attempt = new AbortController();
    workspace.pendingConnection = attempt;
    let privateKey: Buffer | undefined;
    try {
      if (input.auth === 'key') {
        const file = currentWorkspace().keys.get(input.keyId!);
        if (!file) throw new Error('Select your private key again.');
        const handle = await open(file, 'r').catch(() => {
          throw new Error(
            'The selected private key could not be opened. Choose the key file again.',
          );
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
      checkOperation();
      attempt.signal.throwIfAborted();
      if (
        workspaces.get(workspace.id) !== workspace ||
        window !== ownerWindow ||
        !ownerWindow ||
        ownerWindow.isDestroyed()
      )
        throw new Error('The workspace changed. Connect again.');
      workspace.server = `${input.username}@${input.host}:${input.port}`;
      return await owner.connect(
        {
          host: input.host,
          port: input.port,
          username: input.username,
          ...(input.auth === 'key'
            ? { privateKey, passphrase: input.passphrase }
            : { password: input.password }),
        },
        attempt.signal,
      );
    } finally {
      privateKey?.fill(0);
      if (workspace.pendingConnection === attempt) workspace.pendingConnection = undefined;
    }
  });
  handle(channels.cancelConnect, (value) => {
    const workspace = currentWorkspace();
    z.undefined().parse(value);
    if (!workspace.pendingConnection) throw new Error('No connection attempt is in progress.');
    workspace.pendingConnection.abort(new Error('Connection attempt cancelled.'));
  });
  handle(channels.disconnect, () => {
    const workspace = currentWorkspace();
    workspace.pendingConnection?.abort(new Error('Connection attempt cancelled.'));
    discardPreview(currentWorkspace());
    currentWorkspace().session.disconnect();
    publish({ type: 'status', connected: false, message: 'Disconnected.' }, workspace);
  });
  handle(channels.list, (value) => currentWorkspace().session.list(remotePathSchema.parse(value)));
  handle(channels.recovery, (value) => {
    z.undefined().parse(value);
    return currentWorkspace().session.recovery();
  });
  handle(channels.recover, (value) =>
    currentWorkspace().session.recover(recoveryActionSchema.parse(value)),
  );
  // Keep the memory-hard KDF serialized even if the renderer is replaced mid-operation.
  let portableBusy = false;
  const portableOperation = async <T>(operation: (check: () => void) => Promise<T>) => {
    if (portableBusy) throw new Error('Wait for the other portable backup operation to finish.');
    portableBusy = true;
    const deadline = performance.now() + 120000;
    try {
      return await operation(() => {
        checkOperation();
        if (performance.now() > deadline) throw new Error('Portable backup operation timed out.');
      });
    } finally {
      portableBusy = false;
    }
  };
  const vaultOperation = async (operation: (check: () => void) => Promise<boolean>) =>
    portableOperation(async (check) => {
      for (const workspace of workspaces.values()) workspace.session.assertVaultIdle();
      vaultBusy = true;
      try {
        return await operation(check);
      } finally {
        vaultBusy = false;
      }
    });
  handle(channels.exportVault, (value) => {
    const passphrase = portablePassphrase.parse(value);
    return selectFiles(async () => {
      const result = await saveDialog({
        title: 'Export encrypted recovery vault',
        defaultPath: 'recovery.sshdrop-vault',
        filters: [{ name: 'SSHDrop recovery vault', extensions: ['sshdrop-vault'] }],
      });
      if (result.canceled || !result.filePath) return false;
      if (!result.filePath.toLowerCase().endsWith('.sshdrop-vault'))
        throw new Error('Use the .sshdrop-vault extension.');
      const approval = await messageBox({
        type: 'warning',
        title: 'Export recovery vault',
        message: 'Export all recovery backups into a password-protected archive?',
        detail:
          'The archive contains backup contents, paths and server/account identities from all servers. Up to 100 encrypted backups and 64 MiB of backup contents are supported. Secure legacy backups first. Keep the passphrase separately. Losing it makes this archive unrecoverable.',
        buttons: ['Cancel', 'Export vault'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (approval.response !== 1) return false;
      return vaultOperation(async (check) => {
        const payload = await recoveryStore.exportVault(check);
        try {
          const bytes = await sealPortable(
            (async function* () {
              yield payload;
            })(),
            { size: payload.length, hash: createHash('sha256').update(payload).digest('hex') },
            passphrase,
            check,
            'vault',
          );
          await writePortableCopy(result.filePath!, bytes, app.getPath('userData'), check);
          return true;
        } finally {
          payload.fill(0);
        }
      });
    });
  });
  handle(channels.importVault, (value) => {
    const passphrase = portablePassphrase.parse(value);
    return selectFiles(async () => {
      const result = await openDialog({
        title: 'Import encrypted recovery vault',
        properties: ['openFile'],
        filters: [{ name: 'SSHDrop recovery vault', extensions: ['sshdrop-vault'] }],
      });
      if (result.canceled || result.filePaths.length !== 1) return false;
      return vaultOperation(async (check) => {
        const payload = await openPortable(result.filePaths[0], passphrase, check, 'vault');
        try {
          const approval = await messageBox({
            type: 'warning',
            title: 'Import recovery vault',
            message: 'Add the verified archive to this computer’s recovery vault?',
            detail:
              'Backups will be encrypted using this OS account. Original server identities are preserved. Imported records allow restoring a new local copy after connecting to the same verified server and account. Recorded paths cannot be used for rollback. Matching backups are skipped. Existing recovery backups are preserved.',
            buttons: ['Cancel', 'Import vault'],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          });
          check();
          if (approval.response !== 1) return false;
          await recoveryStore.importVault(payload, check);
          return true;
        } finally {
          payload.fill(0);
        }
      });
    });
  });
  handle(channels.exportBackup, async (value) => {
    const { id, passphrase } = portableExportRequest.parse(value);
    const owner = window;
    return currentWorkspace().session.withBackupExport(id, async (record, store, connection) => {
      if (record.previous.size > portableBackupLimit)
        throw new Error('Portable export supports backups up to 32 MiB.');
      return selectFiles(async () => {
        const result = await saveDialog({
          title: 'Save encrypted portable backup',
          defaultPath: 'backup.sshdrop-backup',
          filters: [{ name: 'SSHDrop portable backup', extensions: ['sshdrop-backup'] }],
        });
        connection();
        if (result.canceled || !result.filePath) return false;
        const destination = result.filePath;
        if (!destination.toLowerCase().endsWith('.sshdrop-backup'))
          throw new Error('Use the .sshdrop-backup extension.');
        const approval = await messageBox({
          type: 'warning',
          title: 'Export encrypted backup',
          message: 'Create a password-protected backup file?',
          detail: `Destination: ${destination}\n\nKeep the passphrase separately. It is required on any device and cannot be recovered. The original backup stays in SSHDrop. Existing files are never replaced.`,
          buttons: ['Cancel', 'Export backup'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        connection();
        if (approval.response !== 1) return false;
        return portableOperation(async (guard) => {
          const check = () => {
            guard();
            connection();
            if (window !== owner) throw new Error('The workspace changed. Export again.');
          };
          const bytes = await sealPortable(
            store.contents(record, check),
            record.previous,
            passphrase,
            check,
          );
          await writePortableCopy(destination, bytes, app.getPath('userData'), check);
          return true;
        });
      });
    });
  });
  handle(channels.openBackup, (value) => {
    const passphrase = portablePassphrase.parse(value);
    const owner = window;
    return selectFiles(async () => {
      const source = await openDialog({
        title: 'Open encrypted portable backup',
        properties: ['openFile'],
        filters: [{ name: 'SSHDrop portable backup', extensions: ['sshdrop-backup'] }],
      });
      if (source.canceled || source.filePaths.length !== 1) return false;
      const result = await saveDialog({
        title: 'Choose a new file for the restored copy',
        defaultPath: 'restored-copy',
      });
      if (result.canceled || !result.filePath) return false;
      const destination = result.filePath;
      const approval = await messageBox({
        type: 'warning',
        title: 'Restore an unencrypted copy',
        message: 'Write a new local copy of this backup?',
        detail: `Destination: ${destination}\n\nThe restored file is not encrypted. Choose a private folder. No server files or recovery records will change, and existing files are never replaced.`,
        buttons: ['Cancel', 'Restore copy'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (approval.response !== 1) return false;
      return portableOperation(async (guard) => {
        const check = () => {
          guard();
          if (window !== owner) throw new Error('The workspace changed. Open the backup again.');
        };
        const bytes = await openPortable(source.filePaths[0], passphrase, check);
        try {
          await writePortableCopy(destination, bytes, app.getPath('userData'), check);
        } finally {
          bytes.fill(0);
        }
        return true;
      });
    });
  });
  handle(channels.fileAction, (value) =>
    currentWorkspace().session.changeFile(fileActionSchema.parse(value), async (warning) => {
      const result = await messageBox({
        type:
          warning.button === 'Delete permanently' ||
          warning.button === 'Move file' ||
          warning.button === 'Change permissions'
            ? 'warning'
            : 'question',
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
  handle(channels.openEditor, async (value) => {
    const { directory, name } = openEditorSchema.parse(value);
    return currentWorkspace().session.editText({ path: childPath(directory, name) });
  });
  handle(channels.openImage, (value) => {
    const { directory, name, requestId } = openImageSchema.parse(value);
    return currentWorkspace().session.previewImage(childPath(directory, name), requestId);
  });
  handle(channels.cancelImage, (value) =>
    currentWorkspace().session.cancelImage(imageRequestSchema.parse(value)),
  );
  handle(channels.saveEditor, (value) =>
    currentWorkspace().session.editText(saveEditorSchema.parse(value)),
  );
  handle(channels.closeEditor, (value) =>
    currentWorkspace().session.closeEditor(editorTokenSchema.parse(value)),
  );
  handle(channels.compareEditor, (value) =>
    currentWorkspace().session.editText({ token: editorTokenSchema.parse(value), compare: true }),
  );
  handle(channels.acceptEditorReview, (value) =>
    currentWorkspace().session.editText(acceptEditorReviewSchema.parse(value)),
  );
  handle(channels.openTerminal, (value) => {
    z.undefined().parse(value);
    return currentWorkspace().session.openTerminal();
  });
  handle(channels.openTerminalEditor, (value) => {
    const { directory, name } = openEditorSchema.parse(value);
    const path = childPath(directory, name);
    if (Buffer.byteLength(path) > 4096) throw new Error('The remote path is too long.');
    return currentWorkspace().session.openTerminal({
      path,
      choose: async (signal) => {
        const { response } = await messageBox({
          type: 'warning',
          title: 'Edit in terminal',
          message: 'Open this remote file in a terminal editor?',
          detail: `${path}\n\nNano and Vim write directly to the server. SSHDrop’s verified save checks and recovery backups do not apply.\n\nChoose an editor installed on the server.`,
          buttons: ['Cancel', 'Open Nano', 'Open Vim'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          signal,
        });
        return response === 1 ? 'nano' : response === 2 ? 'vim' : undefined;
      },
    });
  });
  handle(channels.closeTerminal, (value) =>
    currentWorkspace().session.closeTerminal(z.string().uuid().parse(value)),
  );
  handle(channels.input, (value) => {
    const { data, terminalId } = z
      .object({
        data: terminalInputSchema,
        terminalId: z.string().uuid().optional(),
      })
      .strict()
      .parse(value);
    currentWorkspace().session.input(data, terminalId);
  });
  handle(channels.acknowledge, (value) =>
    currentWorkspace().session.acknowledge(z.number().int().positive().parse(value)),
  );
  handle(channels.resize, (value) => {
    const size = terminalSizeSchema.parse(value);
    currentWorkspace().session.resize(size.cols, size.rows, size.terminalId);
  });
  handle(channels.cancel, (value) =>
    currentWorkspace().session.cancel(transferIdSchema.parse(value)),
  );
  handle(channels.resumeQueue, async (value) => {
    z.undefined().parse(value);
    await currentWorkspace().session.resumeQueue(
      async () =>
        (
          await messageBox({
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
  handle(channels.transferMemory, (value) =>
    currentWorkspace().session.setTransferMemory(z.boolean().parse(value)),
  );
  handle(channels.savedTransfers, (value) => {
    z.undefined().parse(value);
    return currentWorkspace().session.savedTransfers();
  });
  handle(channels.reviewSavedTransfer, (value) => {
    const { id, action } = z
      .object({ id: z.string().uuid(), action: z.enum(['retry', 'forget']) })
      .strict()
      .parse(value);
    const retry = action === 'retry';
    return currentWorkspace().session.reviewSavedTransfer(
      id,
      action,
      async ({ direction, local, remote, folder, copiedFiles, skippedFiles, totalFiles }) => {
        const source = direction === 'upload' ? local : remote;
        const destination = direction === 'upload' ? remote : local;
        const details = retry
          ? folder
            ? `${totalFiles === undefined ? 'No files have been recorded as copied.' : `${copiedFiles} of ${totalFiles} files recorded as copied.${skippedFiles === undefined ? '' : ` ${skippedFiles} skipped. Remaining conflicts require a decision.`}`} SSHDrop verifies the source and partial folder before continuing. Changed or unexpected entries stop the transfer. Merge replacements require verified encrypted backups and explicit conflict approval.`
            : 'Inspect both locations first. SSHDrop checks the original content hash and requires an empty destination. If a verified partial file is available, it continues from that point.'
          : folder
            ? 'This removes the local record. Already copied files and folders stay at the destination.'
            : 'This removes the local record and any encrypted download checkpoint. A partial upload can remain on the server for inspection.';
        const approval = await messageBox({
          type: 'warning',
          title: retry ? 'Retry saved transfer' : 'Forget saved transfer',
          message: retry
            ? folder
              ? `Continue this saved folder ${direction}?`
              : direction === 'download'
                ? 'Continue this saved download?'
                : 'Continue this saved upload?'
            : 'Remove this transfer from the recovery list?',
          detail: `Source: ${JSON.stringify(source)}\nDestination: ${JSON.stringify(destination)}\n\n${details}`,
          buttons: ['Cancel', retry ? 'Retry transfer' : 'Forget transfer'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        return approval.response === 1;
      },
    );
  });
  handle(channels.upload, (value) =>
    selectFiles(async () => {
      const directory = remotePathSchema.parse(value);
      const lease = currentWorkspace().session.lease();
      const result = await openDialog({
        title: 'Upload file',
        properties: ['openFile', 'multiSelections'],
      });
      lease();
      if (!result.canceled && result.filePaths.length > 100)
        throw new Error('Select at most 100 files per upload batch.');
      if (!result.canceled && result.filePaths.length)
        await currentWorkspace().session.queueFiles(
          result.filePaths.map((local) => ({
            direction: 'upload',
            local,
            remote: childPath(directory, basename(local)),
          })),
        );
    }),
  );
  handle(channels.dropUpload, (value) =>
    selectFiles(async () => {
      const owner = currentWorkspace().session;
      const lease = owner.lease();
      const { directory, jobs } = await inspectDroppedFiles(value);
      lease();
      const names = jobs.slice(0, 8).map(({ local }) => basename(local));
      const more = jobs.length - names.length;
      const approval = await messageBox({
        type: 'question',
        title: 'Upload dropped files',
        message: `Queue ${jobs.length} ${jobs.length === 1 ? 'file' : 'files'} for upload to ${JSON.stringify(directory)}?`,
        detail: `${names.map((name) => JSON.stringify(name)).join('\n')}${more ? `\n… and ${more} more` : ''}\n\nExisting files require a separate conflict decision.`,
        buttons: ['Cancel', 'Queue uploads'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      lease();
      if (approval.response === 1) await owner.queueFiles(jobs);
    }),
  );
  const confirmFolder = async (source: string, destination: string) =>
    (
      await messageBox({
        type: 'warning',
        title: 'Copy folder',
        message: `Copy ${JSON.stringify(source)} to ${JSON.stringify(destination)}?`,
        detail:
          'Up to 100 items (including folders), 16 levels and 10 GiB. Links and special files are refused. An existing destination needs separate merge approval and a decision for each conflicting file. New folders request owner-only permissions. Cancellation or connection failure can leave a partial copy. Inspect it before retrying. Stop other writers during the copy.',
        buttons: ['Cancel', 'Copy folder'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
    ).response === 1;
  handle(channels.uploadFolder, (value) =>
    selectFiles(async () => {
      const directory = actionDirectorySchema.parse(value);
      const lease = currentWorkspace().session.lease();
      const result = await openDialog({
        title: 'Choose upload folder',
        properties: ['openDirectory'],
      });
      lease();
      if (result.canceled || !result.filePaths[0]) return;
      const local = result.filePaths[0];
      const remote = childPath(directory, folderName(basename(local)));
      if (!(await confirmFolder(local, remote))) return;
      lease();
      await currentWorkspace().session.queueFiles([
        { direction: 'upload', local, remote, folder: true },
      ]);
    }),
  );
  handle(channels.downloadFolder, (value) =>
    selectFiles(async () => {
      const remote = downloadSelectionSchema.parse([value])[0];
      const lease = currentWorkspace().session.lease();
      const result = await openDialog({
        title: 'Choose parent folder for download',
        properties: ['openDirectory'],
      });
      lease();
      if (result.canceled || !result.filePaths[0]) return;
      const name = folderName(remote.split('/').pop()!);
      const local = join(result.filePaths[0], name);
      if (!(await confirmFolder(remote, local))) return;
      lease();
      await currentWorkspace().session.queueFiles([
        { direction: 'download', local, remote, folder: true },
      ]);
    }),
  );
  handle(channels.download, (value) =>
    selectFiles(async () => {
      const remote = remotePathSchema.parse(value);
      const lease = currentWorkspace().session.lease();
      const result = await saveDialog({
        title: 'Download file',
        defaultPath: remote.split('/').pop(),
        buttonLabel: 'Download',
      });
      lease();
      if (!result.canceled && result.filePath)
        await currentWorkspace().session.queueFiles([
          { direction: 'download', local: result.filePath, remote },
        ]);
    }),
  );
  handle(channels.downloadMany, (value) =>
    selectFiles(async () => {
      const paths = downloadSelectionSchema.parse(value);
      const lease = currentWorkspace().session.lease();
      const result = await openDialog({
        title: 'Choose download folder',
        properties: ['openDirectory'],
      });
      lease();
      if (!result.canceled && result.filePaths[0])
        await currentWorkspace().session.queueFiles(downloadSelection(result.filePaths[0], paths));
    }),
  );
}

let recoveryStore: RecoveryStore;
let transferRecovery: TransferRecovery;
let hostTrust: HostTrust | undefined;

function createWindow(reset?: { bounds: Rectangle; visible: boolean; minimized: boolean }): void {
  Menu.setApplicationMenu(null);
  window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 960,
    minHeight: 700,
    ...(reset ? { ...reset.bounds, show: false } : {}),
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
  const createdWindow = window;
  if (reset)
    createdWindow.once('ready-to-show', () => {
      if (createdWindow.isDestroyed() || (!reset.visible && !reset.minimized)) return;
      createdWindow.showInactive();
      if (reset.minimized) createdWindow.minimize();
    });
  createdWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown') protection.activity();
  });
  createdWindow.webContents.on('before-mouse-event', (_event, input) => {
    if (['mouseDown', 'mouseWheel'].includes(input.type)) protection.activity();
  });
  const trust = (hostTrust ??= new HostTrust(
    join(app.getPath('userData'), 'known-hosts.json'),
    async ({ host, port, fingerprint }, signal) => {
      const result = await messageBox({
        type: 'warning',
        title: 'Verify server identity',
        message: `Trust ${host}:${port}?`,
        detail: `Compare this fingerprint with the server administrator through a trusted channel.\n\n${fingerprint}\n\nTrusting this identity allows SSHDrop to authenticate to this server.`,
        buttons: ['Cancel', 'Trust and connect'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        signal,
      });
      return result.response === 1;
    },
  ));
  createWorkspace = (id) => {
    const workspace: Workspace = {
      id,
      number: ++workspaceNumber,
      lifetime: new AbortController(),
      keys: new Map(),
      session: new Session(
        trust,
        (event) => {
          if (workspaces.get(id) === workspace) publish(event, workspace);
        },
        undefined,
        {
          store: recoveryStore,
          restoreImported: async (record, check) => {
            const result = await saveDialog({
              title: 'Restore imported backup as a new local file',
            });
            check();
            if (result.canceled || !result.filePath) return;
            const approval = await messageBox({
              type: 'warning',
              title: 'Restore imported backup',
              message: 'Write a new unencrypted local copy?',
              detail: `Destination: ${result.filePath}\n\nChoose a private folder. The backup remains encrypted in SSHDrop. Existing files are preserved.`,
              buttons: ['Cancel', 'Restore copy'],
              defaultId: 0,
              cancelId: 0,
              noLink: true,
            });
            check();
            if (approval.response !== 1) return;
            await recoveryStore.verify(record, check);
            const chunks: Buffer[] = [];
            try {
              for await (const chunk of recoveryStore.contents(record, check)) chunks.push(chunk);
              const bytes = Buffer.concat(chunks);
              try {
                if (
                  bytes.length !== record.previous.size ||
                  createHash('sha256').update(bytes).digest('hex') !== record.previous.hash
                )
                  throw new Error('Imported backup verification failed.');
                await writePortableCopy(result.filePath, bytes, app.getPath('userData'), check);
              } finally {
                bytes.fill(0);
              }
            } finally {
              for (const chunk of chunks) chunk.fill(0);
            }
          },
          confirm: async (approval) => {
            const result = await messageBox({
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
        },
        undefined,
        transferRecovery,
      ),
    };
    workspaces.set(id, workspace);
    return workspace;
  };
  workspaceNumber = 0;
  createWorkspace(primaryWorkspace);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  let askingToDiscard = false;
  window.webContents.on('will-prevent-unload', () => {
    if (askingToDiscard) return;
    askingToDiscard = true;
    void messageBox({
      type: 'warning',
      title: 'Unsaved editor changes',
      message: 'Discard unsaved editor changes and close SSHDrop?',
      detail: 'Any unsaved changes in open tabs will be lost.',
      buttons: ['Keep editing', 'Discard and close'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
      .then((choice) => {
        if (choice.response === 1 && !createdWindow.isDestroyed()) createdWindow.destroy();
      })
      .catch(() => {})
      .finally(() => {
        askingToDiscard = false;
      });
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.on('closed', () => {
    if (window === createdWindow) {
      discardPendingRequests();
      closeAllWorkspaces();
    }
    if (window === createdWindow) window = undefined;
  });
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL)
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void window.loadFile(join(__dirname, '../renderer/index.html'));
}

void app.whenReady().then(async () => {
  if (!ownsInstance) return;
  app.setAppUserModelId('io.github.shukry7.sshdrop');
  app.setAboutPanelOptions({
    applicationName: 'SSHDrop',
    applicationVersion: app.getVersion(),
    copyright: '© 2026 SSHDrop contributors',
  });
  idleStore = new IdleSettingsStore(join(app.getPath('userData'), 'idle-settings.json'));
  const settings = await idleStore.read().catch(() => {
    idleSettingsError =
      'Idle settings could not be loaded. A 10-minute safety policy is active; the existing file is preserved. Repair idle-settings.json before changing settings.';
    return { minutes: 10 as const, notifications: false };
  });
  let lastPhase: IdleState['phase'] = 'active';
  let idleNotice: Notification | undefined;
  protection = new IdleProtection(
    settings,
    () => ({ wall: Date.now(), monotonic: Number(process.hrtime.bigint() / 1000000n) }),
    (state) => {
      if (state.phase !== 'warning') {
        try {
          idleNotice?.close();
        } catch {
          /* Notification failure must not delay disconnection. */
        }
        idleNotice = undefined;
      }
      publish({
        type: 'idle',
        state: { ...state, ...(idleSettingsError ? { settingsError: idleSettingsError } : {}) },
      });
      if (
        state.phase === 'warning' &&
        lastPhase !== 'warning' &&
        state.settings.notifications &&
        !window?.isFocused() &&
        Notification.isSupported()
      ) {
        try {
          const notice = new Notification({
            title: 'SSHDrop inactivity warning',
            body: `The session ends in ${state.seconds} seconds. Active operations may be interrupted.`,
            silent: true,
          });
          idleNotice = notice;
          notice.once('click', () => {
            window?.show();
            window?.focus();
          });
          notice.show();
        } catch {
          /* The in-app countdown remains authoritative. */
        }
      }
      lastPhase = state.phase;
    },
    () => {
      discardPendingRequests();
      for (const controller of nativeWarnings) controller.abort();
      closeAllWorkspaces();
      const old = window;
      if (!old || old.isDestroyed()) return;
      const reset = {
        bounds: old.getBounds(),
        visible: old.isVisible(),
        minimized: old.isMinimized(),
      };
      rebuildingWindow = true;
      try {
        // Destroy the old renderer and native pickers, rather than leaving secrets hidden behind CSS.
        old.destroy();
        createWindow(reset);
      } finally {
        rebuildingWindow = false;
      }
    },
  );
  const timer = setInterval(() => protection.tick(), 1000);
  timer.unref();
  powerMonitor.on('lock-screen', () => protection.systemEvent('os-lock'));
  powerMonitor.on('suspend', () => protection.systemEvent('sleep'));
  powerMonitor.on('resume', () => protection.tick());
  recoveryStore = new RecoveryStore(
    join(app.getPath('userData'), 'backups'),
    new BackupVault(join(app.getPath('userData'), 'backups'), osKeyProtection(safeStorage)),
  );
  transferRecovery = new TransferRecovery(
    new BackupVault(
      join(app.getPath('userData'), 'transfer-recovery'),
      osKeyProtection(safeStorage),
    ),
  );
  registerAPI();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else {
      window?.show();
      window?.focus();
    }
  });
});
app.on('window-all-closed', () => {
  if (!rebuildingWindow && process.platform !== 'darwin') app.quit();
});
