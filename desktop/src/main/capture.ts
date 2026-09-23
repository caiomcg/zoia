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

/** Which encoder the captured frames will actually be handed to. */
export type HardwareEncoder = 'nvenc' | 'amf' | 'qsv' | 'none';

/** What the addon sends back: H.264 it encoded, or raw frames for ffmpeg. */
export type CaptureOutput = 'h264' | 'bgra';

interface CaptureAddon {
  isSupported(): {
    windowCapture: boolean;
    hardwareEncoder: boolean;
    vendor: string;
    adapter: string;
    encoder: HardwareEncoder;
  };
  start(
    options: { hwnd: string; framerate: number; bitrate: number },
    callback: (error: string | null, packet?: Buffer, keyframe?: boolean) => void,
  ): { width: number; height: number; output: CaptureOutput; vendor: string; adapter: string };
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
  /** nvidia / amd / intel, from the adapter this machine would encode on. */
  vendor: string;
  /** The adapter's own name, worth showing because people recognise it. */
  adapter: string;
  encoder: HardwareEncoder;
  /** Why hardware encoding is unavailable, in words a person can act on. */
  reason: string | null;
}

/**
 * What this machine can actually do, decided once at startup.
 *
 * This used to answer "is hardware encoding available" with "does the NVIDIA
 * driver's DLL exist", which said yes on every switchable-graphics laptop
 * while the broadcast then failed — the D3D device lands on the integrated
 * GPU and NVENC will not open a session on one. It now reports the adapter
 * that would actually be used, and which encoder that implies.
 */
export function capabilities(): Capabilities {
  const native = load();
  if (!native) {
    return {
      windowCapture: false,
      hardwareEncoder: false,
      vendor: 'unknown',
      adapter: '',
      encoder: 'none',
      reason: loadError ?? 'The capture module could not be loaded.',
    };
  }

  try {
    const caps = native.isSupported();
    return {
      windowCapture: caps.windowCapture,
      hardwareEncoder: caps.hardwareEncoder,
      vendor: caps.vendor,
      adapter: caps.adapter,
      encoder: caps.encoder,
      reason: !caps.hardwareEncoder
        ? 'No hardware graphics adapter was found; this machine will encode on the CPU.'
        : !caps.windowCapture
          ? 'Windows Graphics Capture is unavailable on this version of Windows.'
          : null,
    };
  } catch (err) {
    return {
      windowCapture: false,
      hardwareEncoder: false,
      vendor: 'unknown',
      adapter: '',
      encoder: 'none',
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
): { width: number; height: number; output: CaptureOutput; vendor: string; adapter: string } {
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
