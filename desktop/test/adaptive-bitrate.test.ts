import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  HEADROOM,
  RAISE_STEP,
  WARMUP_MS,
  limitsFor,
  nextBitrate,
} from '../src/renderer/livekit/adaptive-bitrate.ts';

const M = 1_000_000;
const limits = limitsFor(12 * M);
const later = WARMUP_MS + 1;

describe('nextBitrate', () => {
  test('changes nothing while the estimate is still warming up', () => {
    assert.equal(nextBitrate(12 * M, 2 * M, WARMUP_MS - 1, limits), 12 * M);
  });

  test('changes nothing without an estimate', () => {
    assert.equal(nextBitrate(12 * M, undefined, later, limits), 12 * M);
    assert.equal(nextBitrate(12 * M, 0, later, limits), 12 * M);
    assert.equal(nextBitrate(12 * M, Number.NaN, later, limits), 12 * M);
  });

  test('holds the preset on a healthy link, where the estimate sits at the maximum', () => {
    // Chromium caps its estimate near the configured maximum plus audio.
    assert.equal(nextBitrate(12 * M, 12.1 * M, later, limits), 12 * M);
    assert.equal(nextBitrate(12 * M, 30 * M, later, limits), 12 * M);
  });

  test('drops at once to fit a link that has shrunk', () => {
    assert.equal(nextBitrate(12 * M, 5 * M, later, limits), Math.round(5 * M * HEADROOM));
  });

  test('never drops below the floor', () => {
    assert.equal(limits.floor, 1.8 * M);
    assert.equal(nextBitrate(12 * M, 0.5 * M, later, limits), limits.floor);
  });

  test('rises one step at a time when the estimate allows more', () => {
    assert.equal(nextBitrate(4 * M, 20 * M, later, limits), Math.round(4 * M * RAISE_STEP));
  });

  test('rises no further than the estimate leaves room for', () => {
    assert.equal(nextBitrate(4 * M, 5 * M, later, limits), Math.round(5 * M * HEADROOM));
  });

  test('climbs back to the preset on an estimate at the ceiling, and reaches it exactly', () => {
    let rate = 3 * M;
    let steps = 0;
    while (rate < 12 * M && steps < 50) {
      // What a healthy link reads: the maximum plus the audio track.
      rate = nextBitrate(rate, 12.13 * M, later, limits);
      steps++;
    }
    assert.equal(rate, 12 * M);
    assert.ok(steps <= 12, `took ${steps} steps`);
  });

  test('ignores changes too small to be worth a reconfigure', () => {
    // 6.2 * 0.9 = 5.58: room for less than is being sent, so no rise...
    assert.equal(nextBitrate(6 * M, 6.2 * M, later, limits), 6 * M);
    // ...and 6.4 * 0.9 = 5.76 would be a 3% step up, which is not taken.
    assert.equal(nextBitrate(5.6 * M, 6.4 * M, later, limits), 5.6 * M);
  });

  test('settles rather than oscillating once it has dropped', () => {
    const dropped = nextBitrate(6 * M, 5.9 * M, later, limits);
    assert.equal(dropped, Math.round(5.9 * M * HEADROOM));
    // The same estimate next second leaves it where it is.
    assert.equal(nextBitrate(dropped, 5.9 * M, later, limits), dropped);
  });
});

describe('limitsFor', () => {
  test('a small preset is floored at 1Mbps, never above its own maximum', () => {
    assert.deepEqual(limitsFor(3 * M), { max: 3 * M, floor: 1 * M });
    assert.deepEqual(limitsFor(0.8 * M), { max: 0.8 * M, floor: 0.8 * M });
  });
});
