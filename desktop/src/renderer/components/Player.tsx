import { useEffect, useRef, useState } from 'react';
import type { LocalVideoTrack } from 'livekit-client';
import type { SendAudio } from '../livekit/useRoom';
import Avatar from './Avatar';

/**
 * Renders this device's own capture while it is broadcasting. Remote
 * broadcasts are rendered by RemoteGrid so viewers can watch several at once;
 * this one wears the same footer, with the controls a sharer needs instead.
 *
 * Its audio controls act on what viewers hear, not on this machine's
 * speakers: your own capture is never played back here.
 */

export function IconVolume({ muted }: { muted: boolean }) {
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

export function IconHeadphones() {
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

export function IconFullscreen({ active }: { active: boolean }) {
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

export default function Player({
  name,
  localTrack,
  gpuBroadcasting = false,
  sendAudio,
  onStop,
  onSwitch,
  fullscreen,
}: {
  name: string;
  localTrack: LocalVideoTrack | null;
  /**
   * On the NVENC path the frames never enter this process — ffmpeg publishes
   * them directly — so there is no local track to preview.
   */
  gpuBroadcasting?: boolean;
  /** Present while this device is sending audio. */
  sendAudio?: {
    value: SendAudio;
    /** False for a camera's microphone, which can only be muted. */
    canSetVolume: boolean;
    onChange: (next: SendAudio) => void;
  };
  onStop: () => void;
  onSwitch: () => void;
  /**
   * The layout owns fullscreen, so the other broadcasts' thumbnails can come
   * along. Without it, the player goes fullscreen on its own.
   */
  fullscreen?: { active: boolean; toggle: () => void };
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return undefined;
    el.srcObject = localTrack ? new MediaStream([localTrack.mediaStreamTrack]) : null;
    return () => {
      el.srcObject = null;
    };
  }, [localTrack]);

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

  const fullscreenActive = fullscreen?.active ?? isFullscreen;
  const audio = sendAudio?.value;
  const silent = Boolean(audio && (audio.muted || audio.volume === 0));

  return (
    <section className="stage" ref={stageRef}>
      <video ref={videoRef} playsInline autoPlay muted />

      {!localTrack && gpuBroadcasting && (
        <div className="overlay">
          <h2>Sharing your screen</h2>
          <p className="muted">
            Encoded on the GPU and sent straight to the server, so there is no local preview.
            Viewers see it as normal.
          </p>
        </div>
      )}

      <div className="remote-tile-footer">
        <span className="remote-tile-who">
          <Avatar name={name} live />
          <span>
            {name}
            <small className="stream-source">
              {!sendAudio ? 'Sharing without audio' : silent ? 'Viewers hear nothing' : 'Sharing'}
            </small>
          </span>
        </span>
        <div className="remote-audio-controls">
          {sendAudio && audio && (
            <>
              {/* Same behaviour as a watched tile: muting keeps the level, and
                  unmuting restores it, or full volume if it was at zero. */}
              <button
                className="icon-button"
                onClick={() =>
                  sendAudio.onChange({
                    volume: audio.muted && audio.volume === 0 ? 1 : audio.volume,
                    muted: !audio.muted,
                  })
                }
                title={audio.muted ? 'Send your audio again' : 'Mute your audio for viewers'}
                aria-label={audio.muted ? 'Unmute your audio' : 'Mute your audio'}
              >
                <IconVolume muted={silent} />
              </button>
              {sendAudio.canSetVolume && (
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={audio.muted ? 0 : audio.volume}
                  onChange={(e) => {
                    const volume = Number(e.target.value);
                    sendAudio.onChange({ volume, muted: volume === 0 });
                  }}
                  className="remote-volume"
                  aria-label="How loud viewers hear your audio"
                />
              )}
            </>
          )}
          <button
            className="icon-button"
            onClick={onSwitch}
            title="Share something else without stopping"
            aria-label="Switch what you are sharing"
          >
            <IconSwitch />
          </button>
          <button
            className="icon-button stop"
            onClick={onStop}
            title="Stop sharing"
            aria-label="Stop sharing"
          >
            <IconStop />
          </button>
          <button
            className="icon-button"
            onClick={() => (fullscreen ? fullscreen.toggle() : void toggleFullscreen())}
            title={fullscreenActive ? 'Exit fullscreen' : 'Fullscreen'}
            aria-label={fullscreenActive ? 'Exit fullscreen' : 'Fullscreen'}
          >
            <IconFullscreen active={fullscreenActive} />
          </button>
        </div>
      </div>
    </section>
  );
}

export function IconEye() {
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
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function IconSwitch() {
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
      <path d="M4 8h14l-3-3M20 16H6l3 3" />
    </svg>
  );
}

function IconStop() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
    </svg>
  );
}
