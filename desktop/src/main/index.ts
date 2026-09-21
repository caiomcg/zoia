import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import * as pairing from './pairing';
import * as api from './api';
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
}

app.whenReady().then(async () => {
  registerIpc();
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
