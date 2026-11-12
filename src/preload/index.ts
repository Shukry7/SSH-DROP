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

const dropErrors = new Set<(error: string) => void>();
const reportDropError = (error: string) => dropErrors.forEach((listener) => listener(error));

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
    activity(event);
    if (transfer.files.length < 1 || transfer.files.length > 100) {
      reportDropError('Drop between 1 and 100 files.');
      return;
    }
    // Paths come only from the native drop in this isolated world and never cross the public bridge.
    const files = Array.from(transfer.files, (file) => webUtils.getPathForFile(file));
    if (files.some((file) => !file)) {
      reportDropError('Drop files from your file manager or use Upload files.');
      return;
    }
    reportDropError('');
    void ipcRenderer.invoke(channels.dropUpload, { directory, files }).then(
      (result: Result<void>) => {
        if (!result.ok) reportDropError(result.error);
      },
      () => reportDropError('Could not review the dropped files.'),
    );
  },
  true,
);

const api: DesktopAPI = {
  exportBackup: (value) => ipcRenderer.invoke(channels.exportBackup, value),
  openBackup: (passphrase) => ipcRenderer.invoke(channels.openBackup, passphrase),
  idleStatus: () => ipcRenderer.invoke(channels.idleStatus),
  idleSettings: (value) => ipcRenderer.invoke(channels.idleSettings, value),
  idleStayActive: () => ipcRenderer.invoke(channels.idleStayActive),
  idleEnd: () => ipcRenderer.invoke(channels.idleEnd),
  idleReturn: () => ipcRenderer.invoke(channels.idleReturn),
  workflows: () => ipcRenderer.invoke(channels.workflows),
  saveWorkflow: (value) => ipcRenderer.invoke(channels.saveWorkflow, value),
  deleteWorkflow: (id) => ipcRenderer.invoke(channels.deleteWorkflow, id),
  previewWorkflow: (value) => ipcRenderer.invoke(channels.previewWorkflow, value),
  runWorkflow: (token) => ipcRenderer.invoke(channels.runWorkflow, token),
  stopWorkflow: (id) => ipcRenderer.invoke(channels.stopWorkflow, id),
  info: () => ipcRenderer.invoke(channels.info),
  chooseKey: () => ipcRenderer.invoke(channels.chooseKey),
  profiles: () => ipcRenderer.invoke(channels.profiles),
  saveProfile: (input) => ipcRenderer.invoke(channels.saveProfile, input),
  loadProfile: (id) => ipcRenderer.invoke(channels.loadProfile, id),
  deleteProfile: (id) => ipcRenderer.invoke(channels.deleteProfile, id),
  connect: (input) => ipcRenderer.invoke(channels.connect, input),
  cancelConnect: () => ipcRenderer.invoke(channels.cancelConnect),
  disconnect: () => ipcRenderer.invoke(channels.disconnect),
  list: (path) => ipcRenderer.invoke(channels.list, path),
  fileAction: (input) => ipcRenderer.invoke(channels.fileAction, input),
  recovery: () => ipcRenderer.invoke(channels.recovery),
  recover: (input) => ipcRenderer.invoke(channels.recover, input),
  upload: (directory) => ipcRenderer.invoke(channels.upload, directory),
  uploadFolder: (directory) => ipcRenderer.invoke(channels.uploadFolder, directory),
  downloadFolder: (path) => ipcRenderer.invoke(channels.downloadFolder, path),
  download: (path) => ipcRenderer.invoke(channels.download, path),
  downloadMany: (paths) => ipcRenderer.invoke(channels.downloadMany, paths),
  resumeQueue: () => ipcRenderer.invoke(channels.resumeQueue),
  cancel: (id) => ipcRenderer.invoke(channels.cancel, id),
  input: (data) => ipcRenderer.invoke(channels.input, data),
  acknowledge: (id) => ipcRenderer.invoke(channels.acknowledge, id),
  resize: (size) => ipcRenderer.invoke(channels.resize, size),
  onEvent: (listener) => {
    const callback = (_event: IpcRendererEvent, value: SessionEvent) => listener(value);
    ipcRenderer.on(channels.event, callback);
    return () => ipcRenderer.removeListener(channels.event, callback);
  },
  onDropError: (listener) => {
    dropErrors.add(listener);
    return () => {
      dropErrors.delete(listener);
    };
  },
};
contextBridge.exposeInMainWorld('sshdrop', api);
