/**
 * Which native windows are worth offering in the share picker.
 *
 * `IsWindowVisible` is not enough on its own. Apps that live in the tray
 * (Discord, Slack, WhatsApp) keep their main window "visible" but minimized,
 * which Windows parks far off-screen — at -32000, scaled by DPI, so -17920 on
 * a 175% display. Others keep 0×0 or 1×1 helper windows. Neither has a
 * picture to share: a minimized window captures as black until restored.
 *
 * Kept free of imports so `node --test` can load it directly.
 */

export interface Bounds {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

/** Past this, a window is parked rather than placed on a real monitor. */
const PARKED = -10_000;
/** Smaller than this in either direction is a helper, not something to show. */
const MIN_SIZE = 50;

export function isShareableWindow(bounds: Bounds | null | undefined): boolean {
  if (!bounds) return false;
  const { x = 0, y = 0, width = 0, height = 0 } = bounds;
  if (x <= PARKED || y <= PARKED) return false;
  return width >= MIN_SIZE && height >= MIN_SIZE;
}
