/** Which edge the broadcast strip rests on. Bottom is where it started. */
export const STRIP_EDGES = ['top', 'right', 'bottom', 'left'] as const;
export type StripEdge = (typeof STRIP_EDGES)[number];

/** A drag smaller than this is still a click: watch, hide, mute. */
export const DOCK_DRAG_THRESHOLD_PX = 8;

export interface DockBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The strip always rests on an edge. A point in the stage belongs to whichever
 * edge it is nearest, with the stage treated as a square so a wide picture
 * does not make the sides steal a short drag up or down. A tie between two
 * edges goes to the top or the bottom, and the centre stays on the bottom.
 */
export function stripEdgeAt(x: number, y: number, width: number, height: number): StripEdge {
  if (!(width > 0) || !(height > 0)) return 'bottom';
  const nx = (x - width / 2) / (width / 2);
  const ny = (y - height / 2) / (height / 2);
  if (Math.abs(nx) > Math.abs(ny)) return nx > 0 ? 'right' : 'left';
  return ny >= 0 ? 'bottom' : 'top';
}

/**
 * Where the strip sits while it is being dragged: centred on the pointer, and
 * kept inside the stage so it cannot be dropped where it cannot be seen.
 * Releasing it docks it; this position is only for the gesture.
 */
export function dockDragPosition(
  pointerX: number,
  pointerY: number,
  area: DockBox,
  size: { width: number; height: number },
  margin = 8,
): { left: number; top: number } {
  const maxLeft = Math.max(margin, area.width - size.width - margin);
  const maxTop = Math.max(margin, area.height - size.height - margin);
  return {
    left: Math.round(Math.min(maxLeft, Math.max(margin, pointerX - area.left - size.width / 2))),
    top: Math.round(Math.min(maxTop, Math.max(margin, pointerY - area.top - size.height / 2))),
  };
}
