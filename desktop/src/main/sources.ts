/**
 * Capture sources: what desktopCapturer offers, resolved against
 * node-window-manager for the one thing desktopCapturer never gives you — the
 * owning process id.
 *
 * Verified empirically against a live Windows 11 / Electron 44 session: the
 * numeric part of a desktopCapturer window id ("window:2165034:0") is exactly
 * node-window-manager's Window.id (the HWND). No fuzzy title matching, no
 * ambiguity between two windows sharing a title — a direct id lookup.
 *
 * ## Why this caches
 *
 * Measured on real hardware: `desktopCapturer.getSources()` alone took
 * 3.3 seconds for 9 sources (two screens, seven windows); resolving PIDs via
 * node-window-manager took 15ms. The cost is entirely Chromium's own —
 * generating a thumbnail means actually capturing a frame from every screen
 * and window, and that dominates completely. There is no way to make the
 * underlying call fast.
 *
 * So instead of paying that cost when the user clicks "Share your screen",
 * it is paid continuously in the background from the moment the room
 * connects, and the picker reads whatever is already in the cache — which by
 * the time anyone clicks Share is normally a few seconds old at most. This is
 * the same trick every screen-share picker that feels instant is doing.
 */

import { desktopCapturer, systemPreferences, type NativeImage } from 'electron';
import { t } from './language';
import { windowManager } from 'node-window-manager';
import { isShareableWindow, type Bounds } from './window-filter';
import { perAppAudioSupported } from './audio';
import type { SourceInfo } from '../shared/ipc';
import { isLeagueClient, isLeagueGame, isLeagueSource } from '../shared/league';

export type { SourceInfo };

function hwndFromSourceId(id: string): number | null {
  const match = /^window:(\d+):/.exec(id);
  return match?.[1] ? Number(match[1]) : null;
}

function toDataUrl(image: NativeImage): string {
  return image.isEmpty() ? '' : image.toDataURL();
}

/** A window can close between enumeration and this call. */
function safeBounds(window: { getBounds(): Bounds }): Bounds | null {
  try {
    return window.getBounds();
  } catch {
    return null;
  }
}

/**
 * On macOS desktopCapturer fails outright ("Failed to get sources.") until
 * Zoia is allowed to record the screen. That says nothing about the fix, and
 * the fix is a trip to System Settings, so say that instead.
 */
function macScreenPermissionError(): Error | null {
  if (process.platform !== 'darwin') return null;
  const status = systemPreferences.getMediaAccessStatus('screen');
  return status === 'granted' ? null : new Error(t('picker.macScreenPermission'));
}

async function captureSources(): Promise<SourceInfo[]> {
  let sources: Electron.DesktopCapturerSource[];
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: false,
    });
  } catch (err) {
    throw macScreenPermissionError() ?? err;
  }

  // One native call, reused for every window source below rather than one
  // enumeration per source. This part is cheap (~15ms) — it is never the
  // reason to cache.
  const windowsById = new Map(windowManager.getWindows().map((w) => [w.id, w]));

  return sources.flatMap((source) => {
    const isWindow = source.id.startsWith('window:');
    const hwnd = isWindow ? hwndFromSourceId(source.id) : null;
    const nativeWindow = hwnd !== null ? windowsById.get(hwnd) : undefined;

    // Chromium can retain capture entries for hidden/ghost HWNDs after an
    // app closes a launcher window. Only expose windows that still exist in
    // the native enumeration and are visible to the user. Screens do not
    // have an HWND and are intentionally kept unchanged.
    // Visible is not enough: see window-filter.ts for the tray apps and
    // helper windows that pass it with nothing to show.
    if (isWindow) {
      if (!nativeWindow || !nativeWindow.isVisible()) {
        return [];
      }
      // If the League client window is parked/minimized after a match closes,
      // restore it into view so the post-game lobby is immediately shareable.
      if (
        !isShareableWindow(safeBounds(nativeWindow)) &&
        /leagueclient(ux)?\.exe$/i.test(nativeWindow.path || '')
      ) {
        try {
          nativeWindow.restore();
        } catch {
          // Ignore failure to restore if the window closed or is inaccessible.
        }
      }
      if (!isShareableWindow(safeBounds(nativeWindow))) {
        return [];
      }
    }

    // The PID is only ever used to capture that application's audio, which is
    // WASAPI and Windows-only. Elsewhere it stays null, so the renderer shares
    // the window silently rather than attempting a capture that cannot work.
    const processId = perAppAudioSupported ? (nativeWindow?.processId ?? null) : null;

    return [
      {
        id: source.id,
        name: source.name,
        kind: isWindow ? 'window' : 'screen',
        thumbnailDataUrl: toDataUrl(source.thumbnail),
        processId,
        processPath: nativeWindow?.path ?? null,
        hwnd,
      },
    ];
  });
}

let cache: SourceInfo[] | null = null;
let cacheTime = 0;
let inFlight: Promise<SourceInfo[]> | null = null;
let warmingActive = false;

