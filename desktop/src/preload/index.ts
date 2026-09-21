/**
 * The renderer's entire surface onto the outside world. Everything here is
 * narrow and typed on purpose: no raw ipcRenderer, no filesystem, no network —
 * the renderer asks for a token or a stage change and gets exactly that back.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc';
import type { PairingStatus } from '../shared/ipc';
import type { ZoiaBridge } from './index.d';

const bridge: ZoiaBridge = {
  pairing: {
    status: () => ipcRenderer.invoke(IPC.pairingStatus),
    start: (deviceName) => ipcRenderer.invoke(IPC.pairingStart, deviceName),
    onChange: (cb) => {
      const listener = (_event: Electron.IpcRendererEvent, status: PairingStatus) => cb(status);
      ipcRenderer.on('zoia:pairing:changed', listener);
      return () => ipcRenderer.removeListener('zoia:pairing:changed', listener);
    },
  },
  token: {
    get: () => ipcRenderer.invoke(IPC.getToken),
  },
  stage: {
    get: () => ipcRenderer.invoke(IPC.stageGet),
    claim: () => ipcRenderer.invoke(IPC.stageClaim),
    release: () => ipcRenderer.invoke(IPC.stageRelease),
  },
};

contextBridge.exposeInMainWorld('zoia', bridge);
