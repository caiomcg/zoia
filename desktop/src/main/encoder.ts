/**
 * Hardware-encoded broadcasting, the way native apps do it.
 *
 * Chromium's WebRTC stack has no hardware encoder on Windows — measured, not
 * assumed: navigator.mediaCapabilities.encodingInfo() reports
 * powerEfficient=false for H.264, VP8, VP9 and AV1 at every resolution, in
 * Electron *and* in stock Chrome on a machine with an idle RTX 4070, and a
 * live publish reports encoderImplementation "OpenH264". No flag changes it.
 *
 * So this path bypasses Chromium entirely and publishes over WHIP to a LiveKit
 * ingress, which forwards the stream without re-encoding it.
 *
 * It is not NVENC-only, despite what this file used to be called. Which
 * encoder runs depends on the GPU the capture landed on:
 *
 *   NVIDIA  the native addon encodes with NVENC and ffmpeg only muxes
 *   AMD     ffmpeg encodes the frames with h264_amf
 *   Intel   ffmpeg encodes the frames with h264_qsv
 *   screen  ffmpeg captures with ddagrab and encodes it itself
 *
 * The old name leaked into the IPC channels too, so a Radeon failing to share
 * said "zoia:nvenc:start" and left somebody reasonably asking why it was
 * running NVENC at all.
 *
 * Application audio is fed in on stdin as raw PCM from the same WASAPI capture
 * the Chromium path uses, which also fixes audio/video sync: ffmpeg timestamps
 * both from one clock, rather than two independent ones drifting apart.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server, type Socket } from 'node:net';
import { existsSync, appendFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { app, type BrowserWindow } from 'electron';
import * as api from './api';

export interface EncoderOptions {
  whipUrl: string;
  framerate: number;
  bitrate: number;
  /** The application whose audio to send; null means send no audio at all. */
  processId: number | null;
  /**
   * False for a screen share. Sharing a whole screen used to fall back to
   * capturing the whole system's output, which sends every notification and
   * every other app along with it — never what someone means by "share my
   * screen". Sharing a window still sends that window's audio.
   */
  withAudio: boolean;
  /**
   * Set when the native capture is feeding stdin, with what it is sending.
   *
   * ffmpeg has no way to capture a single window: ddagrab is Desktop
   * Duplication (screen only) and gdigrab returns blank frames for modern
   * GPU-composited windows — verified by capturing one and looking at it.
   * Windows Graphics Capture is the only thing that genuinely captures a
   * window, so the addon always does the capturing.
   *
   * What it sends depends on the GPU:
   *
   *  - `h264` on an NVIDIA adapter, where the addon encodes with NVENC and
   *    the frame never leaves the GPU. ffmpeg only muxes.
   *  - `bgra` on anything else, because NVENC is NVIDIA's alone. The addon
   *    reads the frame back and ffmpeg encodes it with AMF on a Radeon or
   *    Quick Sync on an Intel GPU — still on the GPU, one copy later.
   */
  frames: { width: number; height: number; output: 'h264' | 'bgra'; vendor: string } | null;
}

export interface EncoderStatus {
  running: boolean;
  fps: number;
  encoder: string;
  /** What ddagrab actually captured, which is the desktop's native size. */
  width: number;
  height: number;
  error: string | null;
}

const SAMPLE_RATE = 48000;
const CHANNELS = 2;

// Windows named pipe. ffmpeg opens this as an ordinary input file.
const AUDIO_PIPE = '\\\\.\\pipe\\zoia-audio';

/**
 * Bundled rather than assumed present: the build that ships must be one with
 * GnuTLS. An ffmpeg built against Windows SChannel negotiates DTLS and then
 * fails with "no SRTP Protection Profile was chosen", because SChannel has no
 * use_srtp extension — WHIP cannot work with it at all.
 */
function ffmpegPath(): string {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'ffmpeg', 'ffmpeg-gnutls.exe')]
    : [join(app.getAppPath(), 'vendor', 'ffmpeg-gnutls.exe')];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    'ffmpeg is missing from this build. GPU encoding needs vendor/ffmpeg-gnutls.exe — ' +
      'run make-exe.bat, which fetches it.',
  );
}

let child: ChildProcessWithoutNullStreams | null = null;
let lastError: string | null = null;
let lastFps = 0;
let watchdog: ReturnType<typeof setInterval> | null = null;
let framesAtLastCheck = -1;
let frameCount = 0;
let captureWidth = 0;
let captureHeight = 0;
let audioServer: Server | null = null;
let audioSocket: Socket | null = null;
let lastAudioAt = 0;

