/**
 * Whether running browsers will show their videos in a broadcast, and the
 * restart that makes them. See src/shared/browser-video.ts for the why.
 *
 * Windows only: the black-video problem is DirectComposition's, and so is
 * the fix. Elsewhere every call answers "nothing to do".
 */

import { execFile, spawn } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { app, shell } from 'electron';
import { windowManager } from 'node-window-manager';
import {
  BROWSERS,
  FIREFOX_PREFS,
  FIREFOX_RESUME_ONCE,
  RESTORE_FLAG,
  VIDEO_FLAGS,
  argumentsWithVideoFlags,
  argumentsWithoutVideoFlags,
  defaultFirefoxProfiles,
  isMainProcess,
  missingFirefoxPrefs,
  missingVideoFlags,
  prefsJsWith,
  prefsJsWithout,
  type BrowserSpec,
  type BrowserVideoFix,
  type BrowserVideoStatus,
} from '../shared/browser-video';

interface ProcessRow {
  pid: number;
  path: string | null;
  commandLine: string;
}

/**
 * Command lines of the browsers' processes, through WMI. Node has no way to
 * read another process's command line, and PowerShell answers in about a
 * second (several on its first start), which is why this runs when the
 * picker opens and not in a loop.
 */
function listBrowserProcesses(): Promise<ProcessRow[]> {
  const filter = BROWSERS.map((b) => `Name='${b.exe}'`).join(' OR ');
  const script = [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    `@(Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId, ExecutablePath, CommandLine) | ConvertTo-Json -Compress`,
  ].join('; ');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 20_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        const text = stdout.trim();
        if (!text) return resolve([]);
        try {
          const parsed: unknown = JSON.parse(text);
          const rows = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{
            ProcessId?: number;
            ExecutablePath?: string | null;
            CommandLine?: string | null;
          }>;
          resolve(
            rows
              .filter((r) => typeof r.ProcessId === 'number' && r.CommandLine)
              .map((r) => ({
                pid: r.ProcessId as number,
                path: r.ExecutablePath ?? null,
                commandLine: r.CommandLine as string,
              })),
          );
        } catch (parseErr) {
          reject(parseErr);
        }
      },
    );
  });
}

function mainProcessesOf(browser: BrowserSpec, rows: ProcessRow[]): ProcessRow[] {
  return rows.filter(
    (r) =>
      r.path !== null &&
      basename(r.path).toLowerCase() === browser.exe &&
      isMainProcess(r.commandLine, browser.kind),
  );
}

// ---- Firefox: preferences in the default profiles

function firefoxDataFolder(): string {
  return join(app.getPath('appData'), 'Mozilla', 'Firefox');
}

/** The prefs.js of each profile Firefox opens by default. */
function firefoxPrefsFiles(): string[] {
  let ini: string;
  try {
    ini = readFileSync(join(firefoxDataFolder(), 'profiles.ini'), 'utf8');
  } catch {
    return [];
  }
  return defaultFirefoxProfiles(ini).map(({ path, relative }) =>
    join(relative && !isAbsolute(path) ? join(firefoxDataFolder(), path) : path, 'prefs.js'),
  );
}

function firefoxReady(): boolean {
  const files = firefoxPrefsFiles();
  if (files.length === 0) return false;
  return files.every((file) => {
    try {
      return missingFirefoxPrefs(readFileSync(file, 'utf8')).length === 0;
    } catch {
      return false;
    }
  });
}

/**
 * Turns the fix on (the prefs set off) or off (their lines removed, so
 * Firefox's defaults apply), and asks for the session back once either way.
 * Written only while Firefox is closed: it rewrites prefs.js on exit.
 */
function writeFirefoxPrefs(on: boolean): void {
  for (const file of firefoxPrefsFiles()) {
    let current = '';
    try {
      current = readFileSync(file, 'utf8');
    } catch {
      // A profile never started has no prefs.js yet; this creates it.
    }
    const base = on
      ? prefsJsWith(current, { ...FIREFOX_PREFS })
      : prefsJsWithout(current, Object.keys(FIREFOX_PREFS));
    writeFileSync(file, prefsJsWith(base, { [FIREFOX_RESUME_ONCE]: true }));
  }
}

// ---- Chromium: flags on the command line and in the shortcuts

