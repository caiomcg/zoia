/**
 * Capture sources: what desktopCapturer offers, resolved against
 * node-window-manager for the one thing desktopCapturer never gives you — the
 * owning process id.
 *
 * Verified empirically against a live Windows 11 / Electron 44 session: the
 * numeric part of a desktopCapturer window id ("window:2165034:0") is exactly
 * node-window-manager's Window.id (the HWND). No fuzzy title matching, no
 * ambiguity between two windows sharing a title — a direct id lookup.
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

export async function listSources(): Promise<SourceInfo[]> {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: false,
  });

  // One native call, reused for every window source below rather than one
  // enumeration per source.
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
    };
  });
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

export function getSelectedSource() {
  return selected;
}

export function clearSelectedSource(): void {
  selected = null;
}
