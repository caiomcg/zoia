/**
 * Turns the PCM stream coming from main (real WASAPI process-loopback — see
 * src/main/audio.ts) into a MediaStreamTrack that LiveKit can publish like
 * any other audio track.
 *
 * The pipeline: main sends Buffer chunks over IPC -> this module forwards
 * each one, untouched, to an AudioWorkletProcessor's port as a transferable
 * ArrayBuffer -> the worklet (on the dedicated audio thread) decodes and
 * plays them into a MediaStreamAudioDestinationNode -> its track is what gets
 * published.
 */

const SAMPLE_RATE = 48000; // must match pcm-worklet.js and WASAPI's own rate

export interface CaptureStats {
  underruns: number;
  overruns: number;
  peak: number;
  /** Buffered audio in ms — the A/V offset this stage contributes. */
  latencyMs: number;
  /** Frames dropped to hold the latency ceiling, i.e. accumulated clock drift. */
  drifted: number;
}

const AUDIO_STATS_MS = 5000;

/**
 * Logs what the worklet counted every few seconds, as the raw video path's
 * [raw-video] line does for frames.
 *
 * The counters were only ever drawn as a level meter, so a report of
 * crackling sound had nothing in the log to check against. These are the
 * two ways this pipeline can make one: an underrun plays silence where audio
 * was due (a gap), and a drift drop discards buffered audio to hold the
 * latency ceiling (a cut). Either, often enough, is heard as crackle; zero of
 * both while it crackled puts the cause downstream of here.
 *
 * The worklet's counters are running totals; this reports their growth.
 */
export function audioStatsLogger(): (stats: CaptureStats) => void {
  let last: CaptureStats | null = null;
  let since = performance.now();
  let minLatency = Infinity;
  let maxLatency = 0;
  return (stats) => {
    minLatency = Math.min(minLatency, stats.latencyMs);
    maxLatency = Math.max(maxLatency, stats.latencyMs);
    const now = performance.now();
    if (now - since < AUDIO_STATS_MS) return;
    const base = last ?? { underruns: 0, overruns: 0, drifted: 0 };
    const ms = (frames: number) => ((frames * 1000) / SAMPLE_RATE).toFixed(0);
    console.log(
      `[audio] ${((now - since) / 1000).toFixed(0)}s: ` +
        `${ms(stats.underruns - base.underruns)}ms underrun (silence played), ` +
        `${ms(stats.drifted - base.drifted)}ms dropped for drift, ` +
        `${ms(stats.overruns - base.overruns)}ms overrun (ring full), ` +
        `buffer ${minLatency}..${maxLatency}ms`,
    );
    last = stats;
    since = now;
    minLatency = Infinity;
    maxLatency = 0;
  };
}

export interface CaptureTrackHandle {
  track: MediaStreamTrack;
  /** How loud viewers hear it, 0..1. */
  setSendGain(value: number): void;
  onStats(cb: (stats: CaptureStats) => void): () => void;
  stop(): Promise<void>;
}

/**
 * `processId: null` captures the whole system's output — the fallback for a
 * screen source, which has no single owning process.
 */
export async function createCaptureAudioTrack(
  processId: number | null,
): Promise<CaptureTrackHandle> {
  // Pinned to 48kHz deliberately: letting the context pick the device's own
  // rate would insert a resampler between us and WASAPI's native rate, and
  // resampling is a source of drift and artifacts neither side asked for.
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });

  // Resolved against the loaded document, not the bundled script's own URL —
  // the worklet is a public/ asset copied next to index.html, not part of the
  // bundle under assets/, and file:// URLs treat a *root*-relative path
  // ("/pcm-worklet.js") as the filesystem root rather than the page's folder.
  const workletUrl = new URL('pcm-worklet.js', document.baseURI).href;
  await ctx.audioWorklet.addModule(workletUrl);

  const node = new AudioWorkletNode(ctx, 'pcm-playback', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });

  const listeners = new Set<(stats: CaptureStats) => void>();
  node.port.onmessage = (event) => {
    const stats = event.data as CaptureStats;
    for (const cb of listeners) cb(stats);
  };

  const destination = ctx.createMediaStreamDestination();
  const sendGain = ctx.createGain();
  node.connect(sendGain);
  sendGain.connect(destination);

  const unsubscribe = window.zoia.audio.onChunk((chunk) => {
    // The chunk is a Uint8Array that crossed contextBridge via structured
    // clone, so its buffer is already a copy owned by this process — safe to
    // hand off to the worklet's own thread rather than copy again.
    const owned =
      chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength
        ? chunk.buffer
        : chunk.slice().buffer;
    node.port.postMessage(owned, [owned]);
  });

  await window.zoia.audio.start(processId);

  const [track] = destination.stream.getAudioTracks();
  if (!track) throw new Error('MediaStreamAudioDestinationNode produced no audio track.');

  return {
    track,
    setSendGain(value: number) {
      sendGain.gain.value = value;
    },
    onStats(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    async stop() {
      unsubscribe();
      listeners.clear();
      await window.zoia.audio.stop();
      node.disconnect();
      await ctx.close();
    },
  };
}

/** How often the level meter is refreshed for a wrapped track. */
const METER_MS = 100;

/**
 * The same handle, for audio Chromium already captured — on macOS, the system
 * loopback that ScreenCaptureKit hands back with the display stream. There is
 * no PCM relay and no worklet here, only a gain stage (so the send volume
 * works as it does on Windows) and an analyser for the level meter.
 */
export async function wrapAudioTrack(input: MediaStreamTrack): Promise<CaptureTrackHandle> {
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  const source = ctx.createMediaStreamSource(new MediaStream([input]));
  const sendGain = ctx.createGain();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  const destination = ctx.createMediaStreamDestination();
  source.connect(sendGain);
  sendGain.connect(analyser);
  sendGain.connect(destination);

  const [track] = destination.stream.getAudioTracks();
  if (!track) throw new Error('MediaStreamAudioDestinationNode produced no audio track.');

  const listeners = new Set<(stats: CaptureStats) => void>();
  const samples = new Float32Array(analyser.fftSize);
  const meter = setInterval(() => {
    if (listeners.size === 0) return;
    analyser.getFloatTimeDomainData(samples);
    let peak = 0;
    for (const value of samples) peak = Math.max(peak, Math.abs(value));
    const stats: CaptureStats = {
      underruns: 0,
      overruns: 0,
      peak,
      latencyMs: Math.round((ctx.baseLatency + (ctx.outputLatency || 0)) * 1000),
      drifted: 0,
    };
    for (const cb of listeners) cb(stats);
  }, METER_MS);

  return {
    track,
    setSendGain(value: number) {
      sendGain.gain.value = value;
    },
    onStats(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    async stop() {
      clearInterval(meter);
      listeners.clear();
      source.disconnect();
      input.stop();
      await ctx.close();
    },
  };
}
