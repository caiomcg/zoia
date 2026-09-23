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

export interface SourceInfo {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  thumbnailDataUrl: string;
  /** The window's owning PID, when resolvable — the whole point of this app. */
  processId: number | null;
}

function hwndFromSourceId(id: string): number | null {
  const match = /^window:(\d+):/.exec(id);
  return match?.[1] ? Number(match[1]) : null;
}

function toDataUrl(image: NativeImage): string {
  return image.isEmpty() ? '' : image.toDataURL();
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

  return sources.map((source) => {
    const isWindow = source.id.startsWith('window:');
    const hwnd = isWindow ? hwndFromSourceId(source.id) : null;
    const processId = hwnd !== null ? (windowsById.get(hwnd)?.processId ?? null) : null;

    return {
      id: source.id,
      name: source.name,
      kind: isWindow ? 'window' : 'screen',
      thumbnailDataUrl: toDataUrl(source.thumbnail),
      processId,
      hwnd,
    };
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
export async function listSources(): Promise<SourceInfo[]> {
  if (cache) {
    void refresh();
    return cache;
  }
  return refresh();
}

// The source most recently chosen in the renderer's picker UI. The display
// media handler (registered in index.ts) reads this to resolve whatever
// getDisplayMedia() call follows the choice — see docs/adr for why: once a
// session has a setDisplayMediaRequestHandler, Chromium's own picker never
// appears at all, so this *is* the picker.
/**
 * Where a window currently sits on the desktop, in physical pixels.
 *
 * The hardware-encoding path needs this because ddagrab captures a *region*
 * of the desktop rather than a window: to send one application, we point the
 * capture at wherever that application happens to be. Read live rather than
 * cached, since windows move.
 */
export function windowBounds(
  hwnd: number,
): { x: number; y: number; width: number; height: number } | null {
  const target = windowManager.getWindows().find((w) => w.id === hwnd);
  if (!target) return null;

  const { x, y, width, height } = target.getBounds();
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }

  // NVENC wants even dimensions; an odd width silently fails to initialise.
  return { x, y, width: width - (width % 2), height: height - (height % 2) };
}

let selected: { id: string; name: string; processId: number | null } | null = null;

export function selectSource(source: { id: string; name: string; processId: number | null }): void {
  selected = source;
}

export function getSelectedSource() {
  return selected;
}

export function clearSelectedSource(): void {
  selected = null;
}
