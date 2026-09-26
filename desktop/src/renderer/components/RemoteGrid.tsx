import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { LocalVideoTrack, RemoteTrack } from 'livekit-client';
import type { RemoteQualityMode, RemoteScreen } from '../livekit/useRoom';
import Avatar from './Avatar';
import { IconFullscreen, IconVolume } from './Player';

/**
 * One broadcast in the spotlight, every other one as a small thumbnail along
 * the bottom. A broadcast that starts later joins the strip rather than taking
 * over the picture; clicking a thumbnail is what moves it up.
 *
 * The strip floats over the bottom of the picture, clear of the player's
 * controls, and can be tucked away. Only the spotlight plays audio and asks for
 * full quality. Thumbnails are muted and, through setRemoteFocus, request the
 * low simulcast layer.
 */

const STRIP_HIDDEN_KEY = 'zoia.thumbnailsHidden';

function readStripHidden(): boolean {
  try {
    return localStorage.getItem(STRIP_HIDDEN_KEY) === 'true';
  } catch {
    return false;
  }
}

function IconChevron({ up }: { up: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={up ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} />
    </svg>
  );
}

/** Stands in for "your own broadcast" wherever a spotlight identity goes. */
export const LOCAL_SPOTLIGHT = '__local__';

export interface LoadingBroadcast {
  identity: string;
  name: string;
}

function sourceText(sourceName: string | null, sourceKind: RemoteScreen['sourceKind']): string {
  if (sourceName) return sourceName;
  if (sourceKind === 'camera') return 'Câmera';
  if (sourceKind === 'window') return 'Janela';
  return 'Tela';
}

function useMediaStream(
  ref: RefObject<HTMLVideoElement | null>,
  video: RemoteTrack | LocalVideoTrack | null,
  audio: RemoteTrack | null,
) {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const tracks = video ? [video.mediaStreamTrack] : [];
    if (audio) tracks.push(audio.mediaStreamTrack);
    element.srcObject = tracks.length > 0 ? new MediaStream(tracks) : null;
    return () => {
      element.srcObject = null;
    };
  }, [ref, video, audio]);
}

function SpotlightTile({
  screen,
  qualityMode,
  onQualityModeChange,
  isFullscreen,
  onToggleFullscreen,
}: {
  screen: RemoteScreen;
  qualityMode: RemoteQualityMode;
  onQualityModeChange?: (mode: RemoteQualityMode) => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  useMediaStream(videoRef, screen.videoTrack, screen.audioTrack);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    element.muted = muted;
    element.volume = volume;
  }, [muted, volume]);

  return (
    <article className="remote-tile">
      <video ref={videoRef} playsInline autoPlay onDoubleClick={onToggleFullscreen} />
      <div className="remote-tile-footer">
        <span className="remote-tile-who">
          <Avatar name={screen.participantName} live />
          <span>
            {screen.participantName}
            <small className="stream-source">
              {sourceText(screen.sourceName, screen.sourceKind)}
            </small>
          </span>
        </span>
        <div className="remote-audio-controls">
          {screen.audioTrack && (
            <>
              {/* Muting only drops the slider to zero; unmuting restores the
                  level it had, or full volume if it was already at zero. */}
              <button
                className="icon-button"
                onClick={() => {
                  if (muted && volume === 0) setVolume(1);
                  setMuted((current) => !current);
                }}
                title={muted ? 'Ativar áudio' : 'Silenciar'}
                aria-label={muted ? 'Ativar áudio' : 'Silenciar'}
              >
                <IconVolume muted={muted || volume === 0} />
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={muted ? 0 : volume}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  setVolume(value);
                  setMuted(value === 0);
                }}
                className="remote-volume"
                aria-label={`Volume de ${screen.participantName}`}
              />
            </>
          )}
          {/* A hardware (WHIP) broadcast has one layer; offering a choice that
              changes nothing would be a lie. */}
          {screen.simulcast && (
            <select
              value={qualityMode}
              onChange={(event) => onQualityModeChange?.(event.target.value as RemoteQualityMode)}
              aria-label="Qualidade"
            >
              <option value="auto">Qualidade automática</option>
              <option value="low">Qualidade baixa</option>
            </select>
          )}
          <button
            className="icon-button"
            onClick={onToggleFullscreen}
            title={isFullscreen ? 'Sair da tela cheia' : 'Tela cheia'}
            aria-label={isFullscreen ? 'Sair da tela cheia' : 'Tela cheia'}
          >
            <IconFullscreen active={isFullscreen} />
          </button>
        </div>
      </div>
    </article>
  );
}

