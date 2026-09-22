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
const { LoopbackCapture: LoopbackCaptureCtor } = require('loopback-capture') as {
  LoopbackCapture: new () => LoopbackCaptureInstance;
};

let capture: LoopbackCaptureInstance | null = null;

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

  capture = new LoopbackCaptureCtor();
  const onChunk = (chunk: Buffer) => {
    if (sink) {
      sink(chunk);
      return;
    }
    if (!win.isDestroyed()) win.webContents.send('zoia:audio:chunk', chunk);
  };

  if (processId !== null) {
    capture.start(processId, true, onChunk);
  } else {
    capture.startSystemAudio(onChunk);
  }
}

export function stopCapture(): void {
  capture?.stop();
  capture = null;
}