/**
 * ffmpeg reads its inputs together, so audio and video each need their own
 * channel; stdin carries video frames, and this pipe carries PCM. The server
 * is started before ffmpeg so the pipe exists when ffmpeg opens it.
 */
function startAudioPipe(): void {
  stopAudioPipe();
  audioServer = createServer((socket) => {
    audioSocket = socket;
    socket.on('error', () => {});
    socket.on('close', () => {
      if (audioSocket === socket) audioSocket = null;
    });
  });
  audioServer.on('error', () => {});
  audioServer.listen(AUDIO_PIPE);
}

function stopAudioPipe(): void {
  audioSocket?.destroy();
  audioSocket = null;
  audioServer?.close();
  audioServer = null;
}
let keepAlive: ReturnType<typeof setInterval> | null = null;

// 50ms of stereo silence, which is what gets written when the capture has
// nothing to give.
const KEEPALIVE_MS = 50;
const SILENCE = Buffer.alloc((SAMPLE_RATE * CHANNELS * 2 * KEEPALIVE_MS) / 1000);

/**
 * ffmpeg reads video and audio together, so a starved audio pipe stalls the
 * *video* as well: measured as a running encoder emitting zero frames.
 *
 * WASAPI loopback can legitimately deliver nothing at all while the captured
 * application is silent, which is exactly when this happens. Writing silence
 * in that gap keeps the pipe fed and the encoder running.
 */
function startKeepAlive(): void {
  lastAudioAt = Date.now();
  keepAlive = setInterval(() => {
    const socket = audioSocket;
    if (!socket || socket.destroyed || !socket.writable) return;
    if (Date.now() - lastAudioAt >= KEEPALIVE_MS) {
      try {
        socket.write(SILENCE);
      } catch {
        return;
      }
      lastAudioAt = Date.now();
    }
  }, KEEPALIVE_MS);
}

/**
 * No resizing happens on this path, and that is deliberate.
 *
 * ddagrab hands over D3D11 frames at the desktop's native resolution. Every
 * way of shrinking them was measured failing or being unusable on this
 * machine:
 *   - scale_d3d11 (any output format) aborts with "Failed to configure
 *     output pad" / "Unsupported pixel format";
 *   - hwmap=derive_device=cuda,scale_cuda aborts with ENOSYS;
 *   - hwdownload + CPU scale + hwupload_cuda works, but on a 4K60 desktop it
 *     means moving ~2GB/s of BGRA out of the GPU, which does not sustain.
 *
 * So the stream goes out at native resolution and the quality preset governs
 * frame rate and bitrate instead. That is what actually publishes, and it is
 * reported honestly in the UI rather than claiming a resolution we are not
 * sending.
 */
function scaleArgs(): string[] {
  return [];
}

/**
 * The encoder to ask ffmpeg for, from the GPU the frames were captured on.
 *
 * Every one of these is in the vendored build (verified with -encoders), and
 * all three are real hardware encoders — this is not a software fallback
 * dressed up. `h264_mf` would be a fourth, through Media Foundation, but it
 * has no low-latency controls worth the name.
 */
function encoderFor(vendor: string): string {
  switch (vendor) {
    case 'amd':
      return 'h264_amf';
    case 'intel':
      return 'h264_qsv';
    default:
      return 'h264_nvenc';
  }
}

/**
 * Low-latency knobs, which every vendor spells differently.
 *
 * **No `-profile:v` here, deliberately.** It used to pass `baseline` for
 * "widest decoder support among viewers", and in this ffmpeg build that one
 * argument fails every encode with
 *
 *     Task finished with error code: -22 (Invalid argument)
 *     Error opening output files: Invalid argument
 *
 * which reads like a broken WHIP endpoint and is nothing of the kind. Measured
 * against the vendored binary: libx264 encodes a test pattern happily with no
 * profile and fails with `baseline`, `constrained_baseline`, `main` and `high`
 * alike, so it is `-profile:v` itself this build will not take, not the value.
 *
 * It broke GPU sharing on every GPU — Radeon, GTX 1060 and RTX 5090 all
 * reported the same thing — because it sat on the shared argument list rather
 * than any one vendor's path.
 *
 * Nothing is lost by dropping it. Every viewer is this same app, and Chromium
 * decodes whatever these encoders pick by default.
 */