/** Runs one capture, deduped against any already in flight. */
function refresh(): Promise<SourceInfo[]> {
  if (!inFlight) {
    inFlight = captureSources()
      .then((result) => {
        cache = result;
        cacheTime = Date.now();
        return result;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/**
 * Primes the source cache. We fetch once at startup so the picker is instant
 * without having to run a continuous 4s capture loop that wastes CPU/GPU and
 * spams WGC logs for uncapturable windows.
 */
export function startWarming(_intervalMs = 4000): void {
  warmingActive = true;
  // Nobody is waiting on a warm-up, so a failure here (on macOS, before Screen
  // Recording is allowed) is left for the picker's own request to report.
  refresh().catch(() => {});
}

export function stopWarming(): void {
  warmingActive = false;
}

/**
 * Returns the source list. If a warm cache exists, returns it immediately.
 * If warming is active and the cache is older than 2.5s, triggers a background refresh.
 */
export async function listSources(fresh = false): Promise<SourceInfo[]> {
  if (fresh) {
    cache = null;
    return refresh();
  }
  if (cache) {
    // Only refresh in the background if warming is active and cache is stale.
    // When warming is stopped (e.g. during a live broadcast or idle), avoid
    // invoking desktopCapturer which burns CPU/GPU.
    if (warmingActive && Date.now() - cacheTime > 2500) {
      refresh().catch(() => {});
    } else {
      findLeagueWindows();
    }
    return cache;
  }
  return refresh();
}

// The source most recently chosen in the renderer's picker UI. The display
// media handler (registered in index.ts) reads this to resolve whatever
// getDisplayMedia() call follows the choice — see docs/adr for why: once a
// session has a setDisplayMediaRequestHandler, Chromium's own picker never
// appears at all, so this *is* the picker.
let selected: { id: string; name: string; processId: number | null } | null = null;

export function selectSource(source: { id: string; name: string; processId: number | null }): void {
  selected = source;
}

/**
 * A shared window's current title, so its label can follow it: a browser tab
 * or a document changes the title long after the share started. Null once
 * the window is gone.
 */
export function windowTitle(hwnd: number): string | null {
  // On macOS node-window-manager answers with the owning application's name
  // (kCGWindowOwnerName), not the window's title, which would replace a
  // precise label with a vaguer one three seconds into the share.
  if (process.platform === 'darwin') return null;
  try {
    const window = windowManager.getWindows().find((w) => w.id === hwnd);
    return window?.getTitle() || null;
  } catch {
    return null;
  }
}

export function getSelectedSource() {
  return selected;
}

/**
 * Fast resolution of League of Legends windows directly via native window
 * manager (~15ms) without calling desktopCapturer or generating thumbnails.
 * Used during active broadcasts to follow match transitions without burning
 * CPU/GPU or triggering WGC capture warnings.
 */
export function findLeagueWindows(): {
  game: SourceInfo | null;
  client: SourceInfo | null;
} {
  if (process.platform !== 'win32') {
    return { game: null, client: null };
  }

  let windows: ReturnType<typeof windowManager.getWindows>;
  try {
    windows = windowManager.getWindows();
  } catch {
    return { game: null, client: null };
  }

  let game: SourceInfo | null = null;
  let client: SourceInfo | null = null;

  for (const win of windows) {
    let path = '';
    let title = '';
    try {
      path = win.path || '';
      title = win.getTitle() || '';
    } catch {
      continue;
    }

    const isPotentialLeague =
      /league of legends\.exe$/i.test(path) ||
      /leagueclient(ux)?\.exe$/i.test(path) ||
      /league of legends/i.test(title);

    if (!isPotentialLeague) continue;

    try {
      if (!win.isVisible() || !isShareableWindow(safeBounds(win))) {
        if (/leagueclient(ux)?\.exe$/i.test(path)) {
          win.restore();
        }
      }
      if (!win.isVisible() || !isShareableWindow(safeBounds(win))) {
        continue;
      }
    } catch {
      continue;
    }

    const source: SourceInfo = {
      id: `window:${win.id}:0`,
      name: title,
      kind: 'window',
      thumbnailDataUrl: '',
      processId: perAppAudioSupported ? (win.processId ?? null) : null,
      processPath: path || null,
      hwnd: win.id,
    };

    if (isLeagueGame(source) && !game) {
      game = source;
    } else if (isLeagueClient(source) && !client) {
      client = source;
    }

    if (game && client) break;
  }

  if (cache) {
    const existingClient = cache.find(isLeagueClient);
    if (client && existingClient?.thumbnailDataUrl) {
      client.thumbnailDataUrl = existingClient.thumbnailDataUrl;
    }
    const existingGame = cache.find(isLeagueGame);
    if (game && existingGame?.thumbnailDataUrl) {
      game.thumbnailDataUrl = existingGame.thumbnailDataUrl;
    }

    cache = cache.filter((s) => !isLeagueSource(s));
    if (client) cache.push(client);
    if (game) cache.push(game);
  }

  return { game, client };
}
