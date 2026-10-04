/**
 * The arithmetic behind audio/video sync on the raw-frame broadcast path —
 * the one AMD and Intel take, where ffmpeg encodes frames the addon read back
 * off the GPU.
 *
 * Neither input on that path carries a real timestamp. Raw video goes in as
 * `-f rawvideo -framerate N`, so frame N is stamped at N/N_fps; raw PCM goes
 * in as `-f s16le`, so sample S is stamped at S/48000. Both are counts, and
 * ffmpeg aligns PTS 0 with PTS 0. **The A/V offset of the published stream is
 * therefore exactly the gap between the wall-clock instants the two counts
 * started at** — nothing downstream can correct it, because as far as ffmpeg,
 * the SFU and the viewer are concerned the two streams already agree.
 *
 * That gap used to be real. Video anchored on the first captured frame, which
 * lands within a frame of the pacer starting. Audio anchored on the first byte
 * *written*, and the first byte written was a keepalive silence block, which
 * cannot happen sooner than one keepalive tick and in practice landed later
 * still, because WASAPI capture only starts once ffmpeg has confirmed startup.
 * So audio's zero sat 50-100ms after video's, and the sound ran that far ahead
 * of the picture for the whole broadcast.
 *
 * These functions exist as their own module so that "both timelines measure
 * from one origin" is a property of their signatures rather than of two
 * variables that drifted apart once already — 0.4.9 fixed the *rate* the two
 * clocks ran at and left them anchored separately. `media-clock.test.ts`
 * guards it.
 */

/** 48kHz, two channels, 16-bit — what WASAPI loopback produces. */
export const SAMPLE_RATE = 48000;
export const CHANNELS = 2;
export const BYTES_PER_MS = (SAMPLE_RATE * CHANNELS * 2) / 1000;

/**
 * How far the audio timeline has run ahead of real time, in milliseconds,
 * measured from the shared origin. Negative means the audio has fallen behind
 * and there is a gap for the keepalive to fill.
 *
 * Zero while unanchored: with no origin there is no timeline to be ahead of.
 */
export function audioAheadMs(originMs: number, bytesWritten: number, now: number): number {
  if (originMs === 0) return 0;
  return bytesWritten / BYTES_PER_MS - (now - originMs);
}

/**
 * How many video frames should have been written by `now`, counting the first,
 * measured from the same shared origin.
 *
 * Zero while unanchored, so the pacer writes nothing before there is a
 * timeline to pace against.
 */
export function framesDue(originMs: number, frameIntervalMs: number, now: number): number {
  if (originMs === 0) return 0;
  return Math.floor((now - originMs) / frameIntervalMs) + 1;
}

/**
 * The published A/V offset that a pair of origins produces, in milliseconds,
 * positive when the sound runs ahead of the picture.
 *
 * Not used by the encoder — it has one origin and so no offset by
 * construction. It states the relationship the tests assert, and names the
 * bug this module exists to make unrepresentable.
 */
export function offsetMs(videoOriginMs: number, audioOriginMs: number): number {
  return audioOriginMs - videoOriginMs;
}
