/**
 * Developer tools access preference and toggle.
 *
 * Controls whether the DevTools can be opened via keyboard shortcuts
 * (F12, Ctrl+Shift+I) or from within the application settings.
 */

import { app, BrowserWindow } from 'electron';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

interface DevToolsPrefs {
  enabled: boolean;
}

const prefsPath = () => join(app.getPath('userData'), 'devtools.json');

function readPrefs(): DevToolsPrefs {
  try {
    const saved = JSON.parse(readFileSync(prefsPath(), 'utf8')) as Partial<DevToolsPrefs>;
    return { enabled: saved.enabled === true };
  } catch {
    return { enabled: false };
  }
}

function writePrefs(prefs: DevToolsPrefs): void {
  try {
    mkdirSync(dirname(prefsPath()), { recursive: true });
    writeFileSync(prefsPath(), JSON.stringify(prefs));
  } catch {
    // Remembering is a convenience; the choice still applies this session.
  }
}

let prefs: DevToolsPrefs | null = null;

function currentPrefs(): DevToolsPrefs {
  prefs ??= readPrefs();
  return prefs;
}

export function isDevToolsEnabled(): boolean {
  if (process.env.ELECTRON_RENDERER_URL) {
    return true;
  }
  return currentPrefs().enabled;
}

export function setDevToolsEnabled(enabled: boolean, window?: BrowserWindow | null): boolean {
  prefs = { enabled };
  writePrefs(prefs);
  if (!enabled && window && window.webContents.isDevToolsOpened()) {
    window.webContents.closeDevTools();
  }
  return enabled;
}

export function openDevTools(window?: BrowserWindow | null): void {
  if (!window) return;
  if (!window.webContents.isDevToolsOpened()) {
    window.webContents.openDevTools({ mode: 'detach' });
  } else {
    window.webContents.devToolsWebContents?.focus();
  }
}