function encoderTuning(encoder: string): string[] {
  switch (encoder) {
    case 'h264_amf':
      // AMF counts B-frames in frames; above zero buys compression with
      // latency a viewer feels.
      return ['-usage', 'ultralowlatency', '-quality', 'speed', '-rc', 'cbr', '-bf', '0'];
    case 'h264_qsv':
      return ['-preset', 'veryfast', '-look_ahead', '0', '-bf', '0'];
    default:
      return ['-preset', 'p4', '-tune', 'll', '-bf', '0'];
  }
}

/**
 * The encoder the current run is using. Status used to report h264_nvenc
 * unconditionally, which on a Radeon was simply untrue and made the one
 * number worth reading — what is doing the encoding — misleading.
 */
let currentEncoder = 'unknown';

export function encoderInUse(): string {
  return currentEncoder;
}

function buildArgs(options: EncoderOptions): string[] {
  const { whipUrl, framerate, bitrate } = options;
  const frames = options.frames;
  // Already-encoded H.264 is muxed straight through. It used to be decoded and
  // re-encoded here — the addon's NVENC output went through `format=nv12,
  // hwupload_cuda` into h264_nvenc a second time — which cost quality and GPU
  // for nothing.
  const passthrough = frames?.output === 'h264';
  const encoder = encoderFor(frames?.vendor ?? 'nvidia');
  // Passthrough means the addon's own NVENC produced it; otherwise ffmpeg's.
  currentEncoder = passthrough ? 'nvenc (native)' : encoder;

  return [
    '-hide_banner',
    '-loglevel',
    'info',

    // Video: captured and kept on the GPU all the way into the encoder.
    // ddagrab captures the desktop at its native resolution. Constraining it
    // with video_size produced a running encoder that emitted zero frames, so
    // the scaling happens afterwards, on the GPU, where it is nearly free.
    // Video. Either an H.264 bitstream the native capture already encoded on
    // the GPU, or the whole desktop grabbed by ffmpeg itself.
    ...(!frames
      ? ['-f', 'lavfi', '-i', `ddagrab=output_idx=0:framerate=${framerate}`]
      : passthrough
        ? [
            '-f',
            'h264',
            '-framerate',
            String(framerate),
            '-thread_queue_size',
            '64',
            '-i',
            'pipe:0',
          ]
        : [
            '-f',
            'rawvideo',
            '-pix_fmt',
            'bgra',
            '-s',
            `${frames.width}x${frames.height}`,
            '-framerate',
            String(framerate),
            '-thread_queue_size',
            '64',
            '-i',
            'pipe:0',
          ]),

    // Audio: raw PCM, exactly what WASAPI process loopback produces. It gets
    // its own named pipe because stdin may already be carrying video.
    ...(options.withAudio
      ? [
          '-f',
          's16le',
          '-ar',
          String(SAMPLE_RATE),
          '-ac',
          String(CHANNELS),
          '-thread_queue_size',
          '512',
          '-i',
          AUDIO_PIPE,
        ]
      : []),

    // Raw frames arrive as BGRA in system memory; every hardware encoder
    // wants NV12, and the conversion is cheap next to the encode.
    ...(frames && !passthrough ? ['-vf', 'format=nv12'] : []),

    ...scaleArgs(),

    ...(passthrough
      ? // Nothing to do but carry the bitstream to the muxer.
        ['-c:v', 'copy']
      : [
          '-c:v',
          encoder,
          ...encoderTuning(encoder),
          '-b:v',
          String(bitrate),
          '-maxrate',
          String(bitrate),
          '-bufsize',
          String(bitrate),
          '-g',
          String(framerate * 2),
        ]),

    ...(options.withAudio
      ? ['-c:a', 'libopus', '-b:a', '128k', '-application', 'lowdelay']
      : ['-an']),

    // Without dtls_active ffmpeg tries to be the DTLS server and fails to
    // create a security context; measured on Windows.
    '-whip_flags',
    'dtls_active',
    // Without a generous buffer the muxer fails sends with EAGAIN (-11) as
    // soon as bitrate rises.
    '-ts_buffer_size',
    '16000000',
    '-f',
    'whip',
    whipUrl,
  ];
}

/**
 * ddagrab is Desktop Duplication: it only produces frames when the screen
 * actually changes. A completely static desktop can therefore stall the
 * encoder, which viewers see as a frozen picture rather than an error. This
 * notices the stall so the UI can say so.
 */