function Thumbnail({
  name,
  label,
  video,
  onSelect,
}: {
  name: string;
  label: string;
  video: RemoteTrack | LocalVideoTrack | null;
  onSelect?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useMediaStream(videoRef, video, null);

  return (
    <button className="thumb" onClick={onSelect} disabled={!onSelect} title={`${name} — ${label}`}>
      <video ref={videoRef} playsInline autoPlay muted />
      <span className="thumb-label">
        <Avatar name={name} live />
        <span>{label}</span>
      </span>
    </button>
  );
}

export default function RemoteGrid({
  screens,
  spotlight,
  onSpotlight,
  local,
  loadingBroadcasts = [],
  showOnboarding = false,
  onStartSharing,
  onDismissOnboarding,
  qualityMode = 'auto',
  onQualityModeChange,
}: {
  screens: RemoteScreen[];
  /** A remote identity, LOCAL_SPOTLIGHT, or null when there is nothing to show. */
  spotlight: string | null;
  onSpotlight: (identity: string) => void;
  /** Present while this device is broadcasting. */
  local?: { stage: ReactNode; track: LocalVideoTrack | null; name: string };
  loadingBroadcasts?: LoadingBroadcast[];
  showOnboarding?: boolean;
  onStartSharing?: () => void;
  onDismissOnboarding?: () => void;
  qualityMode?: RemoteQualityMode;
  onQualityModeChange?: (mode: RemoteQualityMode) => void;
}) {
  const [stripHidden, setStripHidden] = useState(readStripHidden);
  // Fullscreen takes the whole spotlight, not just the video, so the
  // thumbnails and the tile's controls come along.
  const spotlightRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const handler = () =>
      setIsFullscreen(
        document.fullscreenElement === spotlightRef.current && Boolean(spotlightRef.current),
      );
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await spotlightRef.current?.requestFullscreen();
    } catch {
      // Refused (no user gesture, or policy); the layout simply stays put.
    }
  }

  function toggleStrip() {
    setStripHidden((current) => {
      try {
        localStorage.setItem(STRIP_HIDDEN_KEY, String(!current));
      } catch {
        // Remembering the choice is a convenience; the toggle still works.
      }
      return !current;
    });
  }

  if (screens.length === 0 && !local) {
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
          ) : showOnboarding ? (
            <div className="onboarding-card">
              <p className="onboarding-step">Você entrou na sala</p>
              <h2>Pronto para começar</h2>
              <p className="muted">
                Assista a uma transmissão ao vivo pela lista ao lado ou compartilhe sua tela.
              </p>
              <ol className="onboarding-list">
                <li>
                  Clique em <strong>Compartilhar</strong>.
                </li>
                <li>Escolha uma janela ou tela.</li>
              </ol>
              <div className="onboarding-actions">
                <button className="primary" onClick={onStartSharing}>
                  Compartilhar tela
                </button>
                <button className="link" onClick={onDismissOnboarding}>
                  Agora não
                </button>
              </div>
            </div>
          ) : (
            <>
              <h2>Ninguém está transmitindo</h2>
              <p className="muted">Quando alguém compartilhar, a transmissão aparece aqui.</p>
            </>
          )}
        </div>
      </section>
    );
  }

  const main = screens.find((screen) => screen.participantIdentity === spotlight);
  const others = screens.filter((screen) => screen !== main);
  const showLocalThumb = Boolean(local) && Boolean(main);
  const hasStrip = others.length > 0 || showLocalThumb || loadingBroadcasts.length > 0;

  const stripCount = others.length + (showLocalThumb ? 1 : 0) + loadingBroadcasts.length;

  return (
    <section className="broadcast-layout">
      <div className="spotlight" ref={spotlightRef}>
        {main ? (
          <SpotlightTile
            key={main.participantIdentity}
            screen={main}
            qualityMode={qualityMode}
            onQualityModeChange={onQualityModeChange}
            isFullscreen={isFullscreen}
            onToggleFullscreen={() => void toggleFullscreen()}
          />
        ) : (
          local?.stage
        )}

        {hasStrip && (
          <div className={`thumb-overlay${stripHidden ? ' collapsed' : ''}`}>
            <button
              className="thumb-toggle"
              onClick={toggleStrip}
              aria-expanded={!stripHidden}
              title={stripHidden ? 'Mostrar transmissões' : 'Ocultar transmissões'}
            >
              <IconChevron up={stripHidden} />
              {stripHidden ? `${stripCount}` : null}
            </button>
            {!stripHidden && (
              <div className="thumb-strip">
                {showLocalThumb && local && (
                  <Thumbnail
                    name={local.name}
                    label="Sua transmissão"
                    video={local.track}
                    onSelect={() => onSpotlight(LOCAL_SPOTLIGHT)}
                  />
                )}
                {others.map((screen) => (
                  <Thumbnail
                    key={screen.participantIdentity}
                    name={screen.participantName}
                    label={sourceText(screen.sourceName, screen.sourceKind)}
                    video={screen.videoTrack}
                    onSelect={() => onSpotlight(screen.participantIdentity)}
                  />
                ))}
                {loadingBroadcasts.map((broadcast) => (
                  <Thumbnail
                    key={broadcast.identity}
                    name={broadcast.name}
                    label="Carregando…"
                    video={null}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
