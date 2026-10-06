/**
 * Per-application audio, via real WASAPI process-loopback capture — proven
 * standalone against a live process before any of this plumbing was written
 * (see docs/adr; a raw PCM capture from a real Chrome PID, saved to a WAV
 * file and confirmed non-silent). This module is just the wiring: take what
 * loopback-capture hands us and get it to the renderer.
 *
 * PCM chunks are S16LE, stereo, 48kHz (loopback-capture's documented format)
 * and are sent to the renderer over the ordinary webContents.send channel —
 * not a MessagePort. At ~100 chunks/sec of a few KB each this is well within
 * what Electron's structured-clone IPC handles; a zero-copy transfer is not
 * worth the added complexity unless profiling says otherwise.
 */

import type { BrowserWindow } from 'electron';
import { createRequire } from 'node:module';
import { silenceToFillMs } from './audio-gaps';
import { BYTES_PER_MS } from './media-clock';

interface LoopbackCaptureInstance {
  start(processId: number, includeProcessTree: boolean, callback: (chunk: Buffer) => void): void;
  stop(): void;
  startSystemAudio(callback: (chunk: Buffer) => void): void;
}

// `import * as loopbackCaptureModule from 'loopback-capture'` produced a
// LoopbackCaptureCtor that was `undefined` at runtime — "TypeError:
// LoopbackCaptureCtor is not a constructor" — even though the .d.ts (wrongly,
// as it turns out doubly wrong) suggested a value existed to cast. The real
// cause: loopback-capture ships a bundled, minified dist/index.cjs, and
// Node's ESM-importing-CJS interop only statically detects named exports
// from source simple enough for cjs-module-lexer to analyze; a minified
// bundle isn't, so only the namespace's `.default` (the real module.exports)
// comes through reliably.
//
// Rather than guess at the interop shape a second time, this uses
// createRequire to get a plain, real CommonJS `require` — the exact call a
// standalone script used to capture genuine, non-silent audio from a live
// process on this machine (verified: saved to a WAV file, confirmed
// non-silent — see the runbook). Same code path, not a new guess.
const require = createRequire(import.meta.url);

type LoopbackCaptureCtor = new () => LoopbackCaptureInstance;

// Loaded on first use, not at import: loopback-capture is WASAPI and is an
// optional dependency that npm skips entirely on macOS. Requiring it at module
// scope took the whole main process down with it there.
let LoopbackCaptureCtor: LoopbackCaptureCtor | null = null;

function loadCtor(): LoopbackCaptureCtor {
  if (process.platform !== 'win32') {
    throw new Error('Application audio capture is only available on Windows.');
  }
  LoopbackCaptureCtor ??= (require('loopback-capture') as { LoopbackCapture: LoopbackCaptureCtor })
    .LoopbackCapture;
  return LoopbackCaptureCtor;
}

/** Whether a window share can carry its application's audio on this OS. */
export const perAppAudioSupported = process.platform === 'win32';

let capture: LoopbackCaptureInstance | null = null;
let gapTimer: ReturnType<typeof setInterval> | null = null;

const GAP_CHECK_MS = 20;
const CAPTURE_STATS_MS = 5000;

/**
 * Starts capturing one process's audio (or the whole system's, if `processId`
 * is null — the fallback for a screen source, which has no owning process).
 * Any previous capture is stopped first; only one broadcaster at a time.
 */
/**
 * `sink` decides where the captured PCM goes. The Chromium path relays it to
 * the renderer over IPC; the NVENC path writes it straight into ffmpeg's
 * stdin, so ffmpeg timestamps audio and video off one clock instead of two.
 */
export function startCapture(
  win: BrowserWindow,
  processId: number | null,
  sink?: (chunk: Buffer) => void,
): void {
  stopCapture();

  const Ctor = loadCtor();
  capture = new Ctor();

  // Wall-clock time the audio relayed so far reaches (see audio-gaps.ts), and
  // what the log reports every few seconds: how much of real time arrived,
  // and how much had to be filled.
  let coveredUntil = 0;
  let receivedMs = 0;
  let filledMs = 0;
  let gaps = 0;
  let statsSince = performance.now();
  const relay = (chunk: Buffer) => {
    if (!win.isDestroyed()) win.webContents.send('zoia:audio:chunk', chunk);
  };

  const onChunk = (chunk: Buffer) => {
    if (sink) {
      sink(chunk);
      return;
    }
    coveredUntil = performance.now();
    receivedMs += chunk.length / BYTES_PER_MS;
    relay(chunk);
  };

  // The ffmpeg route has its own keepalive in encoder.ts; this is the relay's.
  if (!sink) {
    gapTimer = setInterval(() => {
      const now = performance.now();
      if (now - statsSince >= CAPTURE_STATS_MS) {
        const elapsed = now - statsSince;
        console.log(
          `[audio-capture] ${(elapsed / 1000).toFixed(0)}s: ` +
            `${receivedMs.toFixed(0)}ms delivered (${((receivedMs / elapsed) * 100).toFixed(1)}% of real time), ` +
            `${filledMs.toFixed(0)}ms of gaps filled with silence in ${gaps} gaps`,
        );
        receivedMs = 0;
        filledMs = 0;
        gaps = 0;
        statsSince = now;
      }
      if (silenceToFillMs(coveredUntil, now) === 0) return;
      // Not yet: timers run before I/O in Node's loop, so after a main-thread
      // stall this fires while packets delayed by it are still queued. Filling
      // now would put silence where they belong — the same trap encoder.ts's
      // keepalive learned to step around. setImmediate runs after that I/O.
      setImmediate(() => {
        const fill = silenceToFillMs(coveredUntil, performance.now());
        if (fill === 0 || !capture) return;
        // Whole sample frames only (4 bytes: two 16-bit channels).
        const bytes = Math.floor((fill * BYTES_PER_MS) / 4) * 4;
        relay(Buffer.alloc(bytes));
        coveredUntil += fill;
        filledMs += fill;
        gaps++;
      });
    }, GAP_CHECK_MS);
  }

  if (processId !== null) {
    capture.start(processId, true, onChunk);
  } else {
    capture.startSystemAudio(onChunk);
  }
}

export function stopCapture(): void {
  if (gapTimer) clearInterval(gapTimer);
  gapTimer = null;
  capture?.stop();
  capture = null;
}
