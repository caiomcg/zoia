import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { LocalVideoTrack, RemoteTrack } from 'livekit-client';
import type { RemoteQualityMode, RemoteScreen } from '../livekit/useRoom';
import Avatar from './Avatar';
import { IconFullscreen, IconVolume } from './Player';

/**
 * Every broadcast in the room, laid out one of two ways:
 *
 * - spotlight: one large, the rest as thumbnails;
 * - mosaic: all of them large. Two sit side by side with a draggable split;
 *   more form a grid.
 *
 * In the spotlight, what is shown large is pinned: a broadcast that starts
 * later joins the thumbnails, and clicking a thumbnail is what moves it up.
 *
 * Fullscreen shows one broadcast, with the others still in the thumbnail strip
 * over it; clicking one swaps it in. Leaving fullscreen lands back in whichever
 * layout was chosen. After a few still seconds the overlays and the cursor fade.
 *
 * The strip floats over the bottom of the picture, clear of the player's
 * controls, and can be tucked away. Large tiles ask for the high simulcast
 * layer, thumbnails for the low one (see setRemoteFocus).
 *
 * Volume and mute are kept per person, here rather than in the tile, so they
 * survive a tile moving between the strip and a large slot.
 */

/** Stands in for "your own broadcast" wherever a broadcast identity goes. */
export const LOCAL_SPOTLIGHT = '__local__';

export type LayoutMode = 'spotlight' | 'mosaic';

const LAYOUT_KEY = 'zoia.layout';
const STRIP_HIDDEN_KEY = 'zoia.thumbnailsHidden';
/** Past this many large tiles, each is small enough that the low layer does. */
const MOSAIC_HIGH_LIMIT = 4;
/** In fullscreen, overlays fade after this long without the mouse moving. */
const FULLSCREEN_IDLE_MS = 5000;
const SPLIT_KEY = 'zoia.pairSplit';
const SPLIT_MIN = 0.2;
const SPLIT_MAX = 0.8;

function readSplit(): number {
  try {
    const value = Number(localStorage.getItem(SPLIT_KEY));
    return value >= SPLIT_MIN && value <= SPLIT_MAX ? value : 0.5;
  } catch {
    return 0.5;
  }
}

/**
 * Fullscreen for the stage area, and whether the viewer has gone still in it.
 * After a few still seconds the controls and cursor get out of the way; any
 * movement brings them back.
 */
function useFullscreen(ref: RefObject<HTMLElement | null>) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [idle, setIdle] = useState(false);

  useEffect(() => {
    const handler = () =>
      setIsFullscreen(Boolean(ref.current) && document.fullscreenElement === ref.current);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, [ref]);

  useEffect(() => {
    const element = ref.current;
    if (!isFullscreen || !element) {
      setIdle(false);
      return;
    }
    let timer = setTimeout(() => setIdle(true), FULLSCREEN_IDLE_MS);
    const wake = () => {
      setIdle(false);
      clearTimeout(timer);
      timer = setTimeout(() => setIdle(true), FULLSCREEN_IDLE_MS);
    };
    const events = ['mousemove', 'mousedown', 'keydown'] as const;
    for (const name of events) element.addEventListener(name, wake);
    return () => {
      clearTimeout(timer);
      for (const name of events) element.removeEventListener(name, wake);
    };
  }, [isFullscreen, ref]);

  async function toggle() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await ref.current?.requestFullscreen();
    } catch {
      // Refused (no user gesture, or policy); the layout simply stays put.
    }
  }

  return { isFullscreen, idle, toggle };
}

function readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return allowed.find((option) => option === value) ?? fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Remembering is a convenience; the choice still applies this session.
  }
}

export interface LoadingBroadcast {
  identity: string;
  name: string;
}

interface AudioSetting {
  volume: number;
  muted: boolean;
}

function sourceText(sourceName: string | null, sourceKind: RemoteScreen['sourceKind']): string {
  if (sourceName) return sourceName;
  if (sourceKind === 'camera') return 'Câmera';
  if (sourceKind === 'window') return 'Janela';
  return 'Tela';
}

function Icon({ children }: { children: ReactNode }) {
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
      {children}
    </svg>
  );
}

const LAYOUTS: Array<{ mode: LayoutMode; label: string; icon: ReactNode }> = [
  {
    mode: 'spotlight',
    label: 'Destaque',
    icon: (
      <Icon>
        <rect x="3" y="4" width="18" height="11" rx="1.5" />
        <path d="M4 19h4M10 19h4M16 19h4" />
      </Icon>
    ),
  },
  {
    mode: 'mosaic',
    label: 'Mosaico',
    icon: (
      <Icon>
        <rect x="3" y="3" width="8" height="8" rx="1.5" />
        <rect x="13" y="3" width="8" height="8" rx="1.5" />
        <rect x="3" y="13" width="8" height="8" rx="1.5" />
        <rect x="13" y="13" width="8" height="8" rx="1.5" />
      </Icon>
    ),
  },
];

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

