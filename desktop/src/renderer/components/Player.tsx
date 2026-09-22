import { useEffect, useRef, useState } from 'react';
import type { LocalVideoTrack } from 'livekit-client';
import type { RemoteScreen } from '../livekit/useRoom';

/**
 * Renders whichever video track is relevant right now: this device's own
 * capture while it's broadcasting, otherwise whoever else is. Never both —
 * only one stage-holder can publish at a time, and this mirrors that.
 *
 * Video and audio are combined into one MediaStream and assigned to the
 * element's srcObject directly, rather than calling LiveKit's track.attach()
 * for each: attach() replaces the element's srcObject per call, so a second
 * call silently drops whichever track attached first — audio in practice,
 * since video is attached before it.
 */

function IconVolume({ muted }: { muted: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        d="M4 9v6h4l5 4V5L8 9H4z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      {muted ? (
        <path
          d="M16 9l5 6m0-6l-5 6"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          fill="none"
        />
      ) : (
        <path
          d="M16.5 8.5a5 5 0 010 7M19 6a8.5 8.5 0 010 12"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          fill="none"
        />
      )}
    </svg>
  );
}

function IconHeadphones() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none">
      <path
        d="M4 14v-2a8 8 0 0116 0v2"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <rect x="2.5" y="13.5" width="4.5" height="7" rx="2" fill="currentColor" />
      <rect x="17" y="13.5" width="4.5" height="7" rx="2" fill="currentColor" />
    </svg>
  );
}

function IconFullscreen({ active }: { active: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {active ? (
        <path d="M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6" />
      ) : (
        <path d="M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6" />
      )}
    </svg>
  );
}

/** Peak-reading meter. Segmented, because a smooth bar reads as decorative. */
function LevelMeter({ level }: { level: number }) {
  const segments = 12;
  const lit = Math.round(level * segments);
  return (
    <div className="level-meter" title={`Audio level: ${Math.round(level * 100)}%`}>
      {Array.from({ length: segments }, (_, i) => (
        <span
          key={i}
          className={`level-seg${i < lit ? ' on' : ''}${i >= segments - 2 ? ' hot' : ''}`}
        />
      ))}
    </div>
  );
}

export default function Player({
  remoteScreen,
  localTrack,
  audioLevel,
  canMonitor,
  setMonitorGain,
  gpuBroadcasting = false,
}: {
  remoteScreen: RemoteScreen | null;
  localTrack: LocalVideoTrack | null;
  audioLevel: number;
  canMonitor: boolean;
  setMonitorGain: (value: number) => void;
  /**
   * On the NVENC path the frames never enter this process — ffmpeg publishes
   * them directly — so there is no local track to preview.
   */
  gpuBroadcasting?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [monitoring, setMonitoring] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const isBroadcasting = Boolean(localTrack);
  const videoTrack = localTrack ?? remoteScreen?.videoTrack ?? null;
  const remoteAudio = isBroadcasting ? null : (remoteScreen?.audioTrack ?? null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return undefined;

    if (!videoTrack) {
      el.srcObject = null;
      return undefined;
    }

    const tracks = [videoTrack.mediaStreamTrack];
    if (remoteAudio) tracks.push(remoteAudio.mediaStreamTrack);
    el.srcObject = new MediaStream(tracks);

    return () => {
      el.srcObject = null;
    };
  }, [videoTrack, remoteAudio]);

  // Watching someone else: the slider is playback volume on the element.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.volume = volume;
    // The broadcaster's own capture is never played back through the element
    // — that path is the monitor below, which they opt into.
    el.muted = muted || isBroadcasting;
  }, [volume, muted, isBroadcasting]);

  // Broadcasting: the same slider drives the monitor tap instead.
  useEffect(() => {
    setMonitorGain(monitoring && !muted ? volume : 0);
  }, [monitoring, muted, volume, setMonitorGain]);

  useEffect(() => {
    const handler = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await stageRef.current?.requestFullscreen();
      }
    } catch {
      // Fullscreen can be refused (e.g. no user gesture in some contexts);
      // nothing useful to do beyond leaving the UI as it was.
    }
  }

  const hasAudio = isBroadcasting || Boolean(remoteAudio);

  return (
    <section className="stage" ref={stageRef}>
      <video ref={videoRef} playsInline autoPlay />

      {!videoTrack && gpuBroadcasting && (
        <div className="overlay">
          <h2>Sharing your screen</h2>
          <p className="muted">
            Encoded on the GPU and sent straight to the server, so there is no local preview.
            Viewers see it as normal.
          </p>
        </div>
      )}

      {!videoTrack && !gpuBroadcasting && (
        <div className="overlay">
          <h2>Nobody is broadcasting</h2>
          <p className="muted">Waiting for someone to share their screen.</p>
        </div>
      )}

      {(videoTrack || gpuBroadcasting) && (
        <div className="player-controls">
          {hasAudio && (
            <>
              <button
                className="icon-button"
                onClick={() => setMuted((m) => !m)}
                title={muted ? 'Unmute' : 'Mute'}
                aria-label={muted ? 'Unmute' : 'Mute'}
              >
                <IconVolume muted={muted || volume === 0} />
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={muted ? 0 : volume}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setVolume(v);
                  setMuted(v === 0);
                }}
                className="volume-slider"
                aria-label="Volume"
              />
            </>
          )}

          {(isBroadcasting || gpuBroadcasting) && (
            <>
              <LevelMeter level={audioLevel} />
              <button
                className={`icon-button${monitoring ? ' active' : ''}`}
                onClick={() => setMonitoring((m) => !m)}
                disabled={!canMonitor}
                title={
                  canMonitor
                    ? monitoring
                      ? 'Stop listening to what you are sharing'
                      : 'Listen to what you are sharing'
                    : 'Monitoring is unavailable when sharing whole-system audio (it would echo)'
                }
                aria-label="Monitor shared audio"
              >
                <IconHeadphones />
              </button>
              <span className="sharing-label">Sharing this window&rsquo;s audio</span>
            </>
          )}

          <span className="spacer" />

          <button
            className="icon-button"
            onClick={() => void toggleFullscreen()}
            title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            <IconFullscreen active={isFullscreen} />
          </button>
        </div>
      )}
    </section>
  );
}
