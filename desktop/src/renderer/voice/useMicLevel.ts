/**
 * How loud the microphone is, 0 to 1, after everything voice does to it but
 * the gate: the same device, echo cancellation, gain control and noise
 * suppression (pipeline.ts). So the meter in Settings › Voice shows what the
 * channel would hear, and where the gate would cut.
 *
 * It opens a capture of its own while mounted. Chromium shares the device
 * with voice's, so the two do not fight.
 */

import { useEffect, useState } from 'react';
import { captureOptions, type CaptureSettings } from './settings';
import { buildVoiceGraph, peakOf, VOICE_SAMPLE_RATE, type VoiceGraph } from './pipeline';

/** How much of the level falls away per frame, so the meter settles rather than flickers. */
const DECAY = 0.92;

export function useMicLevel(settings: CaptureSettings): { level: number; error: string | null } {
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const { microphoneId, echoCancellation, noiseSuppression, autoGainControl } = settings;

  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let graph: VoiceGraph | null = null;
    let raf = 0;

    void (async () => {
      try {
        const options = captureOptions({
          microphoneId,
          echoCancellation,
          noiseSuppression,
          autoGainControl,
        });
        stream = await navigator.mediaDevices.getUserMedia({
          audio: options as MediaTrackConstraints,
        });
        const [input] = stream.getAudioTracks();
        if (cancelled || !input) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        context = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE });
        graph = await buildVoiceGraph(context, input, { gate: false });
        if (cancelled) return;
        setError(null);
        const { analyser } = graph;
        const samples = new Float32Array(analyser.fftSize);

        let shown = 0;
        const tick = () => {
          shown = Math.max(peakOf(analyser, samples), shown * DECAY);
          setLevel(shown);
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      graph?.destroy();
      stream?.getTracks().forEach((t) => t.stop());
      void context?.close().catch(() => {});
      setLevel(0);
    };
  }, [microphoneId, echoCancellation, noiseSuppression, autoGainControl]);

  return { level, error };
}
