import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BYTES_PER_MS, audioAheadMs, framesDue, offsetMs } from '../src/main/media-clock.ts';

/**
 * These guard the one property that keeps picture and sound together on the
 * raw-frame path: both synthetic timelines measure from the same origin.
 *
 * ffmpeg stamps raw video by frame count and raw PCM by sample count, then
 * aligns PTS 0 with PTS 0 — so the offset a viewer hears is exactly the gap
 * between the two origins, and nothing downstream can correct it. 0.4.9 fixed
 * the rate the two clocks ran at and left them anchored separately, which is
 * why the sound still ran ahead.
 */
describe('media clock', () => {
  const interval = 1000 / 60;

  test('a shared origin publishes both timelines in step', () => {
    const origin = 1_000;
    // One second of real time, fed exactly real time's worth of audio.
    const now = origin + 1000;
    const bytes = 1000 * BYTES_PER_MS;

    assert.equal(audioAheadMs(origin, bytes, now), 0);
    // 60fps for a second, counting the first frame. Within a frame rather
    // than exact: 1000 / (1000 / 60) is 59.999... in binary floating point,
    // and the pacer's own deadband is two frames wide, so the last one
    // either way is not a quantity worth pinning.
    const due = framesDue(origin, interval, now);
    assert.ok(due === 60 || due === 61, `expected 60 or 61 frames due, got ${due}`);
    assert.equal(offsetMs(origin, origin), 0);
  });

  test('separate origins are exactly the offset that was heard', () => {
    // The old anchoring: video on the first captured frame, audio on the
    // first keepalive silence block one tick later.
    const videoOrigin = 1_000;
    const audioOrigin = 1_050;
    assert.equal(offsetMs(videoOrigin, audioOrigin), 50);

    // Both clocks run at the right rate — each reports itself in step with
    // real time — and the stream is still 50ms out. Rate was never the bug.
    const now = videoOrigin + 5_000;
    assert.equal(audioAheadMs(audioOrigin, (now - audioOrigin) * BYTES_PER_MS, now), 0);
    assert.ok(framesDue(videoOrigin, interval, now) >= 300);
  });

  test('audio behind real time reads negative, which is the gap to fill', () => {
    const origin = 1_000;
    const now = origin + 1000;
    // 100ms short of real time.
    const bytes = 900 * BYTES_PER_MS;
    assert.equal(audioAheadMs(origin, bytes, now), -100);
  });

  test('audio ahead of real time reads positive, which is when chunks are dropped', () => {
    const origin = 1_000;
    const now = origin + 1000;
    const bytes = 1120 * BYTES_PER_MS;
    assert.equal(audioAheadMs(origin, bytes, now), 120);
  });

  test('the gap before the first real chunk is what the keepalive pre-fills', () => {
    // Anchored by a video frame; WASAPI has not delivered anything yet.
    const origin = 1_000;
    const now = origin + 80;
    // 80ms behind, so 80ms of silence goes in and the audio timeline starts
    // where the video's does rather than 80ms into it.
    assert.equal(audioAheadMs(origin, 0, now), -80);
    const filled = 80 * BYTES_PER_MS;
    assert.equal(audioAheadMs(origin, filled, now), 0);
  });

  test('unanchored, neither timeline has started', () => {
    const now = 5_000;
    assert.equal(audioAheadMs(0, 0, now), 0);
    // Zero, not one: the pacer must not write a frame before there is a
    // timeline to pace against.
    assert.equal(framesDue(0, interval, now), 0);
  });

  test('frames due track real time at the preset rate', () => {
    // A non-zero origin throughout: 0 is the unanchored sentinel, and
    // performance.now() never returns it in a running process.
    const origin = 1_000;
    assert.equal(framesDue(origin, 20, origin), 1);
    assert.equal(framesDue(origin, 20, origin + 20), 2);
    // 50fps for a second: an interval that is exact in binary, so this one
    // can be pinned.
    assert.equal(framesDue(origin, 20, origin + 1000), 51);
    assert.equal(framesDue(origin, 10, origin + 1000), 101);
  });
});
