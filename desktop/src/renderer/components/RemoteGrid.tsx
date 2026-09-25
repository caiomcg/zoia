import { useEffect, useRef, useState } from 'react';
import type { RemoteScreen } from '../livekit/useRoom';

export interface LoadingBroadcast {
  identity: string;
  name: string;
}

function RemoteTile({
  screen,
  audioActive,
  volume,
  onActivateAudio,
  onVolumeChange,
}: {
  screen: RemoteScreen;
  audioActive: boolean;
  volume: number;
  onActivateAudio: () => void;
  onVolumeChange: (value: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    const tracks = [screen.videoTrack.mediaStreamTrack];
    if (screen.audioTrack) tracks.push(screen.audioTrack.mediaStreamTrack);
    element.srcObject = new MediaStream(tracks);
    return () => {
      element.srcObject = null;
    };
  }, [screen.videoTrack, screen.audioTrack]);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    element.muted = !audioActive;
    element.volume = audioActive ? volume : 0;
  }, [audioActive, volume]);

  return (
    <article className="remote-tile">
      <video ref={videoRef} playsInline autoPlay />
      <div className="remote-tile-footer">
        <span>{screen.participantName}</span>
        {screen.audioTrack && (
          <div className="remote-audio-controls">
            <span className={`remote-audio-label${audioActive ? ' active' : ''}`}>
              {audioActive ? 'Áudio ativo' : 'Áudio desligado'}
            </span>
            <button onClick={onActivateAudio}>
              {audioActive ? 'Silenciar áudio' : 'Ativar áudio'}
            </button>
            {audioActive && (
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={volume}
                onChange={(event) => onVolumeChange(Number(event.target.value))}
                className="remote-volume"
                aria-label={`Volume de ${screen.participantName}`}
              />
            )}
          </div>
        )}
      </div>
    </article>
  );
}

export default function RemoteGrid({
  screens,
  loadingBroadcasts = [],
}: {
  screens: RemoteScreen[];
  loadingBroadcasts?: LoadingBroadcast[];
}) {
  const [audioOwner, setAudioOwner] = useState<string | null>(null);
  const [volumes, setVolumes] = useState<Record<string, number>>({});

  useEffect(() => {
    const withAudio = screens.find((screen) => screen.audioTrack);
    setAudioOwner((current) => {
      if (current && screens.some((screen) => screen.participantIdentity === current)) {
        return current;
      }
      return withAudio?.participantIdentity ?? null;
    });
  }, [screens]);

  if (screens.length === 0) {
    return (
      <section className="stage remote-empty">
        <div className="overlay">
          {loadingBroadcasts.length > 0 ? (
            <>
              <h2>Carregando transmissão…</h2>
              <p className="muted">
                {loadingBroadcasts.map((broadcast) => broadcast.name).join(', ')}{' '}
                {loadingBroadcasts.length === 1 ? 'está' : 'estão'} transmitindo, mas ainda
                {loadingBroadcasts.length === 1 ? ' está' : ' estão'} carregando.
              </p>
            </>
          ) : (
            <>
              <h2>Select a broadcast</h2>
              <p className="muted">Choose one or more live broadcasts from the room list.</p>
            </>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className={`remote-grid count-${Math.min(screens.length, 4)}`}>
      {screens.map((screen) => (
        <RemoteTile
          key={screen.participantIdentity}
          screen={screen}
          audioActive={audioOwner === screen.participantIdentity}
          volume={volumes[screen.participantIdentity] ?? 1}
          onActivateAudio={() =>
            setAudioOwner((current) =>
              current === screen.participantIdentity ? null : screen.participantIdentity,
            )
          }
          onVolumeChange={(value) =>
            setVolumes((current) => ({
              ...current,
              [screen.participantIdentity]: value,
            }))
          }
        />
      ))}
    </section>
  );
}
