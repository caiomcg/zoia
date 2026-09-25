import { useEffect, useRef, useState } from 'react';
import type { RemoteScreen } from '../livekit/useRoom';

function RemoteTile({ screen }: { screen: RemoteScreen }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    const tracks = [screen.videoTrack.mediaStreamTrack];
    if (screen.audioTrack) tracks.push(screen.audioTrack.mediaStreamTrack);
    element.srcObject = new MediaStream(tracks);
    element.muted = muted;
    return () => {
      element.srcObject = null;
    };
  }, [screen.videoTrack, screen.audioTrack, muted]);

  return (
    <article className="remote-tile">
      <video ref={videoRef} playsInline autoPlay />
      <div className="remote-tile-footer">
        <span>{screen.participantName}</span>
        {screen.audioTrack && (
          <button onClick={() => setMuted((value) => !value)}>{muted ? 'Unmute' : 'Mute'}</button>
        )}
      </div>
    </article>
  );
}

export default function RemoteGrid({ screens }: { screens: RemoteScreen[] }) {
  if (screens.length === 0) {
    return (
      <section className="stage remote-empty">
        <div className="overlay">
          <h2>Select a broadcast</h2>
          <p className="muted">Choose one or more live broadcasts from the room list.</p>
        </div>
      </section>
    );
  }

  return (
    <section className={`remote-grid count-${Math.min(screens.length, 4)}`}>
      {screens.map((screen) => (
        <RemoteTile key={screen.participantIdentity} screen={screen} />
      ))}
    </section>
  );
}
