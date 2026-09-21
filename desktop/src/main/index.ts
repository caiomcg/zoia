import { app, BrowserWindow, ipcMain, session, shell } from 'electron';
import { join } from 'node:path';
import * as pairing from './pairing';
import * as api from './api';
import * as sources from './sources';
import { IPC } from '../shared/ipc';

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0b0c0e',
    autoHideMenuBar: true,
    webPreferences: {
      // Must be CJS: see electron.vite.config.ts for why.
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
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

  ipcMain.handle(IPC.getToken, () => api.getToken());

  ipcMain.handle(IPC.stageGet, () => api.stageGet());
  ipcMain.handle(IPC.stageClaim, () => api.stageClaim());
  ipcMain.handle(IPC.stageRelease, () => api.stageRelease());

  ipcMain.handle(IPC.sourcesList, () => sources.listSources());
  ipcMain.handle(
    IPC.sourcesSelect,
    (_event, source: { id: string; name: string; processId: number | null }) => {
      sources.selectSource(source);
    },
  );
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

app.whenReady().then(async () => {
  registerIpc();
  registerDisplayMediaHandler();
  createWindow();

  // safeStorage needs the app to be ready on Windows, so this is the first
  // point at which restoring a stored credential can succeed.
  await pairing.restoreSession();
  mainWindow?.webContents.send('zoia:pairing:changed', pairing.getStatus());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
