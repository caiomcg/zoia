/**
 * The arithmetic of the photo viewer, kept free of React so it can be tested:
 * fitting a picture to the screen, zooming about a point, and keeping a
 * zoomed picture from being dragged out of sight.
 *
 * The picture is laid out at its fitted size, centred, and moved with
 * translate(x, y) scale(s) about its centre. A view is { scale, x, y }.
 */

export interface Size {
  width: number;
  height: number;
}

export interface View {
  scale: number;
  x: number;
  y: number;
}

export const FIT: View = { scale: 1, x: 0, y: 0 };

/** The most a picture is magnified, past its fitted size. */
export const MAX_SCALE = 8;

/**
 * How large a picture is shown before zooming: as large as fits, but never
 * past its own size, so a small one is not blown up into a blur.
 */
export function fitted(natural: Size, stage: Size): Size {
  if (natural.width <= 0 || natural.height <= 0) return { width: 0, height: 0 };
  const ratio = Math.min(stage.width / natural.width, stage.height / natural.height, 1);
  return { width: natural.width * ratio, height: natural.height * ratio };
}

/**
 * How far a click zooms in: to the picture's own pixels when it was shrunk to
 * fit, and at least twice, so a small picture still gets closer.
 */
export function clickScale(natural: Size, shown: Size): number {
  if (shown.width <= 0) return 2;
  return Math.min(MAX_SCALE, Math.max(2, natural.width / shown.width));
}

/** The view moved back within reach: never further than the picture's own edges. */
export function clamp(view: View, shown: Size, stage: Size): View {
  const room = (picture: number, frame: number) => Math.max(0, (picture * view.scale - frame) / 2);
  const rx = room(shown.width, stage.width);
  const ry = room(shown.height, stage.height);
  return {
    scale: view.scale,
    x: Math.min(rx, Math.max(-rx, view.x)),
    y: Math.min(ry, Math.max(-ry, view.y)),
  };
}

/**
 * The view at `scale`, with the point under `at` (relative to the stage's
 * centre) staying where it is, then clamped.
 */
export function zoomAt(
  view: View,
  scale: number,
  at: { x: number; y: number },
  shown: Size,
  stage: Size,
): View {
  const next = Math.min(MAX_SCALE, Math.max(1, scale));
  const k = next / view.scale;
  return clamp(
    { scale: next, x: at.x - (at.x - view.x) * k, y: at.y - (at.y - view.y) * k },
    shown,
    stage,
  );
}
