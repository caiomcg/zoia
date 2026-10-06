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

/** Feeds a series of estimates, one a second, as native-video.ts does. */
function replay(start: number, estimates: number[], max = limits) {
  let current = start;
  let previous: number | undefined;
  const targets: number[] = [];
  for (const estimate of estimates) {
    current = nextBitrate(current, estimate, previous, later, max);
    previous = estimate;
    targets.push(current);
  }
  return targets;
}

describe('nextBitrate', () => {
  test('changes nothing while the estimate is still warming up', () => {
    assert.equal(nextBitrate(12 * M, 2 * M, 20 * M, WARMUP_MS - 1, limits), 12 * M);
  });

  test('changes nothing without an estimate', () => {
    assert.equal(nextBitrate(12 * M, undefined, 12 * M, later, limits), 12 * M);
    assert.equal(nextBitrate(12 * M, 0, 12 * M, later, limits), 12 * M);
    assert.equal(nextBitrate(12 * M, Number.NaN, 12 * M, later, limits), 12 * M);
  });

  test('holds the preset on a healthy link, where the estimate sits above it', () => {
    assert.equal(nextBitrate(12 * M, 12.1 * M, 12.1 * M, later, limits), 12 * M);
    assert.equal(nextBitrate(12 * M, 142.8 * M, 126.6 * M, later, limits), 12 * M);
  });

  test('drops at once to fit a link that has shrunk', () => {
    assert.equal(nextBitrate(12 * M, 5 * M, 11 * M, later, limits), Math.round(5 * M * HEADROOM));
  });

  test('does not drop on a low estimate that is still climbing', () => {
    // Below the preset, but rising: a connection that has only just started.
    assert.equal(nextBitrate(12 * M, 7.4 * M, 6 * M, later, limits), 12 * M);
    // Nor on the first reading, with nothing to compare it to.
    assert.equal(nextBitrate(12 * M, 7.4 * M, undefined, later, limits), 12 * M);
    // Nor on a reading that merely wobbles.
    assert.equal(nextBitrate(12 * M, 7.3 * M, 7.4 * M, later, limits), 12 * M);
  });

  test('never drops below the floor', () => {
    assert.equal(limits.floor, 1.8 * M);
    assert.equal(nextBitrate(12 * M, 0.5 * M, 6 * M, later, limits), limits.floor);
  });

  test('rises one step at a time when the estimate allows more', () => {
    assert.equal(nextBitrate(4 * M, 20 * M, 20 * M, later, limits), Math.round(4 * M * RAISE_STEP));
  });

  test('rises no further than the estimate leaves room for', () => {
    assert.equal(nextBitrate(4 * M, 5 * M, 5 * M, later, limits), Math.round(5 * M * HEADROOM));
  });

  test('climbs back to the preset on an estimate at the ceiling, and reaches it exactly', () => {
    const targets = replay(3 * M, Array(50).fill(12.13 * M));
    const reached = targets.indexOf(12 * M);
    assert.ok(reached >= 0 && reached < 12, `reached at step ${reached}`);
  });

  test('ignores changes too small to be worth a reconfigure', () => {
    // 6.2 * 0.9 = 5.58: room for less than is being sent, so no rise...
    assert.equal(nextBitrate(6 * M, 6.2 * M, 6.2 * M, later, limits), 6 * M);
    // ...and 6.4 * 0.9 = 5.76 would be a 3% step up, which is not taken.
    assert.equal(nextBitrate(5.6 * M, 6.4 * M, 6.4 * M, later, limits), 5.6 * M);
  });

  test('settles rather than oscillating once it has dropped', () => {
    const dropped = nextBitrate(6 * M, 5.9 * M, 6.5 * M, later, limits);
    assert.equal(dropped, Math.round(5.9 * M * HEADROOM));
    // The same estimate next second leaves it where it is.
    assert.equal(nextBitrate(dropped, 5.9 * M, 5.9 * M, later, limits), dropped);
  });
});

/**
 * The estimates logged by a 58-minute 1440p60 broadcast on a 20Mbps preset,
 * RX 9070 XT, replayed.
 */
describe('replaying a real broadcast', () => {
  const preset = limitsFor(20 * M);

  test('a start whose estimate is still climbing keeps the preset', () => {
    // Two broadcasts dropped to 6.6 and 8.9Mbps here, on a link that later
    // measured 140, before a drop had to follow a falling estimate.
    const targets = replay(
      20 * M,
      [7.4, 7.9, 8.6, 9.6, 10.7, 17.4, 30.7].map((e) => e * M),
      preset,
    );
    assert.ok(
      targets.every((t) => t === 20 * M),
      targets.join(', '),
    );
  });

  test('a real dip forty-nine minutes in is followed down and back up', () => {
    const estimates = [142.8, 10.9, 5.0, 5.7, 6.1, 7.7, 10.2, 17.4, 30.7, 42.7, 72.1, 126.6, 142.8];
    const targets = replay(
      20 * M,
      estimates.map((e) => e * M),
      preset,
    );
    assert.equal(targets[0], 20 * M);
    assert.equal(targets[1], Math.round(10.9 * M * HEADROOM));
    assert.equal(targets[2], Math.round(5.0 * M * HEADROOM));
    assert.ok(
      targets.slice(3).every((t, i) => t >= targets[i + 2]),
      'climbs without dropping again',
    );
    // And reaches the preset again, the ceiling estimate letting it all the way.
    assert.equal(replay(targets.at(-1)!, Array(10).fill(142.8 * M), preset).at(-1), 20 * M);
  });
});

describe('limitsFor', () => {
  test('a small preset is floored at 1Mbps, never above its own maximum', () => {
    assert.deepEqual(limitsFor(3 * M), { max: 3 * M, floor: 1 * M });
    assert.deepEqual(limitsFor(0.8 * M), { max: 0.8 * M, floor: 0.8 * M });
  });
});
