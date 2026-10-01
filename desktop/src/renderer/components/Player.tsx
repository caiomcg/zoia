import { useEffect, useRef, useState } from 'react';
import type { LocalVideoTrack } from 'livekit-client';
import type { SendAudio } from '../livekit/useRoom';
import Avatar from './Avatar';
import { useT } from '../i18n';

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
  identity,
  showPreview,
  onTogglePreview,
  localTrack,
  gpuBroadcasting = false,
  sendAudio,
  onStop,
  onSwitch,
  onClose,
  fullscreen,
}: {
  name: string;
  /** Yours, for your profile picture on the tile. */
  identity?: string;
  /**
   * Whether you see your own picture. Off by default: you know what you are
   * sharing, and decoding it back costs your machine for nothing.
   */
  showPreview: boolean;
  onTogglePreview: () => void;
  localTrack: LocalVideoTrack | null;
  /**
   * Set when broadcasting via the WHIP / ffmpeg route (e.g. AMD AMF or Intel Quick Sync).
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
  /** Leave the large view. Sits to the right of fullscreen, as on a watched tile. */
  onClose?: () => void;
  /**
   * The layout owns fullscreen, so the other broadcasts' thumbnails can come
   * along. Without it, the player goes fullscreen on its own.
   */
  fullscreen?: { active: boolean; toggle: () => void };
}) {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return undefined;
    el.srcObject =
      localTrack && showPreview ? new MediaStream([localTrack.mediaStreamTrack]) : null;
    return () => {
      el.srcObject = null;
    };
  }, [localTrack, showPreview]);

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

      {!showPreview ? (
        <div className="overlay">
          <h2>{t('player.youreLive')}</h2>
          <p className="muted">{t('player.previewHidden')}</p>
        </div>
      ) : !localTrack && gpuBroadcasting ? (
        <div className="overlay">
          <h2>{t('player.youreLive')}</h2>
          <p className="muted">{t('top.starting')}</p>
        </div>
      ) : null}

      <div className="remote-tile-footer">
        <span className="remote-tile-who">
          <Avatar name={name} identity={identity} live />
          <span className="remote-tile-label">
            <span className="remote-tile-name">{name}</span>
            <small className="stream-source">
              {!sendAudio
                ? t('player.withoutAudio')
                : silent
                  ? t('player.viewersHearNothing')
                  : t('player.sharing')}
            </small>
          </span>
        </span>
        <div className="remote-audio-controls">
          {(localTrack || gpuBroadcasting) && (
            <button
              className={`icon-button${showPreview ? ' active' : ''}`}
              onClick={onTogglePreview}
              aria-pressed={showPreview}
              title={showPreview ? t('player.hidePreview') : t('player.showPreview')}
              aria-label={showPreview ? t('player.hidePreview') : t('player.showPreview')}
            >
              <IconEye off={!showPreview} />
            </button>
          )}
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
                title={audio.muted ? t('player.sendAudioAgain') : t('player.muteForViewers')}
                aria-label={audio.muted ? t('player.unmuteAudio') : t('player.muteAudio')}
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
                  aria-label={t('player.sendVolume')}
                />
              )}
            </>
          )}
          <button
            className="icon-button"
            onClick={onSwitch}
            title={t('player.switchTitle')}
            aria-label={t('player.switch')}
          >
            <IconSwitch />
          </button>
          <button
            className="icon-button stop"
            onClick={onStop}
            title={t('common.stopSharing')}
            aria-label={t('common.stopSharing')}
          >
            <IconStop />
          </button>
          <button
            className="icon-button"
            onClick={() => (fullscreen ? fullscreen.toggle() : void toggleFullscreen())}
            title={fullscreenActive ? t('common.exitFullscreen') : t('common.fullscreen')}
            aria-label={fullscreenActive ? t('common.exitFullscreen') : t('common.fullscreen')}
          >
            <IconFullscreen active={fullscreenActive} />
          </button>
          {onClose && !fullscreenActive && (
            <button
              className="icon-button"
              onClick={onClose}
              title={t('grid.removeFromView')}
              aria-label={t('grid.removeFromView')}
            >
              <IconClose />
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

export function IconEye({ off = false }: { off?: boolean }) {
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
      {off && <path d="M3 3l18 18" />}
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

function IconClose() {
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
      <path d="M6 6l12 12M18 6L6 18" />
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