function startWatchdog(win: BrowserWindow): void {
  framesAtLastCheck = -1;
  watchdog = setInterval(() => {
    if (framesAtLastCheck === frameCount && child) {
      if (!win.isDestroyed()) {
        win.webContents.send('zoia:encoder:status', {
          running: true,
          fps: 0,
          encoder: currentEncoder,
          width: captureWidth,
          height: captureHeight,
          error: 'No new frames — the screen may be static.',
        } satisfies EncoderStatus);
      }
    }
    framesAtLastCheck = frameCount;
  }, 5000);
}

/**
 * Called when ffmpeg exits for any reason, so whoever is feeding it can stop.
 *
 * Without this the native capture kept running after ffmpeg died: on the raw
 * path that is a full-resolution frame read back and copied into the main
 * process on every window redraw, with nowhere to go. The app stopped
 * responding, which looked like a hang rather than a failed broadcast — you
 * could neither stop sharing nor touch the UI.
 */
let onExit: (() => void) | null = null;

/**
 * Everything ffmpeg said this run, and the command that started it.
 *
 * ffmpeg's stderr used to go to a console nobody can see in a packaged app,
 * and only a single regex-matched line ever reached the UI. When a broadcast
 * failed on somebody else's machine the only evidence was that one sentence,
 * relayed by hand — which is how "Invalid argument" got diagnosed three times
 * and fixed wrongly twice. The whole of it now goes to a file, and the tail of
 * it goes to the server when a run fails.
 */
function logPath(): string {
  return join(app.getPath('userData'), 'ffmpeg.log');
}

/** The tail attached to a report. Generous: the server allows 12k characters
 *  and a truncated log is what made three failures indistinguishable. */
const RECENT_LINES = 200;
let recent: string[] = [];
let lastCommand = '';

/**
 * ffmpeg's final line is almost always "Conversion failed!", which says
 * nothing. The cause is one of the lines above it, and the old matcher — any
 * line containing Error, failed, Invalid or Cannot, last one wins — reliably
 * picked the useless one. These are the lines that actually carry a reason.
 */
const GENERIC = /^(Conversion failed|Error opening output file|Exiting|Terminating)/i;

function bestError(): string | null {
  for (let i = recent.length - 1; i >= 0; i--) {
    const line = recent[i]?.trim();
    if (!line || GENERIC.test(line)) continue;
    if (
      /error|failed|invalid|cannot|unsupported|not (yet )?(implemented|supported)|no such/i.test(
        line,
      )
    ) {
      return line;
    }
  }
  return recent.filter(Boolean).slice(-1)[0] ?? null;
}

function logLine(line: string): void {
  recent.push(line);
  if (recent.length > RECENT_LINES) recent.shift();
  try {
    appendFileSync(logPath(), `${line}\n`);
  } catch {
    // A log that cannot be written must never take the broadcast with it.
  }
}

function startLog(command: string): void {
  recent = [];
  lastCommand = command;
  try {
    const path = logPath();
    // Truncated per run rather than grown forever: the interesting run is the
    // one that just failed, and a tester asked for "the log" should not have
    // to find the right part of a 50MB file.
    let previous = '';
    try {
      if (statSync(path).size > 0) previous = '';
    } catch {
      previous = '';
    }
    writeFileSync(path, `${previous}=== ${new Date().toISOString()}\n${command}\n\n`);
  } catch {
    // Same: best effort.
  }
}

/** Where a tester can find the log, so it can be said out loud in the UI. */
export function logLocation(): string {
  return logPath();
}

export function setOnExit(handler: (() => void) | null): void {
  onExit = handler;
}

