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

/**
 * The next target, from the current one and Chromium's estimate. Returns
 * `current` when nothing should change.
 *
 * Lowered only when the estimate is below what is being sent now: on a
 * healthy link Chromium's estimate sits at the configured maximum, and
 * shaving headroom off that every second would walk a good stream down for
 * nothing.
 */
export function nextBitrate(
  current: number,
  available: number | undefined,
  elapsedMs: number,
  limits: AdaptiveBitrateLimits,
): number {
  if (elapsedMs < WARMUP_MS) return current;
  if (available === undefined || !Number.isFinite(available) || available <= 0) return current;

  let target = current;
  if (available < current) {
    target = available * HEADROOM;
  } else if (available >= limits.max) {
    // An estimate at the ceiling is Chromium saying "as much as you are
    // allowed", not a measurement to keep headroom under — holding back from
    // it would leave a stream that dipped once short of its preset for good.
    target = Math.min(current * RAISE_STEP, limits.max);
  } else if (available * HEADROOM > current) {
    target = Math.min(current * RAISE_STEP, available * HEADROOM);
  }
  target = Math.round(Math.min(limits.max, Math.max(limits.floor, target)));

  if (Math.abs(target - current) < current * MIN_CHANGE) {
    // Except reaching a limit exactly, which a 5% rule would never let it do.
    return target === limits.max || target === limits.floor ? target : current;
  }
  return target;
}