/** Where Windows keeps the shortcuts people open a browser from. */
function shortcutFolders(): string[] {
  const appData = app.getPath('appData');
  const folders = [
    join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar'),
    join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    app.getPath('desktop'),
  ];
  // Shared by every account on the machine. The Start menu one usually needs
  // an administrator, so a failure there is counted and otherwise ignored.
  if (process.env.PUBLIC) folders.push(join(process.env.PUBLIC, 'Desktop'));
  if (process.env.ProgramData) {
    folders.push(join(process.env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  }
  return folders;
}

/** Adds the flags to (or takes them from) every shortcut that opens this browser; returns how many changed. */
function updateShortcuts(browser: BrowserSpec, on: boolean): number {
  const rewrite = on ? argumentsWithVideoFlags : argumentsWithoutVideoFlags;
  let updated = 0;
  for (const folder of shortcutFolders()) {
    let names: string[];
    try {
      names = readdirSync(folder).filter((n) => n.toLowerCase().endsWith('.lnk'));
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(folder, name);
      try {
        const link = shell.readShortcutLink(path);
        if (basename(link.target).toLowerCase() !== browser.exe) continue;
        const args = rewrite(link.args ?? '');
        if (args === null) continue;
        if (shell.writeShortcutLink(path, 'update', { ...link, args })) updated += 1;
      } catch {
        // Unreadable, or not ours to write (a shared shortcut without admin).
      }
    }
  }
  return updated;
}

// ---- Both

function statusOf(browser: BrowserSpec, rows: ProcessRow[]): BrowserVideoStatus {
  const mains = mainProcessesOf(browser, rows);
  const running = mains.length > 0;
  const ready =
    running &&
    (browser.kind === 'firefox'
      ? firefoxReady()
      : mains.every((r) => missingVideoFlags(r.commandLine).length === 0));
  return { id: browser.id, name: browser.name, kind: browser.kind, running, ready };
}

export async function browserVideoStatus(): Promise<BrowserVideoStatus[]> {
  if (process.platform !== 'win32') return [];
  const rows = await listBrowserProcesses();
  return BROWSERS.map((browser) => statusOf(browser, rows));
}

/** Whether the browser still has a window someone could be using. */
function hasVisibleWindow(browser: BrowserSpec): boolean {
  try {
    return windowManager
      .getWindows()
      .some(
        (w) =>
          basename(w.path || '').toLowerCase() === browser.exe && w.isVisible() && w.getTitle(),
      );
  } catch {
    return true;
  }
}

function taskkill(args: string[]): Promise<void> {
  return new Promise((resolve) => {
    execFile('taskkill', args, { windowsHide: true, timeout: 10_000 }, () => resolve());
  });
}

async function waitUntilClosed(browser: BrowserSpec, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 750));
    const rows = await listBrowserProcesses();
    if (mainProcessesOf(browser, rows).length === 0) return true;
  }
  return false;
}

/**
 * Closes the browser as its own X button would and waits for it to go.
 *
 * `taskkill` without /F asks each window to close, so the browser saves its
 * session. What is left after that has no window to lose: Edge's startup
 * boost and Chrome's background apps keep the main process alive with
 * none. Only then is it ended by force. A browser that still shows a window
 * is never forced; the person is asked to close it instead.
 */
async function closeBrowser(browser: BrowserSpec): Promise<boolean> {
  await taskkill(['/IM', browser.exe]);
  if (await waitUntilClosed(browser, 15_000)) return true;
  if (hasVisibleWindow(browser)) return false;
  await taskkill(['/F', '/T', '/IM', browser.exe]);
  return waitUntilClosed(browser, 5_000);
}

/**
 * Closes the browser, puts the fix where it will last (or takes it away,
 * with `on` false), and starts it again with its tabs: flags on the command
 * line and in the shortcuts for Chromium, preferences in the default
 * profiles for Firefox.
 */
export async function setBrowserVideoFix(id: string, on: boolean): Promise<BrowserVideoFix> {
  if (process.platform !== 'win32') return { ok: false, reason: 'unsupported' };
  const browser = BROWSERS.find((b) => b.id === id);
  if (!browser) return { ok: false, reason: 'not-found' };

  try {
    const rows = await listBrowserProcesses();
    const executable = mainProcessesOf(browser, rows)[0]?.path ?? null;
    if (!executable) return { ok: false, reason: 'not-found' };

    if (!(await closeBrowser(browser))) return { ok: false, reason: 'still-running' };

    if (browser.kind === 'firefox') {
      writeFirefoxPrefs(on);
      spawn(executable, [], { detached: true, stdio: 'ignore' }).unref();
      return { ok: true, shortcutsUpdated: 0 };
    }

    const shortcutsUpdated = updateShortcuts(browser, on);
    const args = on ? [...VIDEO_FLAGS, RESTORE_FLAG] : [RESTORE_FLAG];
    spawn(executable, args, { detached: true, stdio: 'ignore' }).unref();
    return { ok: true, shortcutsUpdated };
  } catch (err) {
    return { ok: false, reason: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}
