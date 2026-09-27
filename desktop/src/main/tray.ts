/**
 * The system tray.
 *
 * Closing the window hides it to the tray instead of quitting, so a broadcast
 * or a channel you are listening in keeps going. The tray's menu is the way
 * back, and the way out. Whether closing hides or quits is a choice kept in the
 * user's data folder; hiding is the default.
 */

import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

interface TrayPrefs {
  closeToTray: boolean;
}

const prefsPath = () => join(app.getPath('userData'), 'tray.json');

function readPrefs(): TrayPrefs {
  try {
    const saved = JSON.parse(readFileSync(prefsPath(), 'utf8')) as Partial<TrayPrefs>;
    return { closeToTray: saved.closeToTray !== false };
  } catch {
    return { closeToTray: true };
  }
}

function writePrefs(prefs: TrayPrefs): void {
  try {
    mkdirSync(dirname(prefsPath()), { recursive: true });
    writeFileSync(prefsPath(), JSON.stringify(prefs));
  } catch {
    // Remembering is a convenience; the choice still applies this session.
  }
}

let tray: Tray | null = null;
let quitting = false;
let toldAboutTray = false;
let prefs: TrayPrefs = { closeToTray: true };
let refreshTrayMenu: (() => void) | null = null;

/** Brings the window back from the tray, or from behind other windows. */
export function showWindow(window: BrowserWindow | null): void {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

export function getCloseToTray(): boolean {
  return prefs.closeToTray;
}

export function setCloseToTray(closeToTray: boolean): boolean {
  prefs = { closeToTray };
  writePrefs(prefs);
  refreshTrayMenu?.();
  return prefs.closeToTray;
}

export function installTray(getWindow: () => BrowserWindow | null, iconPath: string): void {
  prefs = readPrefs();

  tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip('Zoia');
  tray.on('click', () => showWindow(getWindow()));

  const rebuildMenu = () => {
    tray?.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Abrir Zoia', click: () => showWindow(getWindow()) },
        {
          label: 'Manter na bandeja ao fechar',
          type: 'checkbox',
          checked: prefs.closeToTray,
          click: (item) => {
            prefs = { closeToTray: item.checked };
            writePrefs(prefs);
          },
        },
        { type: 'separator' },
        {
          label: 'Sair',
          click: () => {
            quitting = true;
            app.quit();
          },
        },
      ]),
    );
  };
  refreshTrayMenu = rebuildMenu;
  rebuildMenu();

  app.on('before-quit', () => {
    quitting = true;
  });

  // Attached per window, since the window can be recreated.
  app.on('browser-window-created', (_event, window) => {
    window.on('close', (event) => {
      if (quitting || !prefs.closeToTray) return;
      event.preventDefault();
      window.hide();
      // Said once per session, so a closed window that did not quit is not a
      // mystery the first time it happens.
      if (!toldAboutTray && process.platform === 'win32') {
        toldAboutTray = true;
        tray?.displayBalloon({
          title: 'Zoia continua aberto',
          content: 'Está na bandeja. Clique no ícone para voltar, ou em Sair para fechar.',
          iconType: 'info',
        });
      }
    });
  });
}
