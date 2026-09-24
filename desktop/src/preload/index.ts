/**
 * The renderer's entire surface onto the outside world. Everything here is
 * narrow and typed on purpose: no raw ipcRenderer, no filesystem, no network —
 * the renderer asks for a token or a stage change and gets exactly that back.
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { IPC } from '../shared/ipc';
import type { EncoderStatus, PairingStatus } from '../shared/ipc';
import type { ZoiaBridge } from './index.d';

const bridge: ZoiaBridge = {
  pairing: {
    status: () => ipcRenderer.invoke(IPC.pairingStatus),
    start: (deviceName) => ipcRenderer.invoke(IPC.pairingStart, deviceName),
    useInvite: (path) => ipcRenderer.invoke(IPC.pairingUseInvite, path),
    // Electron removed File.path, and webUtils only works here in preload.
    // Resolving to a path rather than reading the file in the renderer is
    // deliberate: the pairing token stays out of the renderer entirely.
    pathForFile: (file) => webUtils.getPathForFile(file),
    chooseInvite: () => ipcRenderer.invoke(IPC.pairingChooseInvite),
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
    claim: (force) => ipcRenderer.invoke(IPC.stageClaim, force),
    release: () => ipcRenderer.invoke(IPC.stageRelease),
  },
  sources: {
    list: () => ipcRenderer.invoke(IPC.sourcesList),
    select: (source) => ipcRenderer.invoke(IPC.sourcesSelect, source),
  },
  encoder: {
    start: (options) => ipcRenderer.invoke(IPC.encoderStart, options),
    stop: () => ipcRenderer.invoke(IPC.encoderStop),
    onStatus: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, status: EncoderStatus) => cb(status);
      ipcRenderer.on(IPC.encoderStatus, listener);
      return () => ipcRenderer.removeListener(IPC.encoderStatus, listener);
    },
  },
  ingress: {
    get: () => ipcRenderer.invoke(IPC.ingressGet),
    release: () => ipcRenderer.invoke(IPC.ingressRelease),
  },
  device: {
    rename: (name) => ipcRenderer.invoke(IPC.renameDevice, name),
  },
  report: (entry) => ipcRenderer.send(IPC.report, entry),
  gpu: {
    status: () => ipcRenderer.invoke(IPC.gpuStatus),
  },
  audio: {
    start: (processId) => ipcRenderer.invoke(IPC.audioStart, processId),
    stop: () => ipcRenderer.invoke(IPC.audioStop),
    onChunk: (cb) => {
      const listener = (_event: Electron.IpcRendererEvent, chunk: Uint8Array) => cb(chunk);
      ipcRenderer.on(IPC.audioChunk, listener);
      return () => ipcRenderer.removeListener(IPC.audioChunk, listener);
    },
  },
};

contextBridge.exposeInMainWorld('zoia', bridge);
