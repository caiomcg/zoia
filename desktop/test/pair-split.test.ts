/**
 * The mosaic divider used to stop at 20% of the row. On a normal window that
 * is already narrower than the tile footer, so volume, fullscreen and close
 * wrapped onto a second line.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PAIR_SPLITTER_PX, PAIR_TILE_MIN_PX, clampPairSplit } from '../src/renderer/pair-split.ts';

describe('clampPairSplit', () => {
  test('keeps each tile wide enough for the footer controls', () => {
    const width = 1200;
    const available = width - PAIR_SPLITTER_PX;
    const min = PAIR_TILE_MIN_PX / available;
    assert.equal(clampPairSplit(0.1, width), min);
    assert.equal(clampPairSplit(0.95, width), 1 - min);
    assert.equal(clampPairSplit(0.5, width), 0.5);
  });

  test('still allows a narrow fraction when the stage is wide', () => {
    const width = 2400;
    const clamped = clampPairSplit(0.1, width);
    assert.ok(clamped < 0.2);
    assert.equal(clamped * (width - PAIR_SPLITTER_PX), PAIR_TILE_MIN_PX);
  });

  test('splits evenly when both minimums do not fit', () => {
    assert.equal(clampPairSplit(0.2, PAIR_TILE_MIN_PX * 2), 0.5);
    assert.equal(clampPairSplit(0.9, 500), 0.5);
  });

  test('leaves a stored ratio alone until the row is measured', () => {
    assert.equal(clampPairSplit(0.2, 0), 0.2);
  });

  test('replaces a non-number with the even split once measured', () => {
    assert.equal(clampPairSplit(Number.NaN, 1200), 0.5);
  });
});
