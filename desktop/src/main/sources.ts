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

import { desktopCapturer, type NativeImage } from 'electron';
import { windowManager } from 'node-window-manager';
import { isShareableWindow, type Bounds } from './window-filter';

export interface SourceInfo {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  thumbnailDataUrl: string;
  /** The window's owning PID, when resolvable — the whole point of this app. */
  processId: number | null;
  /** Full executable path of the window's owning process, when available. */
  processPath: string | null;
}

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

async function captureSources(): Promise<SourceInfo[]> {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: false,
  });

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

    const processId = nativeWindow?.processId ?? null;

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
let inFlight: Promise<SourceInfo[]> | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

/** Runs one capture, deduped against any already in flight. */
function refresh(): Promise<SourceInfo[]> {
  if (!inFlight) {
    inFlight = captureSources()
      .then((result) => {
        cache = result;
        return result;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/**
 * Starts a background refresh loop. Call as early as possible — at app
 * launch, not gated on pairing or the room connecting — since capturing a
 * source needs no auth, and every extra second before the user could
 * plausibly click "Share" is a second the first (expensive) capture gets to
 * finish in. Stop it when the window closes, since it is pure overhead
 * otherwise.
 */
/**
 * Keeps the cached list fresh in the background.
 *
 * The interval is a floor imposed by the work itself: a full capture with
 * thumbnails was measured at ~3.3s, almost all of it Chromium grabbing the
 * images. Asking more often would simply queue captures behind each other.
 */
export function startWarming(intervalMs = 4000): void {
  if (refreshTimer) return;
  void refresh();
  refreshTimer = setInterval(() => void refresh(), intervalMs);
}

export function stopWarming(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

/**
 * Returns the source list. If a warm cache exists, returns it immediately and
 * triggers a background refresh for next time; the caller never waits on
 * that refresh. Only the very first call in a session — before warming has
 * had a chance to complete — pays the full capture cost.
 */
export async function listSources(fresh = false): Promise<SourceInfo[]> {
  if (fresh) {
    cache = null;
    return refresh();
  }
  if (cache) {
    // Only refresh in the background if warming is active. When warming is stopped
    // (e.g. during a live broadcast), avoid invoking desktopCapturer which burns CPU/GPU
    // capturing thumbnails and spams WGC 'Source is not capturable' logs.
    if (refreshTimer) {
      void refresh();
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
