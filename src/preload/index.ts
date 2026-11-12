import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { channels } from '../shared/channels';
import type { DesktopAPI, SessionEvent } from '../shared/contracts';

// Keep activity reporting inside isolated preload; the page receives no activity/IPC capability.
const activity = (event: Event) => {
  if (!event.isTrusted || document.visibilityState !== 'visible') return;
  ipcRenderer.send(channels.idleActivity);
};
for (const name of ['keydown', 'pointerdown', 'wheel'])
  window.addEventListener(name, activity, { capture: true, passive: true });

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
};
contextBridge.exposeInMainWorld('sshdrop', api);
