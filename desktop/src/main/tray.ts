/**
 * The system tray.
 *
 * Closing the window hides it to the tray instead of quitting, so a broadcast
 * or a channel you are listening in keeps going. The tray's menu is the way
 * back, and the way out. Whether closing hides or quits is a choice kept in the
 * user's data folder; hiding is the default. It can be changed from the tray
 * menu or from the settings dialog, and both read the same preference.
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
let prefs: TrayPrefs | null = null;
let rebuildMenu: () => void = () => {};
let quitting = false;
let toldAboutTray = false;

function currentPrefs(): TrayPrefs {
  prefs ??= readPrefs();
  return prefs;
}

export function getCloseToTray(): boolean {
  return currentPrefs().closeToTray;
}

/** Sets the preference and keeps the tray menu's checkbox in step with it. */
export function setCloseToTray(closeToTray: boolean): boolean {
  prefs = { closeToTray };
  writePrefs(prefs);
  rebuildMenu();
  return closeToTray;
}

/** Brings the window back from the tray, or from behind other windows. */
export function showWindow(window: BrowserWindow | null): void {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

export function installTray(getWindow: () => BrowserWindow | null, iconPath: string): void {
  tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip('Zoia');
  tray.on('click', () => showWindow(getWindow()));

  rebuildMenu = () => {
    tray?.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Abrir Zoia', click: () => showWindow(getWindow()) },
        {
          label: 'Manter na bandeja ao fechar',
          type: 'checkbox',
          checked: getCloseToTray(),
          click: (item) => setCloseToTray(item.checked),
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
  rebuildMenu();

  app.on('before-quit', () => {
    quitting = true;
  });

  // Attached per window, since the window can be recreated.
  app.on('browser-window-created', (_event, window) => {
    window.on('close', (event) => {
      if (quitting || !getCloseToTray()) return;
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
