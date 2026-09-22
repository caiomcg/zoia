/**
 * Hardware-encoded broadcasting, the way native apps do it.
 *
 * Chromium's WebRTC stack has no hardware encoder on Windows — measured, not
 * assumed: navigator.mediaCapabilities.encodingInfo() reports
 * powerEfficient=false for H.264, VP8, VP9 and AV1 at every resolution, in
 * Electron *and* in stock Chrome on a machine with an idle RTX 4070, and a
 * live publish reports encoderImplementation "OpenH264". No flag changes it.
 *
 * So this path bypasses Chromium entirely: ffmpeg captures the desktop on the
 * GPU (ddagrab, D3D11), encodes with NVENC, and publishes over WHIP to a
 * LiveKit ingress, which forwards the stream without re-encoding it.
 *
 * Application audio is fed in on stdin as raw PCM from the same WASAPI capture
 * the Chromium path uses, which also fixes audio/video sync: ffmpeg timestamps
 * both from one clock, rather than two independent ones drifting apart.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app, type BrowserWindow } from 'electron';

export interface NvencOptions {
  whipUrl: string;
  width: number;
  height: number;
  framerate: number;
  bitrate: number;
  /** null captures the whole system's audio rather than one process. */
  processId: number | null;
}

export interface NvencStatus {
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
let lastAudioAt = 0;
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
    if (!child?.stdin.writable) return;
    if (Date.now() - lastAudioAt >= KEEPALIVE_MS) {
      child.stdin.write(SILENCE, () => {});
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

function buildArgs(options: NvencOptions): string[] {
  const { whipUrl, framerate, bitrate } = options;

  return [
    '-hide_banner',
    '-loglevel',
    'info',

    // Video: captured and kept on the GPU all the way into the encoder.
    // ddagrab captures the desktop at its native resolution. Constraining it
    // with video_size produced a running encoder that emitted zero frames, so
    // the scaling happens afterwards, on the GPU, where it is nearly free.
    '-f',
    'lavfi',
    '-i',
    `ddagrab=output_idx=0:framerate=${framerate}`,

    // Audio: raw PCM on stdin, exactly what WASAPI process loopback produces.
    '-f',
    's16le',
    '-ar',
    String(SAMPLE_RATE),
    '-ac',
    String(CHANNELS),
    '-thread_queue_size',
    '512',
    '-i',
    'pipe:0',

    ...scaleArgs(),

    '-c:v',
    'h264_nvenc',
    '-preset',
    'p4',
    '-tune',
    'll', // low latency; this is a live stream, not a file
    '-profile:v',
    'baseline', // widest decoder support among viewers
    '-b:v',
    String(bitrate),
    '-maxrate',
    String(bitrate),
    '-bufsize',
    String(bitrate),
    '-bf',
    '0', // B-frames add latency and WebRTC does not want them
    '-g',
    String(framerate * 2),

    '-c:a',
    'libopus',
    '-b:a',
    '128k',
    '-application',
    'lowdelay',

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
        win.webContents.send('zoia:nvenc:status', {
          running: true,
          fps: 0,
          encoder: 'h264_nvenc',
          width: captureWidth,
          height: captureHeight,
          error: 'No new frames — the screen may be static.',
        } satisfies NvencStatus);
      }
    }
    framesAtLastCheck = frameCount;
  }, 5000);
}

export function isRunning(): boolean {
  return child !== null;
}

export function start(win: BrowserWindow, options: NvencOptions): void {
  stop();
  lastError = null;
  frameCount = 0;

  const binary = ffmpegPath();
  child = spawn(binary, buildArgs(options), { windowsHide: true });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    // ffmpeg reports progress on stderr; the frame counter is the liveness
    // signal, and anything that looks like a real failure is surfaced.
    if (process.env.ZOIA_FFMPEG_LOG) console.log(`[ffmpeg] ${chunk.trimEnd()}`);

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
      win.webContents.send('zoia:nvenc:status', {
        running: true,
        fps: lastFps,
        encoder: 'h264_nvenc',
        width: captureWidth,
        height: captureHeight,
        error: lastError,
      } satisfies NvencStatus);
    }
  });

  child.on('exit', (code) => {
    child = null;
    if (watchdog) clearInterval(watchdog);
    watchdog = null;
    if (!win.isDestroyed()) {
      win.webContents.send('zoia:nvenc:status', {
        running: false,
        fps: 0,
        encoder: 'h264_nvenc',
        width: 0,
        height: 0,
        error: code === 0 ? null : (lastError ?? `ffmpeg exited with code ${code}`),
      } satisfies NvencStatus);
    }
  });

  startWatchdog(win);
  startKeepAlive();
}

/** Feeds one chunk of captured PCM to the encoder. */
export function writeAudio(chunk: Buffer): void {
  if (!child?.stdin.writable) return;
  lastAudioAt = Date.now();
  // Dropped rather than buffered: audio that cannot be written now is audio
  // that is already late, and queueing it would only grow the A/V offset.
  child.stdin.write(chunk, () => {});
}

export function stop(): void {
  if (watchdog) clearInterval(watchdog);
  watchdog = null;
  if (keepAlive) clearInterval(keepAlive);
  keepAlive = null;
  if (!child) return;
  const dying = child;
  child = null;
  dying.stdin.end();
  dying.kill();
}
