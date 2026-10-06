/**
 * The target bitrate for a hardware encoder that WebRTC cannot steer itself.
 *
 * On the native path Chromium encodes a placeholder and the frames that go out
 * are NVENC's or AMF's (see native-video.ts), so its congestion control can
 * estimate the uplink but has no encoder of its own to slow down. Left alone,
 * the hardware encoder sends the preset's bitrate whatever the link carries:
 * on an uplink that cannot hold it, packets queue, then drop, and viewers see
 * the picture stall until a keyframe. This reads Chromium's estimate
 * (`availableOutgoingBitrate`) and moves the encoder to fit, in place, with no
 * keyframe and no restart.
 *
 * Down at once, up slowly — the shape of every WebRTC rate controller. Losing
 * frames to a link that has shrunk is worse than a softer picture for a few
 * seconds, and an estimate that rises is only trusted once it has held.
 */

export interface AdaptiveBitrateLimits {
  /** The preset's bitrate: never more than this. */
  max: number;
  /** Never less than this, however bad the estimate. */
  floor: number;
}

/** Ignored for this long after start: Chromium's estimate starts low and climbs. */
export const WARMUP_MS = 10_000;
/** Sent as a share of the estimate, leaving room for audio, retransmissions and headers. */
export const HEADROOM = 0.9;
/** The most the target rises in one step (one step a second). */
export const RAISE_STEP = 1.15;
/** Changes smaller than this, as a share of the current target, are not worth a reconfigure. */
export const MIN_CHANGE = 0.05;

/** The floor for a preset: a sixth or so of its bitrate, and never below 1Mbps. */
export function limitsFor(maxBitrate: number): AdaptiveBitrateLimits {
  return { max: maxBitrate, floor: Math.min(maxBitrate, Math.max(1_000_000, maxBitrate * 0.15)) };
}

/** How far the estimate must fall between two readings to count as falling. */
export const FALL = 0.95;

/**
 * The next target, from the current one and Chromium's estimate now and a
 * second ago. Returns `current` when nothing should change.
 *
 * Lowered only when the estimate is below what is being sent now *and* has
 * just fallen. Below what is being sent, because on a healthy link the
 * estimate sits well above the preset (142Mbps measured on a 20Mbps one),
 * and shaving headroom off it would walk a good stream down for nothing.
 * Fallen, because an estimate below the preset is also what a connection
 * that has only just started looks like: Chromium's begins low and climbs,
 * and ten seconds in it read 7.4Mbps on a link that went on to measure 140 —
 * a broadcast started at a third of its preset for nothing, twice in one
 * test. A link that really cannot carry the preset says so by the estimate
 * falling once the stream overruns it, which this then follows at once.
 */
export function nextBitrate(
  current: number,
  available: number | undefined,
  previous: number | undefined,
  elapsedMs: number,
  limits: AdaptiveBitrateLimits,
  /** How high a rise may go now, after congestion (see nextCeiling). */
  ceiling: number = limits.max,
  /** The estimate has sat below what is sent without climbing (see createBitrateController). */
  stalled = false,
): number {
  if (elapsedMs < WARMUP_MS) return current;
  if (available === undefined || !Number.isFinite(available) || available <= 0) return current;

  const falling = stalled || (previous !== undefined && available < previous * FALL);
  let target = current;
  if (available < current) {
    if (!falling) return current;
    target = available * HEADROOM;
  } else if (available >= limits.max) {
    // An estimate at the ceiling is Chromium saying "as much as you are
    // allowed", not a measurement to keep headroom under — holding back from
    // it would leave a stream that dipped once short of its preset for good.
    target = Math.min(current * RAISE_STEP, limits.max);
  } else if (available * HEADROOM > current) {
    target = Math.min(current * RAISE_STEP, available * HEADROOM);
  }
  // A rise stops at the ceiling, but nothing is lowered to meet it: only a
  // falling estimate lowers the rate.
  if (target > current) target = Math.max(current, Math.min(target, ceiling));
  target = Math.round(Math.min(limits.max, Math.max(limits.floor, target)));

  if (Math.abs(target - current) < current * MIN_CHANGE) {
    // Except reaching a limit exactly, which a 5% rule would never let it do.
    // Not the congestion ceiling: it lifts a little every second, and
    // following it exactly would reconfigure the encoder every second.
    return target === limits.max || target === limits.floor ? target : current;
  }
  return target;
}

/** After congestion, rises stop this far below the rate that caused it. */
export const CEILING_BACKOFF = 0.85;
/** How fast that ceiling lifts again, per step (one step a second). */
export const CEILING_RELAX = 1.002;

/**
 * How high the rate may climb, given what just happened.
 *
 * Without this, a link that carries 15Mbps had a 20Mbps stream in a sawtooth:
 * Chromium's estimate, reading over 200Mbps while the link had room, let the
 * rate climb back to the preset in ten seconds; the uplink saturated; the
 * estimate collapsed to 1-5Mbps; the rate went to its floor and climbed
 * again. Thirteen times in eight and a half minutes on one broadcast — every
 * collapse a burst of loss for viewers, and most of the time spent far below
 * what the link could carry. An estimate from a link with room to spare is
 * optimistic, so it cannot be what tells the climb where to stop.
 *
 * So a drop remembers the rate it came from, and rises stop 15% short of it.
 * The ceiling lifts by 0.2% a second — back to where it was in about eighty —
 * so a congested moment that has passed costs a minute or so of a slightly
 * lower ceiling, and a link that really is that size is probed rarely
 * instead of every forty seconds.
 */
export function nextCeiling(
  ceiling: number,
  current: number,
  next: number,
  limits: AdaptiveBitrateLimits,
): number {
  if (next < current) return Math.max(limits.floor, Math.min(ceiling, current * CEILING_BACKOFF));
  return Math.min(limits.max, ceiling * CEILING_RELAX);
}

/** An estimate within this of the last one is not climbing. */
export const FLAT = 1.02;
/** Readings below what is sent, not climbing, before that counts as a fall. */
export const STALLED_STEPS = 3;

export interface BitrateController {
  /** One reading of Chromium's estimate, once a second; returns the new target. */
  step(available: number | undefined, elapsedMs: number): number;
  readonly current: number;
  readonly ceiling: number;
}

/**
 * The rules above, with the state they need between readings.
 *
 * One more is kept here: an estimate below what is being sent that has stopped
 * climbing for three readings counts as a fall. "Only on a falling estimate"
 * is what stops a broadcast that has just started from dropping while
 * Chromium's estimate climbs (by 6-11% a second, logged); but a broadcast
 * that starts above what its link carries can see the estimate settle low
 * and stay there, never falling — and was left overrunning the link for good,
 * as replaying a 15Mbps link under a 20Mbps preset showed.
 */
export function createBitrateController(
  limits: AdaptiveBitrateLimits,
  start: number = limits.max,
): BitrateController {
  let current = start;
  let previous: number | undefined;
  let ceiling = limits.max;
  let flatBelow = 0;
  return {
    step(available, elapsedMs) {
      const flat =
        available !== undefined &&
        previous !== undefined &&
        available < current &&
        available <= previous * FLAT;
      flatBelow = flat ? flatBelow + 1 : 0;
      const next = nextBitrate(
        current,
        available,
        previous,
        elapsedMs,
        limits,
        ceiling,
        flatBelow >= STALLED_STEPS,
      );
      ceiling = nextCeiling(ceiling, current, next, limits);
      if (next < current) flatBelow = 0;
      previous = available;
      current = next;
      return next;
    },
    get current() {
      return current;
    },
    get ceiling() {
      return ceiling;
    },
  };
}
