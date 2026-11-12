import { useEffect, useState } from 'react';
import { TrackEvent, type LocalVideoTrack, type RemoteTrack } from 'livekit-client';

/**
 * The track to draw for a video: for your own camera with a background effect
 * (ADR 0053), the processed one, which is what viewers get; otherwise the
 * track itself. `mediaStreamTrack` is always the raw camera, so drawing it
 * would show you without the effect everyone else sees.
 */
export function useShownTrack(
  video: RemoteTrack | LocalVideoTrack | null,
): MediaStreamTrack | null {
  const [processed, setProcessed] = useState<MediaStreamTrack | undefined>(undefined);

  useEffect(() => {
    if (!video || !('getProcessor' in video)) {
      setProcessed(undefined);
      return undefined;
    }
    const update = () => setProcessed(video.getProcessor()?.processedTrack);
    update();
    video.on(TrackEvent.TrackProcessorUpdate, update);
    return () => {
      video.off(TrackEvent.TrackProcessorUpdate, update);
    };
  }, [video]);

  return video ? (processed ?? video.mediaStreamTrack) : null;
}
