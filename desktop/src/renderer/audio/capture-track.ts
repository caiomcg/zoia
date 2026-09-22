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

export interface CaptureTrackHandle {
  track: MediaStreamTrack;
  /**
   * Plays the captured audio out of this machine's speakers too, so the
   * person broadcasting can confirm what viewers are getting without needing
   * a second machine. 0 (silent) by default — see canMonitor.
   */
  setMonitorGain(value: number): void;
  /**
   * False when capturing the whole system rather than one process: monitoring
   * system audio through the speakers feeds straight back into the capture.
   */
  canMonitor: boolean;
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
  node.connect(destination);

  // Monitoring runs through its own gain node kept at zero, rather than
  // connecting and disconnecting the speaker path: toggling a gain value is
  // click-free, and the graph shape stays constant.
  const monitorGain = ctx.createGain();
  monitorGain.gain.value = 0;
  node.connect(monitorGain);
  monitorGain.connect(ctx.destination);

  // Capturing one process means our own playback is a *different* process,
  // so WASAPI never re-captures it. Capturing the whole system does include
  // our playback, which would loop.
  const canMonitor = processId !== null;

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
    canMonitor,
    setMonitorGain(value: number) {
      monitorGain.gain.value = canMonitor ? value : 0;
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
