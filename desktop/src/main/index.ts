import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from 'electron';
import { join } from 'node:path';
import * as pairing from './pairing';
import * as config from './config';
import { INVITE_FILENAME } from './invite';
import * as api from './api';
import * as sources from './sources';
import * as audioCapture from './audio';
import * as encoder from './encoder';
import * as capture from './capture';
import { getCloseToTray, installTray, setCloseToTray, showWindow } from './tray';
import { isDevToolsEnabled, openDevTools, setDevToolsEnabled } from './devtools';
import * as language from './language';
import { isLanguagePreference } from '../shared/i18n';
import { IPC } from '../shared/ipc';
import type { GpuStatus } from '../shared/ipc';
import {
  checkForUpdate,
  getUpdaterConfig,
  installCurrentUpdate,
  currentReleaseNotes,
  resetUpdaterConfig,
  runUpdateCheck,
  saveUpdaterConfig,
  startUpdater,
  stopUpdater,
} from './updater';

let mainWindow: BrowserWindow | null = null;

/**
 * GPU switches for the capture/compositing path.
 *
 * Note on hardware *encoding*: it does not happen here, and these switches
 * cannot make it happen. Measured on this machine (RTX 4070 SUPER, driver
 * 32.0.16.1047): navigator.mediaCapabilities.encodingInfo() reports
 * powerEfficient=false for H.264, VP8, VP9 and AV1 at every resolution, and
 * a live broadcast reports encoderImplementation "OpenH264". Stock Chrome on
 * the same machine reports exactly the same, so this is Chromium's WebRTC
 * stack rather than anything Electron or this app does. Getting NVENC would
 * mean encoding natively and bypassing Chromium's WebRTC encoder entirely.
 *
 * Software H.264 sustains 1080p60 at ~12Mbps here; 4K is where it hurts.
 *
 * Chromium will fall back to *software* H.264 without complaining, and at
 * 1080p60 (let alone 4K) that pins several CPU cores — which shows up as
 * laggy, blurry video for viewers and, because the same process relays
 * captured audio over IPC, as periodic gaps in that audio too. Both symptoms
 * have one cause.
 *
 * These switches must be set before app ready, which is why this runs at
 * module scope.
 */
function requestHardwareEncoding(): void {
  app.commandLine.appendSwitch('ignore-gpu-blocklist');

  // Chromium throttles renderers that are not in the foreground: timers are
  // clamped, rendering is suspended, and occluded windows get backgrounded
  // outright. For an ordinary app that saves battery. For this one it stops
  // the broadcast, because the capture and encode loop lives in the renderer
  // — and the moment you share a window you switch *to* that window, putting
  // Zoia in the background. That is the stream halting when a window goes to
  // the background.
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

  // ANGLE on D3D11 is what lets the GPU process come up at all on Windows;
  // being explicit avoids falling back to the basic render driver.
  app.commandLine.appendSwitch('use-angle', 'd3d11');

  // Suppress Chromium/WebRTC internal C++ error spam (e.g. WGC CreateForWindow on invisible/tray windows)
  app.commandLine.appendSwitch('log-level', '3');

  // Windows Graphics Capture is deliberately left ENABLED (it is the default).
  // It hands frames over as D3D11 textures that can go straight into the
  // hardware encoder; the older GDI/DXGI capturer produces CPU-side frames,
  // and forcing that path was measured to leave WebRTC encoding in software
  // (encoderImplementation: OpenH264) on a machine whose chrome://gpu reports
  // "Video Encode: Hardware accelerated". The WGC "Source is not capturable"
  // errors in the log come from enumerating thumbnails for windows that
  // cannot be grabbed, not from the live broadcast, which kept running.
}

requestHardwareEncoding();

let gpuStatus: GpuStatus = {
  hardwareEncoder: false,
  windowCapture: false,
  encoderReason: null,
  adapter: 'unknown',
  gpuVendor: 'unknown',
  gpuEncoder: 'none',
};

/**
 * Reports what the GPU actually ended up doing, rather than assuming. The
 * adapter name is the part that matters most when encoding is unexpectedly
 * software: a real discrete GPU means a flag or blocklist problem, while
 * "Microsoft Basic Render Driver" means Chromium never reached the GPU at
 * all and no encoder flag will help.
 */
