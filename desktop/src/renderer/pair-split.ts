/** Width of the draggable divider. Matches `.splitter` in styles.css. */
export const PAIR_SPLITTER_PX = 10;

/**
 * Narrowest a side-by-side tile may be. The footer keeps the volume slider,
 * fullscreen and close on one line; any narrower and those controls wrap.
 * Matches the `min()` on `.mains.paired > .tile-slot` in styles.css.
 */
export const PAIR_TILE_MIN_PX = 400;

/**
 * How far the divider may travel, as a fraction of the row. Each tile is
 * `ratio * (width - splitter)` wide, so the floor is a width, not a fraction:
 * on a wide stage the divider can pass the old 20% mark and still leave both
 * footers intact, and on a narrow one it stops sooner.
 */
export function pairSplitLimits(containerWidth: number): { min: number; max: number } {
  const available = containerWidth - PAIR_SPLITTER_PX;
  if (!(available > PAIR_TILE_MIN_PX * 2)) {
    // Too narrow for both floors. An even split is the only one that does not
    // favour one side, and the CSS minimum gives way so the row does not overflow.
    if (!(available > 0)) return { min: 0, max: 1 };
    return { min: 0.5, max: 0.5 };
  }
  const min = PAIR_TILE_MIN_PX / available;
  return { min, max: 1 - min };
}

/** Pulls a divider position back inside {@link pairSplitLimits}. */
export function clampPairSplit(ratio: number, containerWidth: number): number {
  if (!(containerWidth > PAIR_SPLITTER_PX)) return Number.isFinite(ratio) ? ratio : 0.5;
  const { min, max } = pairSplitLimits(containerWidth);
  const value = Number.isFinite(ratio) ? ratio : 0.5;
  return Math.min(max, Math.max(min, value));
}
