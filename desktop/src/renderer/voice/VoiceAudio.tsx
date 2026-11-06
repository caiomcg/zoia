/**
 * Plays everyone in voice, for someone in voice. Each voice arrives as its own
 * stream, and the mix is these voices playing together. Nobody's own voice is
 * ever among them.
 *
 * Each goes through a gain of its own, so a voice can be turned up past what
 * an audio element allows; the volume is yours alone (volumes.ts). The muted
 * element stays: Chromium only pulls a remote stream that something plays.
 *
 * Deafen is not done here: it silences every sound Zoia plays, from main.
 */

import { useEffect, useRef } from 'react';
import type { RemoteTrack } from 'livekit-client';
import { useVoiceVolume } from './volumes';
import { watchSpeaking } from './speaking';
import { registerAudioSink } from './audioSink';
import { useDucked } from './duck';

// How fast voices fade under you while you hear yourself, and come back.
const DUCK_DOWN_S = 0.03;
const DUCK_UP_S = 0.15;

export interface VoiceTrack {
  identity: string;
  track: RemoteTrack;
}

let sharedContext: AudioContext | null = null;

/** One context for every voice: they are mixed in it. */
function voiceContext(): AudioContext {
  if (!sharedContext) {
    sharedContext = new AudioContext();
    registerAudioSink(sharedContext);
  }
  if (sharedContext.state === 'suspended') void sharedContext.resume().catch(() => {});
  return sharedContext;
}

function Voice({ identity, track }: VoiceTrack) {
  const ref = useRef<HTMLAudioElement>(null);
  const gainRef = useRef<GainNode | null>(null);
  const volume = useVoiceVolume(identity);
  const ducked = useDucked();

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const stream = new MediaStream([track.mediaStreamTrack]);
    element.srcObject = stream;
    const context = voiceContext();
    const source = context.createMediaStreamSource(stream);
    const gain = context.createGain();
    gain.gain.value = volume;
    source.connect(gain).connect(context.destination);
    gainRef.current = gain;
    // The ring follows what arrives, before your volume: someone you turned
    // down is still speaking.
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const stopSpeaking = watchSpeaking(identity, () => {
      analyser.getFloatTimeDomainData(samples);
      let peak = 0;
      for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
      return peak;
    });
    return () => {
      stopSpeaking();
      analyser.disconnect();
      source.disconnect();
      gain.disconnect();
      gainRef.current = null;
      element.srcObject = null;
    };
    // The volume is applied below, without rebuilding the graph.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track]);

  useEffect(() => {
    const gain = gainRef.current;
    if (!gain) return;
    gain.gain.setTargetAtTime(
      ducked ? 0 : volume,
      gain.context.currentTime,
      ducked ? DUCK_DOWN_S : DUCK_UP_S,
    );
  }, [volume, ducked]);

  return <audio ref={ref} autoPlay muted />;
}

export default function VoiceAudio({ tracks }: { tracks: readonly VoiceTrack[] }) {
  return (
    <>
      {tracks.map(({ identity, track }) => (
        <Voice key={track.sid ?? identity} identity={identity} track={track} />
      ))}
    </>
  );
}
