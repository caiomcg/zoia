/**
 * Native window capture: Windows Graphics Capture straight into NVENC on
 * NVIDIA, or AMF on AMD (measured on an RX 9070 XT at 1080p: 3.7ms a frame).
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

/**
 * What the addon sends back: H.264 it encoded, or raw frames for ffmpeg —
 * NV12 when the GPU scaled and converted them, BGRA when it could not.
 */
export type CaptureOutput = 'h264' | 'nv12' | 'bgra';

interface CaptureAddon {
  isSupported(): {
    windowCapture: boolean;
    hardwareEncoder: boolean;
    vendor: string;
    adapter: string;
    encoder: HardwareEncoder;
  };
  start(
    options: {
      hwnd?: string;
      /** A point on the screen to capture, in physical pixels. */
      monitor?: { x: number; y: number };
      framerate: number;
      bitrate: number;
      maxWidth: number;
      maxHeight: number;
      showBorder: boolean;
    },
    callback: (error: string | null, packet?: Buffer, keyframe?: boolean) => void,
  ): {
    width: number;
    height: number;
    output: CaptureOutput;
    vendor: string;
    adapter: string;
    fallbackReason: string;
    /** "nvenc" or "amf" when the addon encodes; empty when frames go out raw. */
    encoder: string;
  };
  stop(): { framesArrived: number; averageEncodeMs: number };
  stats(): CaptureStats;
  requestKeyframe(): void;
  setBitrate(bitsPerSecond: number): void;
}

const require = createRequire(import.meta.url);

let addon: CaptureAddon | null = null;
let loadError: string | null = null;

function load(): CaptureAddon | null {
  if (addon || loadError) return addon;
  // The addon is Windows Graphics Capture and D3D11; there is nothing to load
  // anywhere else. On macOS Chromium's own WebRTC encoder is VideoToolbox,
  // which is already hardware, so the ordinary path is the right one there.
  if (process.platform !== 'win32') {
    loadError =
      process.platform === 'darwin'
        ? 'Not needed on macOS: sharing already encodes on the GPU through VideoToolbox.'
        : 'Native GPU capture is only available on Windows.';
    return null;
  }
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
  /** A window's handle, or a point (physical pixels) on the screen to capture. */
  target: number | { x: number; y: number },
  framerate: number,
  bitrate: number,
  maxSize: { width: number; height: number } | null,
  /** Windows 11's yellow outline around the captured window. */
  showBorder: boolean,
  onPacket: (packet: Buffer, keyframe: boolean) => void,
  onError: (message: string) => void,
): {
  width: number;
  height: number;
  output: CaptureOutput;
  vendor: string;
  adapter: string;
  fallbackReason: string;
  encoder: string;
} {
  const native = load();
  if (!native) throw new Error(loadError ?? 'The native capture module is unavailable.');

  stop();
  const info = native.start(
    // As a string: an HWND is a 64-bit handle and a double cannot carry one
    // faithfully.
    {
      ...(typeof target === 'number' ? { hwnd: String(target) } : { monitor: target }),
      framerate,
      bitrate,
      // 0 means "no limit": the window's own size.
      maxWidth: maxSize?.width ?? 0,
      maxHeight: maxSize?.height ?? 0,
      showBorder,
    },
    (error, packet, keyframe) => {
      if (error) {
        onError(error);
        return;
      }
      if (packet) onPacket(packet, keyframe === true);
    },
  );
  running = true;
  return info;
}

/**
 * Set when the compiled addon is older than the JavaScript driving it.
 *
 * The addon is built separately (`npm run build:native`), so a checkout that
 * only ran `npm run dev` after pulling keeps the addon it had. One from before
 * AMF moved into it hands a Radeon raw frames, and the native path then
 * refused with "no encoder for AMD Radeon RX 7800 XT" — which reads as a
 * driver problem and was not one. `setBitrate` arrived with AMF, so its
 * absence dates the build. A packaged app always carries a matching pair.
 */
export function outdatedAddon(): string | null {
  const native = load();
  if (!native || typeof native.setBitrate === 'function') return null;
  return (
    'The native capture addon is older than this app and has no AMF encoder. ' +
    'Rebuild it with `npm run build:native` in desktop/, with the app closed.'
  );
}

/** Makes the encoder's next frame a keyframe. A no-op when frames go out raw. */
export function requestKeyframe(): void {
  if (!running) return;
  load()?.requestKeyframe();
}

/**
 * Moves the addon's encoder (NVENC or AMF) to a new target bitrate in place.
 * Throws when nothing is encoding — raw frames go to ffmpeg, whose rate is
 * fixed for its run.
 */
export function setBitrate(bitsPerSecond: number): void {
  if (!running) throw new Error('No capture is running.');
  const native = load();
  if (!native) throw new Error('The native capture module is unavailable.');
  native.setBitrate(Math.round(bitsPerSecond));
}

/** Running totals from the addon; diff two readings for a rate. */
export interface CaptureStats {
  framesOffered: number;
  framesArrived: number;
  encodeMs: number;
  /** Slowest raw-path scale + readback since the last call. */
  maxReadbackMs: number;
  /** Raw frames skipped because JavaScript had not taken the last ones yet. */
  framesBacklogged: number;
}

export function stats(): CaptureStats | null {
  if (!running) return null;
  try {
    return load()?.stats() ?? null;
  } catch {
    return null;
  }
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
