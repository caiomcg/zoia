/**
 * Native window capture: Windows Graphics Capture straight into NVENC.
 *
 * This is the path native apps take, and the only one measured working for
 * "a specific window, encoded on the GPU":
 *   - ffmpeg's ddagrab is Desktop Duplication and cannot capture a window;
 *   - ffmpeg's gdigrab names a window but returns blank frames for modern
 *     composited apps;
 *   - Chromium captures windows fine, but has no hardware encoder on Windows,
 *     and bridging its frames out cost a GPU readback plus three copies —
 *     measured at 14fps for a 4K window.
 *
 * The addon keeps the pixels on the GPU end to end and hands back only the
 * compressed H.264 bitstream. Measured on an RTX 4070 SUPER at 3840x2088:
 * 8.8ms per frame, an encoder ceiling around 114fps. What actually arrives is
 * whatever the window redraws at, because WGC is event-driven — a static
 * window produces few frames, a game produces sixty.
 */

import { createRequire } from 'node:module';

interface CaptureAddon {
  isSupported(): boolean;
  start(
    options: { hwnd: string; framerate: number; bitrate: number },
    callback: (error: string | null, packet?: Buffer, keyframe?: boolean) => void,
  ): { width: number; height: number };
  stop(): { framesArrived: number; averageEncodeMs: number };
}

const require = createRequire(import.meta.url);

let addon: CaptureAddon | null = null;
let loadError: string | null = null;

function load(): CaptureAddon | null {
  if (addon || loadError) return addon;
  try {
    addon = require('../../native/index.js') as CaptureAddon;
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
    addon = null;
  }
  return addon;
}

/** True when this machine can do GPU window capture at all. */
export function isSupported(): boolean {
  const native = load();
  if (!native) return false;
  try {
    return native.isSupported();
  } catch {
    return false;
  }
}

export function unavailableReason(): string | null {
  load();
  return loadError;
}

let running = false;

export function start(
  hwnd: number,
  framerate: number,
  bitrate: number,
  onPacket: (packet: Buffer) => void,
  onError: (message: string) => void,
): { width: number; height: number } {
  const native = load();
  if (!native) throw new Error(loadError ?? 'The native capture module is unavailable.');

  stop();
  const info = native.start(
    // As a string: an HWND is a 64-bit handle and a double cannot carry one
    // faithfully.
    { hwnd: String(hwnd), framerate, bitrate },
    (error, packet) => {
      if (error) {
        onError(error);
        return;
      }
      if (packet) onPacket(packet);
    },
  );
  running = true;
  return info;
}

export function stop(): { framesArrived: number; averageEncodeMs: number } | null {
  if (!running) return null;
  running = false;
  const native = load();
  try {
    return native?.stop() ?? null;
  } catch {
    return null;
  }
}
