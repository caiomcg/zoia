/**
 * The renderer's entire surface onto the outside world. Everything here is
 * narrow and typed on purpose: no raw ipcRenderer, no filesystem, no network —
 * the renderer asks for a token or a stage change and gets exactly that back.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc';
import type {
  EncoderStatus,
  PairingStatus,
  UpdaterConfig,
  UpdaterCheckResult,
  ReleaseInfo,
  ChatEvent,
} from '../shared/ipc';
import type { ZoiaBridge } from './index.d';

// The native video frame channel. contextBridge cannot carry a MessagePort,
// so it is handed to the page with window.postMessage, which can; the page
// passes it straight on to its transform worker (livekit/native-video.ts).
ipcRenderer.on(IPC.nativeVideoPort, (event) => {
  // The preload is typed without the DOM, but runs with the page's window.
  (
    globalThis as unknown as {
      postMessage(message: unknown, targetOrigin: string, transfer: unknown[]): void;
    }
  ).postMessage({ type: 'zoia:native-video-port' }, '*', event.ports);
});

const bridge: ZoiaBridge = {
  pairing: {
    status: () => ipcRenderer.invoke(IPC.pairingStatus),
    onChange: (cb) => {
      const listener = (_event: Electron.IpcRendererEvent, status: PairingStatus) => cb(status);
      ipcRenderer.on('zoia:pairing:changed', listener);
      return () => ipcRenderer.removeListener('zoia:pairing:changed', listener);
    },
  },
  account: {
    signIn: (server, email, password) =>
      ipcRenderer.invoke(IPC.accountSignIn, server, email, password),
    signUp: (server, email, password) =>
      ipcRenderer.invoke(IPC.accountSignUp, server, email, password),
    redeem: (server, code, password) =>
      ipcRenderer.invoke(IPC.accountRedeem, server, code, password),
    refresh: () => ipcRenderer.invoke(IPC.accountRefresh),
    signOut: () => ipcRenderer.invoke(IPC.accountSignOut),
    changePassword: (current, next) => ipcRenderer.invoke(IPC.accountPassword, current, next),
    devices: () => ipcRenderer.invoke(IPC.accountDevices),
    removeDevice: (id) => ipcRenderer.invoke(IPC.accountRemoveDevice, id),
  },
  admin: {
    accounts: () => ipcRenderer.invoke(IPC.adminAccounts),
    act: (id, action, options) => ipcRenderer.invoke(IPC.adminAction, id, action, options),
    moveDevice: (id, channel) => ipcRenderer.invoke(IPC.adminMoveDevice, id, channel),
    kickDevice: (id) => ipcRenderer.invoke(IPC.adminKickDevice, id),
  },
  token: {
    get: (room) => ipcRenderer.invoke(IPC.getToken, room),
  },
  rooms: {
    list: () => ipcRenderer.invoke(IPC.roomsList),
    create: (name) => ipcRenderer.invoke(IPC.roomsCreate, name),
    rename: (id, name) => ipcRenderer.invoke(IPC.roomsRename, id, name),
    remove: (id) => ipcRenderer.invoke(IPC.roomsRemove, id),
    setLimit: (max) => ipcRenderer.invoke(IPC.roomsSetLimit, max),
  },
  stage: {
    get: () => ipcRenderer.invoke(IPC.stageGet),
    claim: () => ipcRenderer.invoke(IPC.stageClaim),
    release: () => ipcRenderer.invoke(IPC.stageRelease),
  },
  voice: {
    join: () => ipcRenderer.invoke(IPC.voiceJoin),
    leave: () => ipcRenderer.invoke(IPC.voiceLeave),
    deafen: (deafened) => ipcRenderer.invoke(IPC.voiceDeafen, deafened),
  },
  sources: {
    list: (fresh?: boolean) => ipcRenderer.invoke(IPC.sourcesList, fresh),
    instant: () => ipcRenderer.invoke(IPC.sourcesInstant),
    select: (source) => ipcRenderer.invoke(IPC.sourcesSelect, source),
    title: (hwnd) => ipcRenderer.invoke(IPC.sourcesTitle, hwnd),
    league: () => ipcRenderer.invoke(IPC.sourcesLeague),
    windows: () => ipcRenderer.invoke(IPC.sourcesWindows),
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
  nativeVideo: {
    start: (options) => ipcRenderer.invoke(IPC.nativeVideoStart, options),
    stop: () => ipcRenderer.invoke(IPC.nativeVideoStop),
    requestKeyframe: () => ipcRenderer.invoke(IPC.nativeVideoKeyframe),
    setBitrate: (bitsPerSecond) => ipcRenderer.invoke(IPC.nativeVideoBitrate, bitsPerSecond),
    onError: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, message: string) => cb(message);
      ipcRenderer.on(IPC.nativeVideoError, listener);
      return () => ipcRenderer.removeListener(IPC.nativeVideoError, listener);
    },
  },
  device: {
    rename: (name) => ipcRenderer.invoke(IPC.renameDevice, name),
    setAvatar: (bytes) => ipcRenderer.invoke(IPC.setAvatar, bytes),
    removeAvatar: () => ipcRenderer.invoke(IPC.removeAvatar),
  },
  avatars: {
    get: (identity, version) => ipcRenderer.invoke(IPC.avatarGet, identity, version),
  },
  chat: {
    list: () => ipcRenderer.invoke(IPC.chatList),
    create: (name) => ipcRenderer.invoke(IPC.chatCreate, name),
    rename: (id, name) => ipcRenderer.invoke(IPC.chatRename, id, name),
    remove: (id) => ipcRenderer.invoke(IPC.chatRemove, id),
    setLimit: (max) => ipcRenderer.invoke(IPC.chatSetLimit, max),
    messages: (chatId, before) => ipcRenderer.invoke(IPC.chatMessages, chatId, before),
    send: (chatId, body, extras) => ipcRenderer.invoke(IPC.chatSend, chatId, body, extras),
    sendMedia: (chatId, bytes, name, caption, extras) =>
      ipcRenderer.invoke(IPC.chatSendMedia, chatId, bytes, name, caption, extras),
    people: () => ipcRenderer.invoke(IPC.chatPeople),
    deleteMessage: (chatId, messageId) =>
      ipcRenderer.invoke(IPC.chatDeleteMessage, chatId, messageId),
    saveMedia: (chatId, mediaId, name, type) =>
      ipcRenderer.invoke(IPC.chatSaveMedia, chatId, mediaId, name, type),
    react: (chatId, messageId, emoji, on) =>
      ipcRenderer.invoke(IPC.chatReact, chatId, messageId, emoji, on),
    read: (chatId, messageId) => ipcRenderer.invoke(IPC.chatRead, chatId, messageId),
    listen: (on) => ipcRenderer.invoke(IPC.chatListen, on),
    onEvent: (cb) => {
      const listener = (_event: Electron.IpcRendererEvent, event: ChatEvent) => cb(event);
      ipcRenderer.on(IPC.chatEvent, listener);
      return () => ipcRenderer.removeListener(IPC.chatEvent, listener);
    },
    avatar: (accountId, version) => ipcRenderer.invoke(IPC.chatAvatar, accountId, version),
  },
  presence: {
    get: () => ipcRenderer.invoke(IPC.presenceGet),
    set: (status) => ipcRenderer.invoke(IPC.presenceSet, status),
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
    emojiPanel: () => ipcRenderer.invoke(IPC.appEmojiPanel) as Promise<void>,
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
