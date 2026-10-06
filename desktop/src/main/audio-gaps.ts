/**
 * Silence for the stretches WASAPI loopback never delivered.
 *
 * loopback-capture hands over nothing at all for a packet it judges silent
 * (every sample under -70dBFS), and nothing for audio the system lost under
 * load. Downstream the worklet holds a buffer between two clocks; every
 * missing stretch is a deficit it can only absorb at 1% a second, and a
 * deficit bigger than that empties the buffer and comes out later as a hole
 * in the middle of the sound, followed by a re-prime. Logged on an RX 9070 XT
 * broadcast: underruns at -26dBFS, playback pinned at its 0.99 limit.
 *
 * The ffmpeg route never had this problem because encoder.ts filled such gaps
 * with silence against the wall clock, and the native route was given no
 * equivalent. This is that, by gap rather than by running total: the wall
 * clock and the device's clock differ slightly, and a running total would
 * turn that difference into silence slipped into the sound now and then. A
 * gap is unambiguous — nothing arrived for longer than WASAPI ever goes
 * between packets — and the drift that remains is the worklet's to absorb.
 */

/** WASAPI delivers about every 10ms; this long without a packet is a gap. */
export const GAP_MS = 50;
/** What is left unfilled at the end of a gap, for the packet already on its way. */
export const PERIOD_MS = 10;

/**
 * Milliseconds of silence to insert at `now`, given that delivered audio
 * (real or filled) covers time up to `coveredUntil`. Zero while there is no
 * gap, and before the first packet, when there is no timeline yet.
 */
export function silenceToFillMs(coveredUntil: number, now: number): number {
  if (coveredUntil === 0) return 0;
  const missing = now - coveredUntil;
  return missing > GAP_MS ? Math.floor(missing - PERIOD_MS) : 0;
}
