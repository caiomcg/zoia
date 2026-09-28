/**
 * The renderer's entire surface onto the outside world. Everything here is
 * narrow and typed on purpose: no raw ipcRenderer, no filesystem, no network —
 * the renderer asks for a token or a stage change and gets exactly that back.
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { IPC } from '../shared/ipc';
import type {
  EncoderStatus,
  PairingStatus,
  UpdaterConfig,
  UpdaterCheckResult,
  ReleaseInfo,
} from '../shared/ipc';
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
    get: (room) => ipcRenderer.invoke(IPC.getToken, room),
  },
  rooms: {
    list: () => ipcRenderer.invoke(IPC.roomsList),
    create: (name) => ipcRenderer.invoke(IPC.roomsCreate, name),
    rename: (id, name) => ipcRenderer.invoke(IPC.roomsRename, id, name),
    remove: (id) => ipcRenderer.invoke(IPC.roomsRemove, id),
  },
  stage: {
    get: () => ipcRenderer.invoke(IPC.stageGet),
    claim: () => ipcRenderer.invoke(IPC.stageClaim),
    release: () => ipcRenderer.invoke(IPC.stageRelease),
  },
  sources: {
    list: (fresh?: boolean) => ipcRenderer.invoke(IPC.sourcesList, fresh),
    select: (source) => ipcRenderer.invoke(IPC.sourcesSelect, source),
    title: (hwnd) => ipcRenderer.invoke(IPC.sourcesTitle, hwnd),
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
  device: {
    rename: (name) => ipcRenderer.invoke(IPC.renameDevice, name),
  },
  report: (entry) => ipcRenderer.send(IPC.report, entry),
  gpu: {
    status: () => ipcRenderer.invoke(IPC.gpuStatus),
  },
  updater: {
    config: () => ipcRenderer.invoke(IPC.updaterConfigGet) as Promise<UpdaterConfig>,
    save: (config: UpdaterConfig) => ipcRenderer.invoke(IPC.updaterConfigSave, config),
    reset: () => ipcRenderer.invoke(IPC.updaterConfigReset),
    check: () => ipcRenderer.invoke(IPC.updaterCheck) as Promise<UpdaterCheckResult>,
    install: () => ipcRenderer.invoke(IPC.updaterInstall) as Promise<void>,
    openInstaller: (url: string) => ipcRenderer.invoke(IPC.updaterOpenInstaller, url),
    releaseNotes: () => ipcRenderer.invoke(IPC.updaterReleaseNotes) as Promise<ReleaseInfo | null>,
  },
  app: {
    version: () => ipcRenderer.invoke(IPC.appVersion) as Promise<string>,
    platform: process.platform,
  },
  language: {
    get: () => ipcRenderer.invoke(IPC.languageGet),
    set: (preference) => ipcRenderer.invoke(IPC.languageSet, preference),
  },
  tray: {
    closeToTray: () => ipcRenderer.invoke(IPC.trayCloseGet),
    setCloseToTray: (value) => ipcRenderer.invoke(IPC.trayCloseSet, value),
  },
  devTools: {
    isEnabled: () => ipcRenderer.invoke(IPC.devToolsGet),
    setEnabled: (value) => ipcRenderer.invoke(IPC.devToolsSet, value),
    open: () => ipcRenderer.invoke(IPC.devToolsOpen),
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