function RemoteTile({
  screen,
  audio,
  onAudioChange,
  qualityMode,
  onQualityModeChange,
  isFullscreen,
  onToggleFullscreen,
}: {
  screen: RemoteScreen;
  audio: AudioSetting;
  onAudioChange: (next: AudioSetting) => void;
  qualityMode: RemoteQualityMode;
  onQualityModeChange?: (mode: RemoteQualityMode) => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { volume, muted } = audio;
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
                onClick={() =>
                  onAudioChange({ volume: muted && volume === 0 ? 1 : volume, muted: !muted })
                }
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
                  onAudioChange({ volume: value, muted: value === 0 });
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
  local,
  onFocusChange,
  loadingBroadcasts = [],
  showOnboarding = false,
  onStartSharing,
  onDismissOnboarding,
  qualityMode = 'auto',
  onQualityModeChange,
}: {
  screens: RemoteScreen[];
  /** Present while this device is broadcasting. */
  local?: {
    renderStage: (fullscreen: { active: boolean; toggle: () => void }) => ReactNode;
    track: LocalVideoTrack | null;
    name: string;
  };
  /** Called with the remote broadcasts shown large, which get full quality. */
  onFocusChange: (identities: string[]) => void;
  loadingBroadcasts?: LoadingBroadcast[];
  showOnboarding?: boolean;
  onStartSharing?: () => void;
  onDismissOnboarding?: () => void;
  qualityMode?: RemoteQualityMode;
  onQualityModeChange?: (mode: RemoteQualityMode) => void;
}) {
  const [mode, setMode] = useState<LayoutMode>(() =>
    // 'pair' was a layout of its own; mosaic now does side by side.
    readStored(LAYOUT_KEY, ['spotlight', 'mosaic', 'pair'], 'spotlight') === 'spotlight'
      ? 'spotlight'
      : 'mosaic',
  );
  // Spotlight picks, most recently chosen first.
  const [pinned, setPinned] = useState<string[]>([]);
  const [audio, setAudio] = useState<Record<string, AudioSetting>>({});
  const [stripHidden, setStripHidden] = useState(
    () => readStored(STRIP_HIDDEN_KEY, ['true', 'false'], 'false') === 'true',
  );
  const [split, setSplit] = useState(readSplit);
  const mainsRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const areaRef = useRef<HTMLDivElement>(null);
  const fullscreen = useFullscreen(areaRef);
  // Which broadcast fills the screen while fullscreen; null otherwise.
  const [fullscreenId, setFullscreenId] = useState<string | null>(null);

  const hasLocal = Boolean(local);
  const candidates = [
    ...(hasLocal ? [LOCAL_SPOTLIGHT] : []),
    ...screens.map((screen) => screen.participantIdentity),
  ];
  const livePinned = pinned.filter((id) => candidates.includes(id));

  const spotlightId = livePinned[0] ?? candidates[0] ?? null;
  // The fullscreen broadcast ended: show whatever the layout would lead with.
  const fullId = fullscreen.isFullscreen
    ? fullscreenId && candidates.includes(fullscreenId)
      ? fullscreenId
      : spotlightId
    : null;

  let mains: string[];
  if (fullId) mains = [fullId];
  else if (mode === 'mosaic') mains = candidates;
  else mains = spotlightId ? [spotlightId] : [];
  const remoteMains = mains.filter((id) => id !== LOCAL_SPOTLIGHT);
  // The first large remote broadcast is heard by default; others start muted
  // until someone turns them up, and from then on keep what they were given.
  const primaryRemote = remoteMains[0] ?? null;

  // Pin the spotlight, so a newcomer sorting ahead of it cannot take its slot.
  useEffect(() => {
    if (!spotlightId) return;
    setPinned((current) =>
      current[0] === spotlightId
        ? current
        : [spotlightId, ...current.filter((id) => id !== spotlightId)],
    );
  }, [spotlightId]);

  useEffect(() => {
    if (!fullscreen.isFullscreen) setFullscreenId(null);
  }, [fullscreen.isFullscreen]);

  // Going live puts your own preview first.
  useEffect(() => {
    if (hasLocal) {
      setPinned((current) => [LOCAL_SPOTLIGHT, ...current.filter((id) => id !== LOCAL_SPOTLIGHT)]);
    }
  }, [hasLocal]);

  const focusKey = remoteMains.length > MOSAIC_HIGH_LIMIT ? '' : remoteMains.join('|');
  useEffect(() => {
    onFocusChange(focusKey ? focusKey.split('|') : []);
  }, [focusKey, onFocusChange]);

  function dragSplit(clientX: number) {
    const rect = mainsRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const ratio = (clientX - rect.left) / rect.width;
    setSplit(Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, ratio)));
  }

  function chooseLayout(next: LayoutMode) {
    setMode(next);
    store(LAYOUT_KEY, next);
  }

  function toggleStrip() {
    setStripHidden((current) => {
      store(STRIP_HIDDEN_KEY, String(!current));
      return !current;
    });
  }

  function promote(id: string) {
    if (fullId) setFullscreenId(id);
    else setPinned((current) => [id, ...current.filter((other) => other !== id)]);
  }

  function toggleFullscreenFor(id: string) {
    if (fullscreen.isFullscreen) {
      void fullscreen.toggle();
    } else {
      setFullscreenId(id);
      void fullscreen.toggle();
    }
  }

  function audioFor(id: string): AudioSetting {
    return audio[id] ?? { volume: 1, muted: id !== primaryRemote };
  }

  if (candidates.length === 0) {
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

  const screenById = new Map(screens.map((screen) => [screen.participantIdentity, screen]));
  const showStrip = Boolean(fullId) || mode === 'spotlight';
  const thumbs = showStrip ? candidates.filter((id) => !mains.includes(id)) : [];
  const loadingThumbs = showStrip ? loadingBroadcasts : [];
  const stripCount = thumbs.length + loadingThumbs.length;
  const columns = mains.length <= 1 ? 1 : mains.length <= 4 ? 2 : 3;

  function renderTile(id: string) {
    const toggle = () => toggleFullscreenFor(id);
    if (id === LOCAL_SPOTLIGHT) {
      return local?.renderStage({ active: fullscreen.isFullscreen, toggle }) ?? null;
    }
    const screen = screenById.get(id);
    if (!screen) return null;
    return (
      <RemoteTile
        screen={screen}
        audio={audioFor(id)}
        onAudioChange={(next) => setAudio((current) => ({ ...current, [id]: next }))}
        qualityMode={qualityMode}
        onQualityModeChange={onQualityModeChange}
        isFullscreen={fullscreen.isFullscreen}
        onToggleFullscreen={toggle}
      />
    );
  }

  const paired = !fullId && mode === 'mosaic' && mains.length === 2;
  const [left, right] = mains;

  const mainsView = paired ? (
    <div className="mains paired" ref={mainsRef}>
      <div className="tile-slot" key={left} style={{ flexBasis: `${split * 100}%` }}>
        {renderTile(left!)}
      </div>
      <div
        className="splitter"
        role="separator"
        aria-orientation="vertical"
        aria-valuemin={SPLIT_MIN * 100}
        aria-valuemax={SPLIT_MAX * 100}
        aria-valuenow={Math.round(split * 100)}
        title="Arraste para redimensionar · clique duplo para dividir ao meio"
        onPointerDown={(event) => {
          draggingRef.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (draggingRef.current) dragSplit(event.clientX);
        }}
        onPointerUp={(event) => {
          draggingRef.current = false;
          event.currentTarget.releasePointerCapture(event.pointerId);
          store(SPLIT_KEY, String(split));
        }}
        onDoubleClick={() => {
          setSplit(0.5);
          store(SPLIT_KEY, '0.5');
        }}
      />
      <div className="tile-slot" key={right} style={{ flexBasis: `${(1 - split) * 100}%` }}>
        {renderTile(right!)}
      </div>
    </div>
  ) : (
    <div className={`mains cols-${columns}`}>
      {mains.map((id) => (
        <div className="tile-slot" key={id}>
          {renderTile(id)}
        </div>
      ))}
    </div>
  );

  return (
    <section className="broadcast-layout">
      <div className={`stage-area${fullscreen.idle ? ' idle' : ''}`} ref={areaRef}>
        {mainsView}

        {candidates.length > 1 && !fullId && (
          <div className="layout-switch" role="group" aria-label="Layout">
            {LAYOUTS.map((layout) => (
              <button
                key={layout.mode}
                className={mode === layout.mode ? 'active' : undefined}
                onClick={() => chooseLayout(layout.mode)}
                aria-pressed={mode === layout.mode}
                title={layout.label}
                aria-label={layout.label}
              >
                {layout.icon}
              </button>
            ))}
          </div>
        )}

        {stripCount > 0 && (
          <div className={`thumb-overlay${stripHidden ? ' collapsed' : ''}`}>
            <button
              className="thumb-toggle"
              onClick={toggleStrip}
              aria-expanded={!stripHidden}
              title={stripHidden ? 'Mostrar transmissões' : 'Ocultar transmissões'}
            >
              <Icon>
                <path d={stripHidden ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} />
              </Icon>
              {stripHidden ? `${stripCount}` : null}
            </button>
            {!stripHidden && (
              <div className="thumb-strip">
                {thumbs.map((id) => {
                  if (id === LOCAL_SPOTLIGHT) {
                    return (
                      <Thumbnail
                        key={id}
                        name={local?.name ?? ''}
                        label="Sua transmissão"
                        video={local?.track ?? null}
                        onSelect={() => promote(id)}
                      />
                    );
                  }
                  const screen = screenById.get(id);
                  if (!screen) return null;
                  return (
                    <Thumbnail
                      key={id}
                      name={screen.participantName}
                      label={sourceText(screen.sourceName, screen.sourceKind)}
                      video={screen.videoTrack}
                      onSelect={() => promote(id)}
                    />
                  );
                })}
                {loadingThumbs.map((broadcast) => (
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
