/**
 * How loud the microphone is, 0 to 1, after everything voice does to it but
 * the gate: the same device, echo cancellation, gain control, noise
 * suppression and input volume (pipeline.ts). So the meter in Settings › Voice shows what the
 * channel would hear, and where the gate would cut.
 *
 * With `monitor`, it also plays what the gate lets through on the chosen
 * output (audioSink.ts): Hear yourself, the channel's sound without the
 * channel. It only ever plays here; nothing of it is published.
 *
 * It opens a capture of its own while mounted. Chromium shares the device
 * with voice's, so the two do not fight.
 */

import { useEffect, useRef, useState } from 'react';
import {
  availableDeviceId,
  captureOptions,
  levelToDb,
  NoiseFloor,
  type CaptureSettings,
} from './settings';
import { buildVoiceGraph, peakOf, VOICE_SAMPLE_RATE, type VoiceGraph } from './pipeline';
import { registerAudioSink } from './audioSink';
import { setDucked } from './duck';

/** How much of the level falls away per frame, so the meter settles rather than flickers. */
const DECAY = 0.92;

export interface MicLevel {
  /** 0 to 1, after suppression. */
  level: number;
  /** Where automatic sensitivity would cut, in dBFS, from the same sound. */
  autoThreshold: number;
  error: string | null;
}

export function useMicLevel(settings: CaptureSettings, monitor = false): MicLevel {
  const [level, setLevel] = useState(0);
  const [autoThreshold, setAutoThreshold] = useState(new NoiseFloor().threshold);
  const [error, setError] = useState<string | null>(null);
  const { microphoneId, echoCancellation, noiseSuppression, autoGainControl } = settings;
  // Read when a graph is built, so a rebuild (new device, new suppression)
  // keeps playing if Hear yourself is on.
  const monitorRef = useRef(monitor);
  // Connects or disconnects the current graph's sound to the speakers.
  const setPlayingRef = useRef<((on: boolean) => void) | null>(null);

  useEffect(() => {
    monitorRef.current = monitor;
    setPlayingRef.current?.(monitor);
  }, [monitor]);

  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let graph: VoiceGraph | null = null;
    let unregisterSink: (() => void) | null = null;
    let playing = false;
    // One channel on both ears: down to mono as it is sent, then spread.
    let toSpeakers: GainNode | null = null;
    // Everyone else is held down for as long as you listen to yourself.
    const duck = () => setDucked(playing);
    let raf = 0;

    const setPlaying = (on: boolean) => {
      if (!graph || !context || on === playing) return;
      playing = on;
      if (!toSpeakers) {
        toSpeakers = context.createGain();
        toSpeakers.channelCount = 1;
        toSpeakers.channelCountMode = 'explicit';
        toSpeakers.channelInterpretation = 'speakers';
        toSpeakers.connect(context.destination);
      }
      if (on) graph.gated.connect(toSpeakers);
      else graph.gated.disconnect(toSpeakers);
      duck();
    };

    void (async () => {
      try {
        // An unplugged choice is measured on the default, as voice uses it.
        const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
        const options = captureOptions({
          microphoneId: availableDeviceId(microphoneId, devices, 'audioinput'),
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
        // 48 kHz, as voice's: RNNoise is wrong at any other rate. On the
        // chosen output from the start, so turning Hear yourself on only
        // connects a node, and the context follows that choice and its fallback.
        context = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE });
        unregisterSink = registerAudioSink(context);
        // Gated, so Hear yourself plays what the sensitivity or push to talk
        // lets through. The meter reads before the gate either way.
        graph = await buildVoiceGraph(context, input, { gate: true });
        // Built after the cleanup ran, so it is this one's to undo: the gate's
        // timer would otherwise tick on with nothing to show.
        if (cancelled) {
          graph.destroy();
          return;
        }
        setError(null);
        setPlayingRef.current = setPlaying;
        setPlaying(monitorRef.current);
        const { analyser } = graph;
        const samples = new Float32Array(analyser.fftSize);

        let shown = 0;
        const floor = new NoiseFloor();
        const tick = () => {
          const peak = peakOf(analyser, samples);
          shown = Math.max(peak, shown * DECAY);
          setLevel(shown);
          setAutoThreshold(Math.round(floor.update(levelToDb(peak), performance.now())));
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
      if (setPlayingRef.current === setPlaying) setPlayingRef.current = null;
      setPlaying(false);
      setDucked(false);
      toSpeakers?.disconnect();
      graph?.destroy();
      unregisterSink?.();
      stream?.getTracks().forEach((t) => t.stop());
      void context?.close().catch(() => {});
      setLevel(0);
    };
  }, [microphoneId, echoCancellation, noiseSuppression, autoGainControl]);

  return { level, autoThreshold, error };
}
