import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { channels } from '../shared/channels';
import type { DesktopAPI, SessionEvent } from '../shared/contracts';

const api: DesktopAPI = {
  info: () => ipcRenderer.invoke(channels.info),
  chooseKey: () => ipcRenderer.invoke(channels.chooseKey),
  connect: (input) => ipcRenderer.invoke(channels.connect, input),
  disconnect: () => ipcRenderer.invoke(channels.disconnect),
  list: (path) => ipcRenderer.invoke(channels.list, path),
  upload: (directory) => ipcRenderer.invoke(channels.upload, directory),
  download: (path) => ipcRenderer.invoke(channels.download, path),
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
