import { useEffect, useRef } from 'react';
import type { LocalVideoTrack } from 'livekit-client';
import type { RemoteScreen } from '../livekit/useRoom';

/**
 * Renders whichever video track is relevant right now: this device's own
 * capture while it's broadcasting, otherwise whoever else is. Never both —
 * only one stage-holder can publish at a time, and this mirrors that.
 */
export default function Player({
  remoteScreen,
  localTrack,
}: {
  remoteScreen: RemoteScreen | null;
  localTrack: LocalVideoTrack | null;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const track = localTrack ?? remoteScreen?.videoTrack ?? null;

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !track) return undefined;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);

  return (
    <section className="stage">
      {/* Muted for now: this step is video only, audio arrives in a later step. */}
      <video ref={videoRef} playsInline autoPlay muted />
      {!track && (
        <div className="overlay">
          <h2>Nobody is broadcasting</h2>
          <p className="muted">Waiting for someone to share their screen.</p>
        </div>
      )}
      {localTrack && <div className="self-preview-badge">You are sharing this screen</div>}
    </section>
  );
}
