/**
 * Plays everyone in voice, for someone in voice. Each voice arrives as its own
 * stream, and the mix is these elements playing together. Nobody's own voice
 * is ever among them.
 *
 * Deafen is not done here: it silences every sound Zoia plays, from main.
 */

import { useEffect, useRef } from 'react';
import type { RemoteTrack } from 'livekit-client';

export interface VoiceTrack {
  identity: string;
  track: RemoteTrack;
}

function Voice({ track }: { track: RemoteTrack }) {
  const ref = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.srcObject = new MediaStream([track.mediaStreamTrack]);
    return () => {
      element.srcObject = null;
    };
  }, [track]);

  return <audio ref={ref} autoPlay />;
}

export default function VoiceAudio({ tracks }: { tracks: readonly VoiceTrack[] }) {
  return (
    <>
      {tracks.map(({ identity, track }) => (
        <Voice key={track.sid ?? identity} track={track} />
      ))}
    </>
  );
}
