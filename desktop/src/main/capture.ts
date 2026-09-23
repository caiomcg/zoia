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
  isSupported(): { windowCapture: boolean; hardwareEncoder: boolean };
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
    addon = require('../../native/index.cjs') as CaptureAddon;
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
    addon = null;
  }
  return addon;
}

export interface Capabilities {
  windowCapture: boolean;
  hardwareEncoder: boolean;
  /** Why hardware encoding is unavailable, in words a person can act on. */
  reason: string | null;
}

/**
 * What this machine can actually do, decided once at startup.
 *
 * NVENC ships with the NVIDIA driver, so a machine without one can never use
 * the hardware path — which is what "nvEncodeAPI64.dll could not be loaded"
 * was really saying, far too late and far too cryptically.
 */
export function capabilities(): Capabilities {
  const native = load();
  if (!native) {
    return {
      windowCapture: false,
      hardwareEncoder: false,
      reason: loadError ?? 'The capture module could not be loaded.',
    };
  }

  try {
    const caps = native.isSupported();
    return {
      windowCapture: caps.windowCapture,
      hardwareEncoder: caps.hardwareEncoder,
      reason: caps.hardwareEncoder
        ? caps.windowCapture
          ? null
          : 'Windows Graphics Capture is unavailable on this version of Windows.'
        : 'No NVIDIA encoder was found. GPU encoding needs an NVIDIA GPU; ' +
          'this machine will encode on the CPU instead.',
    };
  } catch (err) {
    return {
      windowCapture: false,
      hardwareEncoder: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
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
