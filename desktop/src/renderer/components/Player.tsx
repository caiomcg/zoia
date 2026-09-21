import { useEffect, useRef } from 'react';
import type { RemoteScreen } from '../livekit/useRoom';

export default function Player({ remoteScreen }: { remoteScreen: RemoteScreen | null }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (remoteScreen) {
      remoteScreen.videoTrack.attach(el);
      return () => {
        remoteScreen.videoTrack.detach(el);
      };
    }
    return undefined;
  }, [remoteScreen]);

  return (
    <section className="stage">
      {/* Muted for now: this step is video only, audio arrives in a later step. */}
      <video ref={videoRef} playsInline autoPlay muted />
      {!remoteScreen && (
        <div className="overlay">
          <h2>Nobody is broadcasting</h2>
          <p className="muted">Waiting for someone to share their screen.</p>
        </div>
      )}
    </section>
  );
}
