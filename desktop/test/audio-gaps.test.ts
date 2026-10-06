import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { GAP_MS, PERIOD_MS, silenceToFillMs } from '../src/main/audio-gaps.ts';

describe('silenceToFillMs', () => {
  test('fills nothing before the first packet', () => {
    assert.equal(silenceToFillMs(0, 5000), 0);
  });

  test('fills nothing while packets arrive at their usual pace', () => {
    assert.equal(silenceToFillMs(1000, 1010), 0);
    assert.equal(silenceToFillMs(1000, 1000 + GAP_MS), 0);
  });

  test('fills a gap, leaving one period for the packet on its way', () => {
    assert.equal(silenceToFillMs(1000, 1200), 200 - PERIOD_MS);
  });

  test('once filled, the same gap is not filled twice', () => {
    const fill = silenceToFillMs(1000, 1200);
    assert.equal(silenceToFillMs(1000 + fill, 1200), 0);
  });

  test('a long silence is filled in step with real time, never ahead of it', () => {
    let covered = 1000;
    let filled = 0;
    for (let now = 1020; now <= 6000; now += 20) {
      const fill = silenceToFillMs(covered, now);
      covered += fill;
      filled += fill;
      assert.ok(covered <= now, `covered ${covered} ran ahead of ${now}`);
    }
    // Five seconds of nothing, all but the last stretch filled.
    assert.ok(filled > 5000 - GAP_MS - PERIOD_MS, `filled ${filled}`);
  });
});
