import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from 'electron';
import { join } from 'node:path';
import * as pairing from './pairing';
import * as config from './config';
import { INVITE_FILENAME } from './invite';
import * as api from './api';
import * as sources from './sources';
import * as audioCapture from './audio';
import * as nvenc from './nvenc';
import * as capture from './capture';
import { IPC } from '../shared/ipc';
import type { GpuStatus } from '../shared/ipc';

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

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.pairingStatus, () => pairing.getStatus());

  ipcMain.handle(IPC.pairingStart, (_event, deviceName?: string) => pairing.pair(deviceName));

  ipcMain.handle(IPC.pairingUseInvite, (_event, path: string) => pairing.useInvite(path));

  // The dialog lives in main because the renderer has no filesystem access at
  // all, by design — it receives a status back, never a path or a token.
  ipcMain.handle(IPC.pairingChooseInvite, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose your Zoia invite',
      defaultPath: INVITE_FILENAME,
      filters: [
        { name: 'Zoia invite', extensions: ['json'] },
        { name: 'All files', extensions: ['*'] },
      ],
      properties: ['openFile'],
    });
    const [path] = result.filePaths;
    if (result.canceled || !path) return null;
    return pairing.useInvite(path);
  });

  ipcMain.handle(IPC.getToken, () => api.getToken());

  ipcMain.handle(IPC.gpuStatus, () => gpuStatus);

  ipcMain.handle(IPC.stageGet, () => api.stageGet());
  ipcMain.handle(IPC.stageClaim, (_event, force?: boolean) => api.stageClaim(force === true));
  ipcMain.handle(IPC.stageRelease, () => api.stageRelease());

  ipcMain.handle(IPC.sourcesList, () => sources.listSources());
  ipcMain.handle(
    IPC.sourcesSelect,
    (_event, source: { id: string; name: string; processId: number | null }) => {
      sources.selectSource(source);
    },
  );

  ipcMain.handle(IPC.ingressGet, () => api.ingressGet());
  ipcMain.handle(IPC.ingressRelease, () => api.ingressRelease());
  ipcMain.handle(IPC.renameDevice, (_event, name: string) => api.renameDevice(name));

  ipcMain.handle(
    IPC.nvencStart,
    (_event, options: Omit<nvenc.NvencOptions, 'frames'> & { hwnd: number | null }) => {
      if (!mainWindow) return;
      // Refreshing picker thumbnails while live competes with the encoder
      // for the main process.
      sources.stopWarming();

      if (options.hwnd !== null) {
        // Native path: WGC captures the window. On an NVIDIA adapter the addon
        // also encodes it, without the pixels ever leaving the GPU, and ffmpeg
        // only muxes. On a Radeon or an Intel GPU it hands back raw frames and
        // ffmpeg encodes them with AMF or Quick Sync — `info.output` says
        // which, and buildArgs follows it.
        const info = capture.start(
          options.hwnd,
          options.framerate,
          options.bitrate,
          (packet) => nvenc.writeFrame(packet),
          (message) =>
            mainWindow?.webContents.send(IPC.nvencStatus, {
              running: false,
              fps: 0,
              encoder: 'nvenc',
              width: 0,
              height: 0,
              error: message,
            }),
        );
        if (info.fallbackReason) {
          // NVENC was there and declined — almost always a driver older than
          // the headers this was built against. The broadcast carries on over
          // the readback path, but the reason belongs in the log rather than
          // being invisible.
          console.log('[gpu] NVENC declined, falling back to ffmpeg:', info.fallbackReason);
        }
        console.log(`[gpu] capturing ${info.adapter} -> ${info.output} (${info.vendor})`);
        nvenc.start(mainWindow, { ...options, frames: info });
      } else {
        nvenc.start(mainWindow, { ...options, frames: null });
      }

      // Only a window carries audio; a screen share is deliberately silent.
      if (options.withAudio && options.processId !== null) {
        audioCapture.startCapture(mainWindow, options.processId, nvenc.writeAudio);
      }
    },
  );

  // ffmpeg can die on its own — a rejected argument, a broken WHIP endpoint —
  // and the capture has to come down with it or it keeps feeding a pipe that
  // is gone.
  nvenc.setOnExit(() => {
    capture.stop();
    audioCapture.stopCapture();
    sources.startWarming();
  });

  ipcMain.handle(IPC.nvencStop, () => {
    capture.stop();
    nvenc.shutdown();
    audioCapture.stopCapture();
    sources.startWarming();
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

app.whenReady().then(async () => {
  installCrashReporting();
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  sources.stopWarming();
  audioCapture.stopCapture();
  capture.stop();
  nvenc.shutdown();
  if (process.platform !== 'darwin') app.quit();
});