async function refreshGpuStatus(): Promise<void> {
  const features = app.getGPUFeatureStatus();
  const videoEncode = features.video_encode ?? 'unknown';

  let adapter = 'unknown';
  try {
    const info = (await app.getGPUInfo('complete')) as {
      gpuDevice?: Array<{ vendorId?: number; deviceId?: number; active?: boolean }>;
      auxAttributes?: Record<string, unknown>;
    };
    const aux = info.auxAttributes ?? {};
    const described = [aux.glRenderer, aux.glVendor, aux.driverVersion]
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
      .join(' | ');
    const active = (info.gpuDevice ?? []).find((d) => d.active) ?? (info.gpuDevice ?? [])[0];
    const ids = active
      ? `vendor=0x${(active.vendorId ?? 0).toString(16)} device=0x${(active.deviceId ?? 0).toString(16)}`
      : 'no adapter reported';
    adapter = described ? `${ids} | ${described}` : ids;
  } catch (err) {
    adapter = `lookup failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  const caps = capture.capabilities();
  gpuStatus = {
    hardwareEncoder: caps.hardwareEncoder,
    windowCapture: caps.windowCapture,
    encoderReason: caps.reason,
    // The addon's own view of the adapter is the one that matters, since it is
    // the device the encoder will actually run on. Chromium's is kept because
    // it names the card in a way people recognise.
    adapter: caps.adapter || adapter,
    gpuVendor: caps.vendor,
    gpuEncoder: caps.encoder,
  };
  console.log('[gpu] encoder path:', caps.encoder, 'on', caps.vendor, caps.adapter);
  if (caps.reason) console.log('[gpu]', caps.reason);

  console.log('[gpu] video_encode:', videoEncode);
  console.log('[gpu] video_decode:', features.video_decode ?? 'unknown');
  console.log('[gpu] gpu_compositing:', features.gpu_compositing ?? 'unknown');
  console.log('[gpu] adapter:', adapter);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0b0c0e',
    // No menu at all, rather than one hidden until Alt is pressed: the app
    // has nothing to put in it, and what was appearing was Electron's own
    // default with its developer tools.
    autoHideMenuBar: true,
    icon: join(__dirname, '../../build/icon.png'),
    webPreferences: {
      // Must be CJS: see electron.vite.config.ts for why.
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // The per-window counterpart to the switches above: without it this
      // window still gets throttled once it loses focus, which is exactly
      // when a broadcast needs it running.
      backgroundThrottling: false,
    },
  });

  // Anything the app doesn't render itself opens in the real browser instead
  // of a second Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
      if (isDevToolsEnabled()) {
        mainWindow?.webContents.toggleDevTools();
        event.preventDefault();
      }
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.pairingStatus, () => pairing.getRestoredStatus());

  ipcMain.handle(IPC.pairingStart, (_event, deviceName?: string) => pairing.pair(deviceName));

  ipcMain.handle(IPC.pairingUseInvite, (_event, path: string) => pairing.useInvite(path));

  // The dialog lives in main because the renderer has no filesystem access at
  // all, by design — it receives a status back, never a path or a token.
  ipcMain.handle(IPC.pairingChooseInvite, async () => {
    const result = await dialog.showOpenDialog({
      title: language.t('pair.dialogTitle'),
      defaultPath: INVITE_FILENAME,
      filters: [
        { name: language.t('pair.dialogInvite'), extensions: ['json'] },
        { name: language.t('pair.dialogAll'), extensions: ['*'] },
      ],
      properties: ['openFile'],
    });
    const [path] = result.filePaths;
    if (result.canceled || !path) return null;
    return pairing.useInvite(path);
  });

  ipcMain.handle(IPC.getToken, (_event, room?: string) =>
    api.getToken(typeof room === 'string' ? room : undefined),
  );
  ipcMain.handle(IPC.roomsList, () => api.roomsList());
  ipcMain.handle(IPC.roomsCreate, (_event, name: string) => api.roomsCreate(String(name)));
  ipcMain.handle(IPC.roomsRename, (_event, id: string, name: string) =>
    api.roomsRename(String(id), String(name)),
  );
  ipcMain.handle(IPC.roomsRemove, (_event, id: string) => api.roomsRemove(String(id)));

  ipcMain.handle(IPC.gpuStatus, () => gpuStatus);

  ipcMain.handle(IPC.updaterConfigGet, () => getUpdaterConfig());
  ipcMain.handle(IPC.updaterConfigSave, (_event, next) => saveUpdaterConfig(next));
  ipcMain.handle(IPC.updaterConfigReset, () => resetUpdaterConfig());
  ipcMain.handle(IPC.updaterCheck, () => checkForUpdate(true));
  ipcMain.handle(IPC.updaterInstall, () => installCurrentUpdate());
  ipcMain.handle(IPC.updaterReleaseNotes, () => currentReleaseNotes());
  ipcMain.handle(IPC.updaterOpenInstaller, (_event, installerUrl: unknown) => {
    if (typeof installerUrl !== 'string') throw new Error('Installer URL is required');
    const url = new URL(installerUrl);
    if (url.protocol !== 'https:') throw new Error('Installer URL must use HTTPS');
    return shell.openExternal(url.toString());
  });
  ipcMain.handle(IPC.appVersion, () => app.getVersion());
  const languageState = () => ({
    preference: language.getPreference(),
    language: language.currentLanguage(),
    system: language.systemLanguage(),
  });
  ipcMain.handle(IPC.languageGet, () => languageState());
  ipcMain.handle(IPC.languageSet, (_event, next: unknown) => {
    if (isLanguagePreference(next)) language.setPreference(next);
    return languageState();
  });

  ipcMain.handle(IPC.trayCloseGet, () => getCloseToTray());
  ipcMain.handle(IPC.trayCloseSet, (_event, value: boolean) => setCloseToTray(value === true));
  ipcMain.handle(IPC.devToolsGet, () => isDevToolsEnabled());
  ipcMain.handle(IPC.devToolsSet, (_event, value: boolean) =>
    setDevToolsEnabled(value === true, mainWindow),
  );
  ipcMain.handle(IPC.devToolsOpen, () => {
    if (isDevToolsEnabled()) {
      openDevTools(mainWindow);
    }
  });

  ipcMain.handle(IPC.stageGet, () => api.stageGet());
  ipcMain.handle(IPC.stageClaim, () => api.stageClaim());
  ipcMain.handle(IPC.stageRelease, () => api.stageRelease());

  ipcMain.handle(IPC.sourcesList, (_event, fresh?: boolean) => sources.listSources(fresh === true));
  ipcMain.handle(
    IPC.sourcesSelect,
    (_event, source: { id: string; name: string; processId: number | null }) => {
      sources.selectSource(source);
    },
  );

  ipcMain.handle(IPC.sourcesTitle, (_event, hwnd: number) =>
    typeof hwnd === 'number' ? sources.windowTitle(hwnd) : null,
  );

  ipcMain.handle(IPC.renameDevice, (_event, name: string) => api.renameDevice(name));

  ipcMain.handle(
    IPC.encoderStart,
    async (
      _event,
      options: Omit<encoder.EncoderOptions, 'frames' | 'whipUrl' | 'whipToken' | 'gpuVendor'> & {
        hwnd: number | null;
        sourceName: string;
        sourceKind: string;
      },
    ) => {
      if (!mainWindow) return;
      // Refreshing picker thumbnails while live competes with the encoder
      // for the main process.
      sources.stopWarming();

      try {
        // Fetched here, not in the renderer: the WHIP token is a credential
        // to publish into the room, and the renderer never needs one. The
        // server only answers for a participant with a claimed broadcast slot.
        const whip = await api.whipGet({
          sourceName: options.sourceName,
          sourceKind: options.sourceKind,
        });
        return await startEncoding(mainWindow, {
          ...options,
          whipUrl: whip.url,
          whipToken: whip.token,
        });
      } catch (err) {
        // Capture can refuse before ffmpeg is ever spawned — a window that has
        // gone, a minimised one, an adapter with no encoder. Those threw
        // straight back at the renderer and were never reported, so the only
        // record was whatever the person reading the dialog chose to retype.
        const error = err instanceof Error ? err : new Error(String(err));
        void api.report({
          kind: 'gpu-start-failed',
          message: error.message,
          stack: error.stack,
          context: attemptContext(options),
        });
        capture.stop();
        sources.startWarming();
        throw error;
      }
    },
  );

  function attemptContext(options: {
    hwnd: number | null;
    framerate: number;
    bitrate: number;
    withAudio: boolean;
    sourceName?: string;
    sourceKind?: string;
  }): string {
    return [
      `vendor=${gpuStatus.gpuVendor} encoder=${gpuStatus.gpuEncoder}`,
      `adapter=${gpuStatus.adapter}`,
      `windowCapture=${gpuStatus.windowCapture} hwnd=${options.hwnd ?? 'screen'}`,
      `framerate=${options.framerate} bitrate=${options.bitrate} audio=${options.withAudio}`,
    ].join('\n');
  }

  async function startEncoding(
    mainWindow: BrowserWindow,
    options: Omit<encoder.EncoderOptions, 'frames' | 'gpuVendor'> & { hwnd: number | null },
  ): Promise<void> {
    // Nobody picks a new source mid-broadcast, so refreshing the picker's
    // thumbnail cache from here on buys nothing and repeatedly logs WGC
    // "Source is not capturable" for windows it cannot grab.
    sources.stopWarming();

    if (options.hwnd !== null) {
      // Native path: WGC captures the window. On an NVIDIA adapter the addon
      // also encodes it, without the pixels ever leaving the GPU, and ffmpeg
      // only muxes. On a Radeon or an Intel GPU it hands back raw frames and
      // ffmpeg encodes them with AMF or Quick Sync — `info.output` says
      // which, and buildArgs follows it.
      let sampleFrames = 0;

      let info: ReturnType<typeof capture.start>;
      try {
        info = capture.start(
          options.hwnd,
          options.framerate,
          options.bitrate,
          (packet) => {
            if (info.output === 'bgra') {
              if (sampleFrames < 5 || sampleFrames % 120 === 0) {
                let nonZero = 0;
                const step = Math.max(4, Math.floor(packet.length / 5000));
                for (let i = 0; i < packet.length - 4; i += step) {
                  if (packet[i] !== 0 || packet[i + 1] !== 0 || packet[i + 2] !== 0) {
                    nonZero++;
                  }
                }
                console.log(
                  `[gpu-diag] frame ${sampleFrames}: ${packet.length} bytes, nonZeroPixels=${nonZero}/5000 (${Math.round((nonZero / 5000) * 100)}%)`,
                );
              }
              sampleFrames++;
            }
            encoder.writeFrame(packet);
          },
          (message) =>
            mainWindow?.webContents.send(IPC.encoderStatus, {
              running: false,
              fps: 0,
              encoder: encoder.encoderInUse(),
              width: 0,
              height: 0,
              error: message,
            }),
        );
      } catch (err) {
        sources.startWarming();
        throw err;
      }
      if (info.fallbackReason) {
        // NVENC was there and declined — almost always a driver older than
        // the headers this was built against. The broadcast carries on over
        // the readback path, but the reason belongs in the log rather than
        // being invisible.
        console.log('[gpu] NVENC declined, falling back to ffmpeg:', info.fallbackReason);
      }
      console.log(`[gpu] capturing ${info.adapter} -> ${info.output} (${info.vendor})`);
      if (info.fallbackReason) {
        void api.report({
          kind: 'gpu-nvenc-fallback',
          message: info.fallbackReason,
          context: attemptContext(options),
        });
      }
      await encoder.start(mainWindow, { ...options, frames: info });
    } else {
      await encoder.start(mainWindow, { ...options, frames: null, gpuVendor: gpuStatus.gpuVendor });
    }

    // Only a window carries audio; a screen share is deliberately silent.
    if (options.withAudio && options.processId !== null) {
      audioCapture.startCapture(mainWindow, options.processId, encoder.writeAudio);
    }
  }

  // ffmpeg can die on its own — a rejected argument, a broken WHIP endpoint —
  // and the capture has to come down with it or it keeps feeding a pipe that
  // is gone.
  encoder.setOnExit(() => {
    capture.stop();
    audioCapture.stopCapture();
    sources.startWarming();
    void api.whipRelease().catch(() => {});
  });

  ipcMain.handle(IPC.encoderStop, async () => {
    capture.stop();
    await encoder.shutdown();
    audioCapture.stopCapture();
    sources.startWarming();
    // ffmpeg's own WHIP teardown request does not reliably reach the SFU —
    // measured: "Failed to read response from DELETE". Removing the publisher
    // server-side makes stopping definite instead of waiting on a timeout.
    await api.whipRelease().catch(() => {});
  });

  ipcMain.handle(IPC.audioStart, (_event, processId: number | null) => {
    if (!mainWindow) return;
    // Nobody picks a new source mid-broadcast, so refreshing the picker's
    // thumbnail cache from here on buys nothing — and it is not free: each
    // refresh drives desktopCapturer across every window (repeatedly logging
    // WGC "Source is not capturable" for ones it cannot grab) on the same
    // process that relays captured audio to the renderer.
    sources.stopWarming();
    audioCapture.startCapture(mainWindow, processId);
  });
  ipcMain.handle(IPC.audioStop, () => {
    audioCapture.stopCapture();
    sources.startWarming();
  });
}

/**
 * Once this is set, Chromium's own screen-share picker never appears again —
 * for any getDisplayMedia() call, from any origin this session ever loads.
 * Our own SourcePicker UI *is* the picker; this handler just resolves
 * whatever the renderer chose immediately beforehand via sourcesSelect.
 */
function registerDisplayMediaHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    const chosen = sources.getSelectedSource();
    if (!chosen) {
      // Nothing was chosen — refuse rather than let Chromium fall back to
      // whatever it feels like.
      console.warn('[display-media] getDisplayMedia() called with no source selected');
      callback({});
      return;
    }
    console.log(
      `[display-media] resolving with "${chosen.name}" (pid ${chosen.processId ?? 'unresolved'})`,
    );
    callback({ video: { id: chosen.id, name: chosen.name } });
  });
}

/**
 * Last line of defence.
 *
 * An unhandled error in the main process shows Windows' "A JavaScript error
 * occurred" dialog and takes the app with it — which is exactly how a broken
 * pipe to ffmpeg ended a broadcast. Reporting and carrying on is better than
 * dying: whatever failed, the room connection usually has not.
 */
function installCrashReporting(): void {
  process.on('uncaughtException', (err) => {
    console.error('[uncaught]', err);
    void api.report({
      kind: 'main-uncaught',
      message: err?.message ?? String(err),
      stack: err?.stack,
    });
  });

  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    console.error('[unhandled-rejection]', err);
    void api.report({
      kind: 'main-unhandled-rejection',
      message: err.message,
      stack: err.stack,
    });
  });

  ipcMain.on(IPC.report, (_event, entry: { kind: string; message: string; stack?: string }) => {
    void api.report(entry);
  });
}

// One copy at a time: a second launch (the exe clicked again while this one
// sits in the tray) brings this window back instead of joining the room as the
// same device twice.
const isFirstInstance = app.requestSingleInstanceLock();
if (!isFirstInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showWindow(mainWindow);
    void runUpdateCheck(false);
  });
}

app.whenReady().then(async () => {
  // The second copy is on its way out; it must not open a window first.
  if (!isFirstInstance) return;
  installCrashReporting();
  // Created before the window, so its close handler is attached to it.
  installTray(() => mainWindow, join(__dirname, '../../build/tray.png'));
  // Removes the default menu outright, so Alt reveals nothing.
  Menu.setApplicationMenu(null);
  await refreshGpuStatus();
  registerIpc();
  registerDisplayMediaHandler();
  createWindow();

  // Needs no auth, so it starts immediately rather than waiting on pairing —
  // every second before the user can reach the picker is a second the first,
  // expensive capture gets to finish in the background.
  sources.startWarming();

  // Resolve which server this copy points at before anything tries to reach
  // one. A release build carries no URL and no token; both normally arrive in
  // an invite file (see src/main/config.ts).
  await config.init();

  // safeStorage needs the app to be ready on Windows, so this is the first
  // point at which restoring a stored credential can succeed.
  await pairing.restoreSession();
  mainWindow?.webContents.send('zoia:pairing:changed', pairing.getStatus());
  void startUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopUpdater();
  sources.stopWarming();
  audioCapture.stopCapture();
  capture.stop();
  encoder.shutdown();
  if (process.platform !== 'darwin') app.quit();
});