export function start(win: BrowserWindow, options: EncoderOptions): void {
  stop();
  lastError = null;
  frameCount = 0;

  if (options.withAudio) startAudioPipe();
  const binary = ffmpegPath();
  const args = buildArgs(options);
  // The command first, because an argument this rejects is invisible in the
  // error it produces — "Error opening output files: Invalid argument" names
  // neither the argument nor the encoder.
  startLog([binary, ...args].join(' '));
  child = spawn(binary, args, { windowsHide: true });

  // ffmpeg exiting closes this pipe; without a listener the resulting EPIPE
  // is an uncaught exception rather than an event.
  child.stdin.on('error', () => {});

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    // ffmpeg reports progress on stderr; the frame counter is the liveness
    // signal, and anything that looks like a real failure is surfaced.
    if (process.env.ZOIA_FFMPEG_LOG) console.log(`[ffmpeg] ${chunk.trimEnd()}`);
    logLine(chunk.trimEnd());

    // ffmpeg announces the input stream once; that line carries the real
    // capture resolution, which is the only honest thing to show the user.
    const size = chunk.match(/Video: wrapped_avframe[^\n]*?(\d{3,5})x(\d{3,5})/);
    if (size?.[1] && size[2]) {
      captureWidth = Number(size[1]);
      captureHeight = Number(size[2]);
    }

    const frames = chunk.match(/frame=\s*(\d+)/);
    if (frames?.[1]) frameCount = Number(frames[1]);

    const fps = chunk.match(/fps=\s*([\d.]+)/);
    if (fps?.[1]) lastFps = Number(fps[1]);

    if (/Error|failed|Invalid|Cannot/i.test(chunk) && !/Last message repeated/.test(chunk)) {
      lastError = chunk.trim().split('\n').slice(-1)[0] ?? null;
    }

    if (!win.isDestroyed()) {
      win.webContents.send('zoia:encoder:status', {
        running: true,
        fps: lastFps,
        encoder: currentEncoder,
        width: captureWidth,
        height: captureHeight,
        error: lastError,
      } satisfies EncoderStatus);
    }
  });

  child.on('exit', (code) => {
    child = null;
    if (watchdog) clearInterval(watchdog);
    watchdog = null;
    // Before anything else: stop whatever is still producing frames for a
    // process that no longer exists.
    try {
      onExit?.();
    } catch {
      // A cleanup handler that throws must not mask the exit itself.
    }

    // A failed broadcast is not a crash, so nothing here was ever reported —
    // the one class of failure most likely to happen on hardware nobody
    // testing this owns. The command and the tail of ffmpeg's own output go
    // with it, since the extracted one-liner has repeatedly been too little
    // to identify the cause.
    if (code !== 0) {
      // Everything needed to diagnose this without asking anybody to find a
      // file: the reason, the exact command, and what ffmpeg actually said.
      void api.report({
        kind: 'gpu-broadcast-failed',
        message: bestError() ?? lastError ?? `ffmpeg exited with code ${code}`,
        stack: lastCommand,
        context: recent.join('\n').slice(-11000),
      });
    }
    if (!win.isDestroyed()) {
      win.webContents.send('zoia:encoder:status', {
        running: false,
        fps: 0,
        encoder: currentEncoder,
        width: 0,
        height: 0,
        error: code === 0 ? null : (lastError ?? `ffmpeg exited with code ${code}`),
      } satisfies EncoderStatus);
    }
  });

  startWatchdog(win);
  if (options.withAudio) startKeepAlive();
}

/** Ends the broadcast for good, as opposed to the restart start() performs. */
export function shutdown(): void {
  stop();
}

/** Feeds one chunk of captured PCM to the encoder. */
export function writeAudio(chunk: Buffer): void {
  const socket = audioSocket;
  if (!socket || socket.destroyed || !socket.writable) return;
  lastAudioAt = Date.now();
  try {
    // Dropped rather than buffered: audio that cannot be written now is audio
    // that is already late, and queueing it would only grow the A/V offset.
    socket.write(chunk);
  } catch {
    // Same as writeFrame: a closed pipe is the end of a broadcast, not a
    // reason to bring the process down.
  }
}

/**
 * Feeds one encoded frame to the muxer.
 *
 * Writes race against ffmpeg exiting: the pipe can close between the
 * writable check and the write itself, and the resulting EPIPE/EOF is
 * emitted on the stream rather than thrown by write(). Unhandled, that
 * reached the process as "Uncaught Error: write EPIPE" and closed the app
 * with a dialog. A dead pipe simply means the broadcast is over.
 */
export function writeFrame(frame: Buffer): void {
  const stdin = child?.stdin;
  if (!stdin || stdin.destroyed || !stdin.writable) return;
  try {
    // Back-pressure is handled by dropping: a frame that cannot be written
    // now is better skipped than queued, which would only add latency.
    stdin.write(frame, () => {});
  } catch {
    // The pipe went away mid-write; stop() will tidy up.
  }
}

export function stop(): void {
  if (watchdog) clearInterval(watchdog);
  watchdog = null;
  if (keepAlive) clearInterval(keepAlive);
  keepAlive = null;
  stopAudioPipe();
  if (!child) return;
  const dying = child;
  child = null;
  dying.stdin.end();
  dying.kill();
}
