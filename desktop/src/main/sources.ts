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

import { desktopCapturer, screen, systemPreferences, type NativeImage } from 'electron';
import { t } from './language';
import { Window, windowManager } from 'node-window-manager';
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

/**
 * What a thumbnail actually costs, measured on a Radeon RX 9070 XT with
 * Electron 44, three runs each:
 *
 *   windowManager.getWindows() + filter              8ms
 *   getSources screen+window, thumbnail 320x180   3330ms
 *   getSources screen+window, thumbnail 0x0        320ms
 *   getSources screen+window, thumbnail 160x90    3320ms
 *   getSources window only, thumbnail 320x180     3165ms
 *   getSources screen only, thumbnail 320x180      285ms
 *
 * Two things follow. A thumbnail is a real capture of that window, so five
 * windows cost ~630ms each and shrinking the thumbnail buys nothing — 160x90
 * costs what 320x180 costs. And the *list* is not the expensive part: naming
 * every window takes 8ms, three hundred times less than picturing them.
 *
 * So they are fetched apart. Screens are few, change rarely and cost 285ms;
 * windows change constantly and are listed natively, with their pictures
 * filled in afterwards. See instantSources.
 */
async function getSourcesOfType(
  types: Array<'screen' | 'window'>,
): Promise<Electron.DesktopCapturerSource[]> {
  try {
    return await desktopCapturer.getSources({
      types,
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: false,
    });
  } catch (err) {
    throw macScreenPermissionError() ?? err;
  }
}

function toSourceInfo(
  sources: Electron.DesktopCapturerSource[],
  windowsById: Map<number, ReturnType<typeof windowManager.getWindows>[number]>,
): SourceInfo[] {
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

    let displayId: string | null = null;
    if (!isWindow) {
      if (source.display_id) {
        displayId = source.display_id;
      } else {
        const match = /^screen:(\d+):/.exec(source.id);
        const idx = match ? Number(match[1]) : 0;
        const displays = screen.getAllDisplays();
        const display = displays[idx] ?? displays[0];
        displayId = display ? String(display.id) : null;
      }
    }

    return [
      {
        id: source.id,
        name: source.name,
        kind: isWindow ? 'window' : 'screen',
        thumbnailDataUrl: toDataUrl(source.thumbnail),
        processId,
        processPath: nativeWindow?.path ?? null,
        hwnd,
        displayId,
      },
    ];
  });
}

async function captureSources(): Promise<SourceInfo[]> {
  // Snapshotted before the call, not after: a refresh takes 3.3 seconds, and a
  // window opened during it is legitimately missing from a result gathered
  // before it existed. Judged against the list afterwards it would look like a
  // window Chromium had refused, and be hidden from the instant list until the
  // next refresh — which is precisely the window someone is waiting to see.
  const asked = new Set(listWindows().map((w) => w.id));
  const sources = await getSourcesOfType(['screen', 'window']);
  // One native call, reused for every window source below rather than one
  // enumeration per source. This part is cheap (~15ms) — it is never the
  // reason to cache.
  const windowsById = new Map(windowManager.getWindows().map((w) => [w.id, w]));
  const mapped = toSourceInfo(sources, windowsById);
  rememberOffered(sources, asked);
  screenCache = mapped.filter((s) => s.kind === 'screen');
  screenCacheTime = Date.now();
  return mapped;
}

/**
 * Screens alone, kept for ten seconds.
 *
 * They are the one part of the instant list that still has to come from
 * desktopCapturer: a screen's id and `display_id` are what the Chromium path
 * resolves a getDisplayMedia call against, and synthesising them from
 * screen.getAllDisplays() would be guessing at Chromium's own indexing. At
 * 285ms for two monitors that is affordable once; at 8ms a window list is
 * affordable every time, which is why only this half is cached.
 */
const SCREEN_TTL_MS = 10_000;
let screenCache: SourceInfo[] | null = null;
let screenCacheTime = 0;

async function captureScreens(): Promise<SourceInfo[]> {
  if (screenCache && Date.now() - screenCacheTime < SCREEN_TTL_MS) return screenCache;
  const sources = await getSourcesOfType(['screen']);
  screenCache = toSourceInfo(sources, new Map());
  screenCacheTime = Date.now();
  return screenCache;
}

/**
 * Windows the native enumeration sees but desktopCapturer will not offer.
 *
 * They are not hypothetical: they are the windows behind the
 * "CreateForWindow failed ... Source is not capturable" pairs in the log.
 * Listing a window natively is listing one Chromium may refuse to capture,
 * and offering it in the picker would trade a stale list for one that fails
 * when clicked. A window that survives a full refresh without being offered
 * is recorded here and left out of the instant list; being offered clears it,
 * so nothing is suppressed permanently.
 */
const unofferedIds = new Set<string>();

function rememberOffered(sources: Electron.DesktopCapturerSource[], asked: Set<string>): void {
  const offered = new Set(sources.map((s) => s.id));
  for (const id of offered) unofferedIds.delete(id);
  for (const id of asked) {
    if (!offered.has(id)) unofferedIds.add(id);
  }
}

/**
 * The picker's list, as fast as it can honestly be produced: screens with
 * their pictures, and every window open right now without one.
 *
 * The thumbnails for those windows arrive on the next full refresh and the
 * picker swaps them in. That ordering is the whole point — the list being
 * right is what someone is waiting for when they click Share, and it is the
 * part that costs 8ms rather than 3.3 seconds.
 */
export async function instantSources(): Promise<SourceInfo[]> {
  const screens = await captureScreens().catch(() => screenCache ?? []);
  const windows = listWindows().filter((w) => !unofferedIds.has(w.id));
  // Pictures from whatever the last full refresh produced, by id.
  const thumbnails = new Map((cache ?? []).filter((s) => s.thumbnailDataUrl).map((s) => [s.id, s]));
  return [
    ...screens,
    ...windows.map((w) => {
      const pictured = thumbnails.get(w.id);
      return pictured ? { ...w, thumbnailDataUrl: pictured.thumbnailDataUrl } : w;
    }),
  ];
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

/**
 * Whether a window still exists. Windows Graphics Capture says nothing when
 * the window it is capturing closes — frames simply stop — so a broadcast
 * of a closed browser or game would stay "live" on its last frame forever.
 */
export function windowExists(hwnd: number): boolean {
  if (process.platform !== 'win32') return true;
  try {
    return new Window(hwnd).isWindow();
  } catch {
    return false;
  }
}

export function getSelectedSource() {
  return selected;
}

/**
 * The shareable windows open right now, straight from the native window
 * manager (~15ms) rather than desktopCapturer (seconds, for the thumbnails).
 * Nothing to show in a picker, but enough to tell which windows exist — and
 * the cached list is not refreshed while live, so it cannot answer that.
 */
export function listWindows(): SourceInfo[] {
  if (process.platform !== 'win32') return cache?.filter((s) => s.kind === 'window') ?? [];

  let windows: ReturnType<typeof windowManager.getWindows>;
  try {
    windows = windowManager.getWindows();
  } catch {
    return [];
  }
  return windows.flatMap((win) => {
    try {
      if (!win.isVisible() || !isShareableWindow(safeBounds(win))) return [];
      return [
        {
          id: `window:${win.id}:0`,
          name: win.getTitle() || '',
          kind: 'window' as const,
          thumbnailDataUrl: '',
          processId: perAppAudioSupported ? (win.processId ?? null) : null,
          processPath: win.path || null,
          hwnd: win.id,
        },
      ];
    } catch {
      return [];
    }
  });
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
