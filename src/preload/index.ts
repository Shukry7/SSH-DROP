import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import { channels } from '../shared/channels';
import type { DesktopAPI, Result, SessionEvent } from '../shared/contracts';

// Keep activity reporting inside isolated preload; the page receives no activity/IPC capability.
const activity = (event: Event) => {
  if (!event.isTrusted || document.visibilityState !== 'visible') return;
  ipcRenderer.send(channels.idleActivity);
};
for (const name of ['keydown', 'pointerdown', 'wheel'])
  window.addEventListener(name, activity, { capture: true, passive: true });

const dropErrors = new Map<string | undefined, Set<(error: string) => void>>();
const reportDropError = (workspace: string | undefined, error: string) =>
  dropErrors.get(workspace)?.forEach((listener) => listener(error));

window.addEventListener(
  'dragover',
  (event) => {
    if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
  },
  true,
);
window.addEventListener(
  'drop',
  (event) => {
    const transfer = event.dataTransfer;
    if (!transfer?.types.includes('Files')) return;
    event.preventDefault();
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    const directory = event.target
      .closest('[data-sshdrop-upload-directory]')
      ?.getAttribute('data-sshdrop-upload-directory');
    if (!directory) return;
    const workspace =
      event.target.closest('[data-sshdrop-workspace]')?.getAttribute('data-sshdrop-workspace') ||
      undefined;
    activity(event);
    if (transfer.files.length < 1 || transfer.files.length > 100) {
      reportDropError(workspace, 'Drop between 1 and 100 files.');
      return;
    }
    // Paths come only from the native drop in this isolated world and never cross the public bridge.
    const files = Array.from(transfer.files, (file) => webUtils.getPathForFile(file));
    if (files.some((file) => !file)) {
      reportDropError(workspace, 'Drop files from your file manager or use Upload files.');
      return;
    }
    reportDropError(workspace, '');
    void ipcRenderer.invoke(channels.dropUpload, { directory, files }, workspace).then(
      (result: Result<void>) => {
        if (!result.ok) reportDropError(workspace, result.error);
      },
      () => reportDropError(workspace, 'Could not review the dropped files.'),
    );
  },
  true,
);

function makeAPI(workspace?: string): DesktopAPI {
  const invoke = (channel: string, value?: unknown) =>
    ipcRenderer.invoke(channel, value, workspace);
  return {
    createWorkspace: () => invoke(channels.createWorkspace),
    closeWorkspace: () => invoke(channels.closeWorkspace),
    forWorkspace: (id) => makeAPI(id),
    exportBackup: (value) => invoke(channels.exportBackup, value),
    openBackup: (passphrase) => invoke(channels.openBackup, passphrase),
    idleStatus: () => invoke(channels.idleStatus),
    idleSettings: (value) => invoke(channels.idleSettings, value),
    idleStayActive: () => invoke(channels.idleStayActive),
    idleEnd: () => invoke(channels.idleEnd),
    idleReturn: () => invoke(channels.idleReturn),
    workflows: () => invoke(channels.workflows),
    importWorkflow: () => invoke(channels.importWorkflow),
    exportWorkflow: (id) => invoke(channels.exportWorkflow, id),
    saveWorkflow: (value) => invoke(channels.saveWorkflow, value),
    deleteWorkflow: (id) => invoke(channels.deleteWorkflow, id),
    previewWorkflow: (value) => invoke(channels.previewWorkflow, value),
    runWorkflow: (token) => invoke(channels.runWorkflow, token),
    stopWorkflow: (id) => invoke(channels.stopWorkflow, id),
    info: () => invoke(channels.info),
    chooseKey: () => invoke(channels.chooseKey),
    profiles: () => invoke(channels.profiles),
    saveProfile: (input) => invoke(channels.saveProfile, input),
    loadProfile: (id) => invoke(channels.loadProfile, id),
    deleteProfile: (id) => invoke(channels.deleteProfile, id),
    connect: (input) => invoke(channels.connect, input),
    cancelConnect: () => invoke(channels.cancelConnect),
    disconnect: () => invoke(channels.disconnect),
    list: (path) => invoke(channels.list, path),
    fileAction: (input) => invoke(channels.fileAction, input),
    openEditor: (input) => invoke(channels.openEditor, input),
    closeEditor: (token) => invoke(channels.closeEditor, token),
    openImage: (input) => invoke(channels.openImage, input),
    cancelImage: (requestId) => invoke(channels.cancelImage, requestId),
    saveEditor: (input) => invoke(channels.saveEditor, input),
    compareEditor: (token) => invoke(channels.compareEditor, token),
    acceptEditorReview: (input) => invoke(channels.acceptEditorReview, input),
    recovery: () => invoke(channels.recovery),
    recover: (input) => invoke(channels.recover, input),
    upload: (directory) => invoke(channels.upload, directory),
    uploadFolder: (directory) => invoke(channels.uploadFolder, directory),
    downloadFolder: (path) => invoke(channels.downloadFolder, path),
    download: (path) => invoke(channels.download, path),
    downloadMany: (paths) => invoke(channels.downloadMany, paths),
    resumeQueue: () => invoke(channels.resumeQueue),
    transferMemory: (enabled) => invoke(channels.transferMemory, enabled),
    savedTransfers: () => invoke(channels.savedTransfers),
    reviewSavedTransfer: (input) => invoke(channels.reviewSavedTransfer, input),
    cancel: (id) => invoke(channels.cancel, id),
    openTerminal: () => invoke(channels.openTerminal),
    openTerminalEditor: (input) => invoke(channels.openTerminalEditor, input),
    closeTerminal: (terminalId) => invoke(channels.closeTerminal, terminalId),
    input: (data, terminalId) => invoke(channels.input, { data, terminalId }),
    acknowledge: (id) => invoke(channels.acknowledge, id),
    resize: (size) => invoke(channels.resize, size),
    onEvent: (listener) => {
      const callback = (_event: IpcRendererEvent, value: SessionEvent, owner?: string) => {
        if (owner === (workspace ?? 'primary') || (owner === undefined && value.type === 'idle'))
          listener(value);
      };
      ipcRenderer.on(channels.event, callback);
      return () => ipcRenderer.removeListener(channels.event, callback);
    },
    onDropError: (listener) => {
      const listeners = dropErrors.get(workspace) ?? new Set();
      dropErrors.set(workspace, listeners);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) dropErrors.delete(workspace);
      };
    },
  };
}
contextBridge.exposeInMainWorld('sshdrop', makeAPI());
