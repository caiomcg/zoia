import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import type { LocalVideoTrack, RemoteTrack } from 'livekit-client';
import type { RemoteScreen } from '../livekit/useRoom';
import Avatar from './Avatar';
import { IconEye, IconFullscreen, IconVolume } from './Player';
import { useT, type T } from '../i18n';
import type { MessageKey } from '../../shared/i18n';
import { clampPairSplit, pairSplitLimits } from '../pair-split';

/**
 * Every broadcast in the room, laid out one of two ways:
 *
 * - spotlight: one large, the rest of what is watched as small windows at the
 *   bottom, which the arrow tucks away; clicking one swaps it with the large;
 * - mosaic: all of them large. Two sit side by side with a draggable split
 *   that stops once a tile is too narrow for its controls; more form a grid.
 *
 * Both show the same thing, what the viewer chose to watch; switching layout
 * only changes how. Nothing opens by itself: someone joining sees a dark
 * stage, and chooses what to watch. Watching includes the sound; there is no
 * listening without watching.
 *
 * The broadcasts not on stage are found in the channel list: hovering someone
 * live there shows their thumbnail beside it (see GridControls), and clicking
 * them puts them on stage. Nothing lies over the stage for them, since in the
 * mosaic anything there covered the corners and controls of the tiles.
 *
 * Fullscreen hides the channel list, so there the others are in a thumbnail
 * strip over the picture instead; clicking one swaps it in. Leaving fullscreen
 * lands back in whichever layout was chosen. After a few still seconds the
 * overlays and the cursor fade. Large tiles ask for the high simulcast layer,
 * thumbnails for the low one (see setRemoteFocus).
 *
 * Volume and mute are kept per person, here rather than in the tile, so they
 * survive a tile moving between the strip and a large slot.
 */

/** Stands in for "your own broadcast" wherever a broadcast identity goes. */
export const LOCAL_SPOTLIGHT = '__local__';

export type LayoutMode = 'spotlight' | 'mosaic';

/** Someone in the channel list, by what the list knows of them. */
export interface GridTarget {
  identity: string;
  isLocal: boolean;
}

/** How the channel list reaches the broadcasts, through App. */
export interface GridControls {
  /** Puts their broadcast on stage, as clicking a thumbnail does. */
  watch(target: GridTarget): void;
  /** Shows their thumbnail beside `anchor`, their row; null starts to hide it. */
  hover(target: GridTarget | null, anchor?: DOMRect): void;
}

/** What the channel list marks on each person: whose broadcast is on stage. */
export interface StageState {
  watching: string[];
  localWatched: boolean;
}

/** Long enough to move from a row in the list onto its thumbnail. */
const HOVER_CLOSE_MS = 250;
const PREVIEW_WIDTH = 320;
const PREVIEW_HEIGHT = 180;

const LAYOUT_KEY = 'zoia.layout';
const STRIP_HIDDEN_KEY = 'zoia.thumbnailsHidden';
/**
 * Thumbnails are snapshots, not video: a blurred live picture still cost a
 * download and a decode per broadcast. The server stops forwarding a
 * thumbnail's video, and resumes it this often just long enough for a frame.
 */
const SNAPSHOT_INTERVAL_MS = 60_000;
/** How often to look for thumbnails whose snapshot is due. */
const SNAPSHOT_CHECK_MS = 5_000;
/** Give up on a snapshot this long after asking; try again next interval. */
const SNAPSHOT_TIMEOUT_MS = 5_000;
const SNAPSHOT_WIDTH = 320;
const SNAPSHOT_HEIGHT = 180;

/** Where a broadcast's volume starts. Full volume on arrival was a jump scare. */
const DEFAULT_VOLUME = 0.5;
/** Past this many large tiles, each is small enough that the low layer does. */
const MOSAIC_HIGH_LIMIT = 4;
/** In fullscreen, overlays fade after this long without the mouse moving. */
const FULLSCREEN_IDLE_MS = 5000;
const SPLIT_KEY = 'zoia.pairSplit';
const AUDIO_KEY = 'zoia.remoteAudio';

function readSplit(): number {
  try {
    const value = Number(localStorage.getItem(SPLIT_KEY));
    // The real floor depends on the row width (see clampPairSplit), so a
    // stored fraction is kept and pulled back once the row is measured.
    return value > 0 && value < 1 ? value : 0.5;
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

function readAudioSettings(): Record<string, AudioSetting> {
  try {
    const parsed = JSON.parse(localStorage.getItem(AUDIO_KEY) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([id, value]) => {
        if (!value || typeof value !== 'object') return [];
        const setting = value as Partial<AudioSetting>;
        if (
          typeof setting.volume !== 'number' ||
          !Number.isFinite(setting.volume) ||
          setting.volume < 0 ||
          setting.volume > 1 ||
          typeof setting.muted !== 'boolean'
        ) {
          return [];
        }
        return [[id, { volume: setting.volume, muted: setting.muted }]];
      }),
    );
  } catch {
    return {};
  }
}

function sourceText(
  t: T,
  sourceName: string | null,
  sourceKind: RemoteScreen['sourceKind'],
): string {
  if (sourceName) return sourceName;
  if (sourceKind === 'camera') return t('grid.source.camera');
  if (sourceKind === 'window') return t('grid.source.window');
  return t('grid.source.screen');
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

const LAYOUTS: Array<{ mode: LayoutMode; label: MessageKey; icon: ReactNode }> = [
  {
    mode: 'spotlight',
    label: 'grid.spotlight',
    icon: (
      <Icon>
        <rect x="3" y="4" width="18" height="11" rx="1.5" />
        <path d="M4 19h4M10 19h4M16 19h4" />
      </Icon>
    ),
  },
  {
    mode: 'mosaic',
    label: 'grid.mosaic',
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
    if (tracks.length > 0) {
      element.srcObject = new MediaStream(tracks);
      void element.play().catch(() => {});
    } else {
      element.srcObject = null;
    }
    return () => {
      element.srcObject = null;
    };
  }, [ref, video, audio]);
}

function RemoteTile({
  screen,
  audio,
  onAudioChange,
  hq,
  onToggleHq,
  isFullscreen,
  onToggleFullscreen,
  onClose,
}: {
  screen: RemoteScreen;
  audio: AudioSetting;
  onAudioChange: (next: AudioSetting) => void;
  /** This broadcast's own quality: HQ on takes the high layer. */
  hq: boolean;
  onToggleHq: () => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  /** Stop watching: the broadcast goes back to the thumbnails. */
  onClose: () => void;
}) {
  const t = useT();
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
          <Avatar name={screen.participantName} identity={screen.participantIdentity} live />
          <span className="remote-tile-label">
            <span className="remote-tile-name">{screen.participantName}</span>
            <small className="stream-source">
              {sourceText(t, screen.sourceName, screen.sourceKind)}
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
                title={muted ? t('common.unmute') : t('common.mute')}
                aria-label={muted ? t('common.unmute') : t('common.mute')}
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
                aria-label={t('grid.volumeFor', { name: screen.participantName })}
              />
            </>
          )}
          {/* A hardware (WHIP) broadcast has one layer; offering a choice that
              changes nothing would be a lie. */}
          {screen.simulcast && (
            <button
              className={`hq-toggle${hq ? ' active' : ''}`}
              onClick={onToggleHq}
              aria-pressed={hq}
              title={hq ? t('grid.hqOn') : t('grid.hqOff')}
            >
              HQ
            </button>
          )}
          <button
            className="icon-button"
            onClick={onToggleFullscreen}
            title={isFullscreen ? t('common.exitFullscreen') : t('common.fullscreen')}
            aria-label={isFullscreen ? t('common.exitFullscreen') : t('common.fullscreen')}
          >
            <IconFullscreen active={isFullscreen} />
          </button>
          {!isFullscreen && (
            <button
              className="icon-button"
              onClick={onClose}
              title={t('grid.stopWatching')}
              aria-label={t('grid.stopWatching')}
            >
              <Icon>
                <path d="M6 6l12 12M18 6L6 18" />
              </Icon>
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

/**
 * Grabs one frame of a remote video track as a small JPEG. The track has
 * just been resumed; grabFrame waits for the next frame to arrive, so the
 * picture is current. No video element is involved, so nothing is decoded
 * for display and nothing needs to be on the page.
 */
function useSnapshot(
  track: RemoteTrack | null,
  capture: boolean,
  onCaptured: (url: string | null) => void,
) {
  const onCapturedRef = useRef(onCaptured);
  useEffect(() => {
    onCapturedRef.current = onCaptured;
  });

  useEffect(() => {
    if (!capture) return;
    // Nothing to take (an audio-only broadcast): report, so it is not retried
    // until the next interval, and its video is not left unpaused.
    if (!track || typeof ImageCapture === 'undefined') {
      onCapturedRef.current(null);
      return;
    }
    let done = false;
    const finish = (url: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      onCapturedRef.current(url);
    };
    const timer = setTimeout(() => finish(null), SNAPSHOT_TIMEOUT_MS);

    // Chromium implements grabFrame; TypeScript's DOM types stop at takePhoto.
    const capturer = new ImageCapture(track.mediaStreamTrack) as ImageCapture & {
      grabFrame(): Promise<ImageBitmap>;
    };
    capturer
      .grabFrame()
      .then((frame) => {
        const canvas = document.createElement('canvas');
        canvas.width = SNAPSHOT_WIDTH;
        canvas.height = SNAPSHOT_HEIGHT;
        const context = canvas.getContext('2d');
        if (!context || !frame.width || !frame.height) {
          frame.close();
          return finish(null);
        }
        // Cover, like the thumbnail does: crop rather than letterbox.
        const scale = Math.max(SNAPSHOT_WIDTH / frame.width, SNAPSHOT_HEIGHT / frame.height);
        const width = frame.width * scale;
        const height = frame.height * scale;
        context.drawImage(
          frame,
          (SNAPSHOT_WIDTH - width) / 2,
          (SNAPSHOT_HEIGHT - height) / 2,
          width,
          height,
        );
        frame.close();
        finish(canvas.toDataURL('image/jpeg', 0.7));
      })
      .catch(() => finish(null));

    return () => {
      done = true;
      clearTimeout(timer);
    };
  }, [capture, track]);
}

/**
 * The sound of a broadcast someone only listens to. Lives outside the
 * thumbnail, so tucking the strip away does not silence it.
 */
function ListenAudio({ track, audio }: { track: RemoteTrack; audio: AudioSetting }) {
  const ref = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.srcObject = new MediaStream([track.mediaStreamTrack]);
    return () => {
      element.srcObject = null;
    };
  }, [track]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.muted = audio.muted;
    element.volume = audio.volume;
  }, [audio.muted, audio.volume]);

  return <audio ref={ref} autoPlay />;
}

/** Takes one broadcast's snapshot, with no picture of its own on screen. */
function SnapshotTaker({
  track,
  onCaptured,
}: {
  track: RemoteTrack | null;
  onCaptured: (url: string | null) => void;
}) {
  useSnapshot(track, true, onCaptured);
  return null;
}

function Thumbnail({
  name,
  identity,
  label,
  liveVideo = null,
  snapshot = null,
  audio,
  onAudioChange,
  onWatch,
  onStop,
  preview,
  peeking = false,
  onTogglePeek,
  loading = false,
}: {
  name: string;
  /** Whose broadcast it is, for their profile picture. */
  identity?: string;
  label: string;
  /** A broadcast that has started but not arrived yet: its blank shimmers. */
  loading?: boolean;
  /** Your own preview, which costs no bandwidth, stays live and sharp. */
  liveVideo?: LocalVideoTrack | RemoteTrack | null;
  /** A remote broadcast shows its latest snapshot instead of live video. */
  snapshot?: string | null;
  audio?: AudioSetting;
  onAudioChange?: (next: AudioSetting) => void;
  onWatch?: () => void;
  /** Your own preview: stop sharing, right from the strip. */
  onStop?: () => void;
  /** Your own thumbnail: its eye shows or hides your preview instead. */
  preview?: { on: boolean; onToggle: () => void };
  /**
   * Someone else's, in the spotlight: the eye watches it as a small window at
   * the bottom, or closes that window. Clicking the tile puts it large.
   */
  peeking?: boolean;
  onTogglePeek?: () => void;
}) {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement>(null);
  useMediaStream(videoRef, liveVideo, null);

  const volume = audio?.volume ?? DEFAULT_VOLUME;
  const muted = Boolean(audio?.muted);

  return (
    <div className="thumb" title={`${name} — ${label}`}>
      <button
        className="thumb-watch"
        onClick={onWatch}
        disabled={!onWatch}
        aria-label={t('grid.watch', { name })}
      >
        {liveVideo ? (
          <video
            className="thumb-live"
            ref={videoRef}
            playsInline
            autoPlay
            muted
            poster={snapshot ?? undefined}
          />
        ) : snapshot ? (
          <img src={snapshot} alt="" />
        ) : (
          <span className={`thumb-blank${loading ? ' loading' : ''}`} />
        )}
        <span className="thumb-label">
          <Avatar name={name} identity={identity} live />
          <span>{label}</span>
        </span>
        {onWatch && (
          <span className="thumb-hint" aria-hidden="true">
            <Icon>
              <path d="M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6" />
            </Icon>
            {t('grid.watchOnStage')}
          </span>
        )}
      </button>
      {/* Hover only: at this size the tile is for the picture. */}
      {peeking && onAudioChange && (
        <div className="thumb-audio">
          {/* Same as a watched tile: muting keeps the level, and unmuting
              restores it, or full volume if it was at zero. */}
          <button
            className="thumb-action"
            onClick={() =>
              onAudioChange({ volume: muted && volume === 0 ? 1 : volume, muted: !muted })
            }
            title={muted ? t('common.unmute') : t('common.mute')}
            aria-label={muted ? t('grid.unmuteName', { name }) : t('grid.muteName', { name })}
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
            className="thumb-volume"
            aria-label={t('grid.volumeFor', { name })}
          />
        </div>
      )}
      {onWatch && (
        <div className="thumb-actions">
          {preview ? (
            <button
              className={`thumb-action${preview.on ? ' active' : ''}`}
              onClick={preview.onToggle}
              aria-pressed={preview.on}
              title={preview.on ? t('player.hidePreview') : t('player.showPreview')}
              aria-label={preview.on ? t('player.hidePreview') : t('player.showPreview')}
            >
              <IconEye off={!preview.on} />
            </button>
          ) : onTogglePeek ? (
            <button
              className={`thumb-action${peeking ? ' active' : ''}`}
              onClick={onTogglePeek}
              aria-pressed={peeking}
              title={peeking ? t('grid.previewStop') : t('grid.previewStart')}
              aria-label={peeking ? t('grid.previewStop') : t('grid.previewStart')}
            >
              <IconEye off={!peeking} />
            </button>
          ) : null}
          {onStop && (
            <button
              className="thumb-action danger"
              onClick={onStop}
              title={t('common.stopSharing')}
              aria-label={t('common.stopSharing')}
            >
              <Icon>
                <rect x="6" y="6" width="12" height="12" rx="1.5" />
              </Icon>
            </button>
          )}
        </div>
      )}
    </div>
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
  onPausedChange,
  controlRef,
  onStageChange,
}: {
  screens: RemoteScreen[];
  /** Present while this device is broadcasting. */
  local?: {
    renderStage: (fullscreen: { active: boolean; toggle: () => void }) => ReactNode;
    track: LocalVideoTrack | null;
    name: string;
    /** Yours, for your profile picture on your own thumbnail. */
    identity?: string;
    onStop: () => void;
    /** Whether you see your own picture, here and on the stage. */
    showPreview: boolean;
    onTogglePreview: () => void;
  };
  /** Called with the remote broadcasts shown large, which get full quality. */
  onFocusChange: (identities: string[]) => void;
  loadingBroadcasts?: LoadingBroadcast[];
  showOnboarding?: boolean;
  onStartSharing?: () => void;
  onDismissOnboarding?: () => void;
  /** Called with the remote broadcasts whose video should not be forwarded. */
  onPausedChange: (identities: string[]) => void;
  controlRef?: Ref<GridControls>;
  /** Called with who is on stage or only heard, for the channel list. */
  onStageChange?: (state: StageState) => void;
}) {
  const t = useT();
  const [mode, setMode] = useState<LayoutMode>(() =>
    // 'pair' was a layout of its own; mosaic now does side by side.
    readStored(LAYOUT_KEY, ['spotlight', 'mosaic', 'pair'], 'spotlight') === 'spotlight'
      ? 'spotlight'
      : 'mosaic',
  );
  // What the viewer chose to watch, the same in both layouts, which only show
  // it differently: the mosaic as tiles, the spotlight with the first large and
  // the rest as small windows at the bottom. Watched means heard, too.
  const [pinned, setPinned] = useState<string[]>([]);
  const [audio, setAudio] = useState<Record<string, AudioSetting>>(readAudioSettings);
  const [stripHidden, setStripHidden] = useState(
    () => readStored(STRIP_HIDDEN_KEY, ['true', 'false'], 'false') === 'true',
  );
  const [split, setSplit] = useState(readSplit);
  // Measured width of the side-by-side row, so the divider's limits (and its
  // aria values) follow the window rather than a fixed fraction.
  const [pairWidth, setPairWidth] = useState(0);
  const mainsRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const areaRef = useRef<HTMLDivElement>(null);
  const fullscreen = useFullscreen(areaRef);
  // In fullscreen the strip holds every broadcast, since the channel list is
  // hidden. In the spotlight it holds the small windows: the rest of what is
  // watched. The mosaic has none. Both tuck away with the same arrow.
  const stripShown = fullscreen.isFullscreen && !stripHidden;
  const pipStrip = !fullscreen.isFullscreen && mode === 'spotlight';
  const pipShown = pipStrip && !stripHidden;
  // Which broadcast fills the screen while fullscreen; null otherwise.
  const [fullscreenId, setFullscreenId] = useState<string | null>(null);

  const hasLocal = Boolean(local);
  const candidates = [
    ...(hasLocal ? [LOCAL_SPOTLIGHT] : []),
    ...screens.map((screen) => screen.participantIdentity),
  ];
  const livePinned = pinned.filter((id) => candidates.includes(id));

  // What the viewer chose to watch. Nothing, until they choose.
  const spotlightId = livePinned[0] ?? null;
  // The fullscreen broadcast ended: show whatever the layout would lead with.
  const fullId = fullscreen.isFullscreen
    ? fullscreenId && candidates.includes(fullscreenId)
      ? fullscreenId
      : spotlightId
    : null;

  let mains: string[];
  if (fullId) mains = [fullId];
  else if (mode === 'mosaic') mains = livePinned;
  else mains = spotlightId ? [spotlightId] : [];
  const paired = !fullId && mode === 'mosaic' && mains.length === 2;

  // A stored or dragged fraction can leave a tile narrower than its footer
  // once the window shrinks. Pull it back whenever the row's width changes.
  useLayoutEffect(() => {
    const el = mainsRef.current;
    if (!paired || !el) return;
    const apply = () => {
      const width = el.getBoundingClientRect().width;
      setPairWidth(width);
      setSplit((current) => clampPairSplit(current, width));
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => observer.disconnect();
  }, [paired]);

  const remoteMains = mains.filter((id) => id !== LOCAL_SPOTLIGHT);
  // The spotlight's small windows: everything watched but the large one.
  const pipIds = pipStrip ? livePinned.slice(1) : [];
  // Watched, but not large: heard from outside its tile.
  const heardAside = livePinned.filter((id) => !mains.includes(id) && id !== LOCAL_SPOTLIGHT);
  // Broadcasts this viewer turned HQ off for. Per broadcast, not room-wide.
  const [lowQuality, setLowQuality] = useState<Set<string>>(new Set());
  // Latest thumbnail picture per broadcast, and which are being taken now.
  const [snapshots, setSnapshots] = useState<Record<string, { url: string | null; at: number }>>(
    {},
  );
  const [capturing, setCapturing] = useState<Set<string>>(new Set());
  // The broadcast whose thumbnail is showing beside the channel list.
  const [hovered, setHovered] = useState<{ id: string; anchor: DOMRect } | null>(null);
  const hoverCloseRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idFor = (target: GridTarget) => (target.isLocal ? LOCAL_SPOTLIGHT : target.identity);
  const keepHover = () => {
    if (hoverCloseRef.current) clearTimeout(hoverCloseRef.current);
    hoverCloseRef.current = null;
  };
  const releaseHover = () => {
    keepHover();
    hoverCloseRef.current = setTimeout(() => setHovered(null), HOVER_CLOSE_MS);
  };
  useEffect(() => keepHover, []);

  useEffect(() => {
    if (!fullscreen.isFullscreen) setFullscreenId(null);
  }, [fullscreen.isFullscreen]);

  // Going live puts your own preview first.
  useEffect(() => {
    if (hasLocal) {
      setPinned((current) => [LOCAL_SPOTLIGHT, ...current.filter((id) => id !== LOCAL_SPOTLIGHT)]);
    }
  }, [hasLocal]);

  const hqMains = remoteMains.filter((id) => !lowQuality.has(id));
  const focusKey = hqMains.length > MOSAIC_HIGH_LIMIT ? '' : hqMains.join('|');
  useEffect(() => {
    onFocusChange(focusKey ? focusKey.split('|') : []);
  }, [focusKey, onFocusChange]);

  // Every remote broadcast not shown large is a thumbnail: its video is paused
  // on the server, except for the moment a snapshot is being taken, and while
  // its thumbnail is hovered in the channel list, where it plays live.
  // Snapshots are taken whether or not any thumbnail is on screen, so the one
  // shown on hover is current. Listening only brings the sound.
  const remoteThumbKey = screens
    .map((screen) => screen.participantIdentity)
    .filter((id) => !mains.includes(id))
    .join('|');
  // A small window on screen keeps its video coming, on the low layer.
  const pausedKey = (remoteThumbKey ? remoteThumbKey.split('|') : [])
    .filter((id) => id !== hovered?.id)
    .filter((id) => !capturing.has(id) && !(pipShown && pipIds.includes(id)))
    .join('|');
  useEffect(() => {
    onPausedChange(pausedKey ? pausedKey.split('|') : []);
  }, [pausedKey, onPausedChange]);

  const snapshotsRef = useRef(snapshots);
  useEffect(() => {
    snapshotsRef.current = snapshots;
  }, [snapshots]);

  useEffect(() => {
    const due = remoteThumbKey ? remoteThumbKey.split('|') : [];
    const tick = () => {
      const now = Date.now();
      setCapturing((current) => {
        const next = new Set([...current].filter((id) => due.includes(id)));
        for (const id of due) {
          const last = snapshotsRef.current[id]?.at ?? 0;
          if (now - last >= SNAPSHOT_INTERVAL_MS) next.add(id);
        }
        const same = next.size === current.size && [...next].every((id) => current.has(id));
        return same ? current : next;
      });
    };
    tick();
    const timer = setInterval(tick, SNAPSHOT_CHECK_MS);
    return () => clearInterval(timer);
  }, [remoteThumbKey]);

  function captured(id: string, url: string | null) {
    setSnapshots((current) => ({
      ...current,
      // A failed grab keeps the last picture, and waits a full interval.
      [id]: { url: url ?? current[id]?.url ?? null, at: Date.now() },
    }));
    setCapturing((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }

  function dragSplit(clientX: number) {
    const rect = mainsRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const ratio = (clientX - rect.left) / rect.width;
    setSplit(clampPairSplit(ratio, rect.width));
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

  // Watching the same in both layouts: it joins what is watched, and in the
  // spotlight goes large, so what was large becomes a small window. Clicking a
  // small window is therefore a swap.
  function watch(id: string) {
    keepHover();
    setHovered(null);
    if (fullId) setFullscreenId(id);
    else if (mode === 'mosaic')
      setPinned((current) => (current.includes(id) ? current : [...current, id]));
    else setPinned((current) => [id, ...current.filter((other) => other !== id)]);
    ensureAudible(id);
  }

  // Picked from the channel list or its hover thumbnail. In the spotlight it
  // replaces what is large, which stops being watched; the eye is the way to
  // keep both. Elsewhere it is the same as watching.
  function pick(id: string) {
    if (fullId || mode === 'mosaic') {
      watch(id);
      return;
    }
    keepHover();
    setHovered(null);
    setPinned((current) => {
      const large = current.find((other) => candidates.includes(other));
      return [id, ...current.filter((other) => other !== id && other !== large)];
    });
    ensureAudible(id);
  }

  // The eye, in the spotlight: watch as a small window without taking over
  // the large one, or stop watching it.
  function toggleSmallWindow(id: string) {
    if (livePinned.includes(id)) {
      stopWatching(id);
      return;
    }
    setPinned((current) => [...current, id]);
    ensureAudible(id);
  }

  /** Choosing to hear something means hearing it, whatever it was left at. */
  function ensureAudible(id: string) {
    setAudio((current) => {
      const setting = current[id];
      if (!setting?.muted && (setting?.volume ?? DEFAULT_VOLUME) > 0) return current;
      const next = {
        ...current,
        [id]: { volume: setting?.volume || DEFAULT_VOLUME, muted: false },
      };
      store(AUDIO_KEY, JSON.stringify(next));
      return next;
    });
  }

  function stopWatching(id: string) {
    setPinned((current) => current.filter((other) => other !== id));
  }

  function updateAudio(id: string, nextSetting: AudioSetting) {
    setAudio((current) => {
      const next = { ...current, [id]: nextSetting };
      store(AUDIO_KEY, JSON.stringify(next));
      return next;
    });
  }

  function toggleFullscreenFor(id: string) {
    if (fullscreen.isFullscreen) {
      void fullscreen.toggle();
    } else {
      setFullscreenId(id);
      void fullscreen.toggle();
    }
  }

  function rank(id: string): number {
    if (livePinned.includes(id)) return 0;
    return id === LOCAL_SPOTLIGHT ? 1 : 2;
  }

  function audioFor(id: string): AudioSetting {
    return audio[id] ?? { volume: DEFAULT_VOLUME, muted: false };
  }

  useImperativeHandle(controlRef, () => ({
    watch: (target) => pick(idFor(target)),
    hover: (target, anchor) => {
      if (!target || !anchor) return releaseHover();
      keepHover();
      setHovered({ id: idFor(target), anchor });
    },
  }));

  const stageKey = JSON.stringify([
    livePinned.filter((id) => id !== LOCAL_SPOTLIGHT),
    livePinned.includes(LOCAL_SPOTLIGHT),
  ]);
  useEffect(() => {
    const [watching, localWatched] = JSON.parse(stageKey) as [string[], boolean];
    onStageChange?.({ watching, localWatched });
  }, [stageKey, onStageChange]);

  const hoverPreview = hovered ? renderPreview(hovered.id, hovered.anchor) : null;

  // Beside the channel list, on the left of the hovered row, and kept on
  // screen. In a portal: the stage clips what overflows it.
  function renderPreview(id: string, anchor: DOMRect): ReactNode {
    const card = renderCard(id, anchor);
    if (!card) return null;
    return createPortal(card, document.body);
  }

  // The thumbnail, and only what it is for from here: clicking it puts the
  // broadcast on stage, and in the spotlight its eye opens a small window.
  function renderCard(id: string, anchor: DOMRect): ReactNode {
    const top = Math.min(
      Math.max(8, anchor.top + anchor.height / 2 - PREVIEW_HEIGHT / 2),
      window.innerHeight - PREVIEW_HEIGHT - 8,
    );
    const frame = (children: ReactNode) => (
      <div
        className="member-preview"
        style={{ top, right: window.innerWidth - anchor.left + 8, width: PREVIEW_WIDTH }}
        onMouseEnter={keepHover}
        onMouseLeave={releaseHover}
      >
        {children}
      </div>
    );
    if (id === LOCAL_SPOTLIGHT) {
      if (!local) return null;
      return frame(
        <Thumbnail
          name={local.name}
          identity={local.identity}
          label={t('grid.yourBroadcast')}
          liveVideo={local.track}
          onWatch={() => pick(id)}
          onStop={local.onStop}
          preview={{ on: local.showPreview, onToggle: local.onTogglePreview }}
        />,
      );
    }
    const screen = screens.find((candidate) => candidate.participantIdentity === id);
    if (!screen) {
      const pending = loadingBroadcasts.find((broadcast) => broadcast.identity === id);
      return pending
        ? frame(
            <Thumbnail
              name={pending.name}
              identity={pending.identity}
              label={t('common.loading')}
              loading
            />,
          )
        : null;
    }
    return frame(
      <Thumbnail
        name={screen.participantName}
        identity={screen.participantIdentity}
        label={sourceText(t, screen.sourceName, screen.sourceKind)}
        liveVideo={screen.videoTrack}
        snapshot={snapshots[id]?.url ?? null}
        onWatch={() => pick(id)}
        peeking={pipIds.includes(id)}
        // The mosaic has room for another tile, so clicking is the way to see
        // it alongside; the spotlight has one, so a small window instead.
        onTogglePeek={pipStrip ? () => toggleSmallWindow(id) : undefined}
      />,
    );
  }

  // A thumbnail, for the fullscreen strip or the channel list's hover. Only a
  // hovered remote broadcast plays live; the rest show their snapshot.
  function renderThumb(id: string): ReactNode {
    if (id === LOCAL_SPOTLIGHT) {
      if (!local) return null;
      return (
        <Thumbnail
          key={id}
          name={local.name}
          identity={local.identity}
          label={t('grid.yourBroadcast')}
          liveVideo={local.track}
          onWatch={() => watch(id)}
          onStop={local.onStop}
          preview={{ on: local.showPreview, onToggle: local.onTogglePreview }}
        />
      );
    }
    const screen = screens.find((candidate) => candidate.participantIdentity === id);
    if (!screen) {
      const pending = loadingBroadcasts.find((broadcast) => broadcast.identity === id);
      return pending ? (
        <Thumbnail
          key={id}
          name={pending.name}
          identity={pending.identity}
          label={t('common.loading')}
          loading
        />
      ) : null;
    }
    // A small window plays live, with a volume and its eye to close it; the
    // fullscreen strip's thumbnails are snapshots, clicked to swap in.
    const small = pipIds.includes(id);
    return (
      <Thumbnail
        key={id}
        name={screen.participantName}
        identity={screen.participantIdentity}
        label={sourceText(t, screen.sourceName, screen.sourceKind)}
        snapshot={snapshots[id]?.url ?? null}
        audio={audioFor(id)}
        onAudioChange={small ? (next) => updateAudio(id, next) : undefined}
        peeking={small}
        onTogglePeek={small ? () => toggleSmallWindow(id) : undefined}
        liveVideo={small && pipShown ? screen.videoTrack : null}
        onWatch={() => watch(id)}
      />
    );
  }

  // Snapshots, taken off screen: nothing else would take them now that no
  // thumbnail is on screen outside fullscreen.
  const snapshotTakers = [...capturing].map((id) => (
    <SnapshotTaker
      key={id}
      track={screens.find((screen) => screen.participantIdentity === id)?.videoTrack ?? null}
      onCaptured={(url) => captured(id, url)}
    />
  ));

  if (candidates.length === 0) {
    return (
      <section className="stage remote-empty">
        {hoverPreview}
        <div className="overlay">
          {loadingBroadcasts.length > 0 ? (
            <>
              <h2>{t('grid.loadingTitle')}</h2>
              <p className="muted">
                {t(loadingBroadcasts.length === 1 ? 'grid.loadingOne' : 'grid.loadingMany', {
                  names: loadingBroadcasts.map((broadcast) => broadcast.name).join(', '),
                })}
              </p>
            </>
          ) : showOnboarding ? (
            <div className="onboarding-card">
              <p className="onboarding-step">{t('grid.onboardStep')}</p>
              <h2>{t('grid.onboardTitle')}</h2>
              <p className="muted">{t('grid.onboardBody')}</p>
              <ol className="onboarding-list">
                <li>
                  {t('grid.onboardClick').split('{button}')[0]}
                  <strong>{t('top.screen')}</strong>
                  {t('grid.onboardClick').split('{button}')[1]}
                </li>
                <li>{t('grid.onboardPick')}</li>
              </ol>
              <div className="onboarding-actions">
                <button className="primary" onClick={onStartSharing}>
                  {t('common.shareScreen')}
                </button>
                <button className="link" onClick={onDismissOnboarding}>
                  {t('grid.notNow')}
                </button>
              </div>
            </div>
          ) : (
            <>
              <h2>{t('grid.nobodyTitle')}</h2>
              <p className="muted">{t('grid.nobodyBody')}</p>
            </>
          )}
        </div>
      </section>
    );
  }

  const screenById = new Map(screens.map((screen) => [screen.participantIdentity, screen]));
  // Everything not shown large is a thumbnail, in either layout.
  // Listened-to broadcasts lead the strip, then your own, then the rest. Your
  // own broadcast never leaves the strip, even while it is also large.
  const thumbs = candidates
    .filter((id) => id === LOCAL_SPOTLIGHT || !mains.includes(id))
    .sort((a, b) => rank(a) - rank(b));
  const loadingThumbs = loadingBroadcasts;
  const stripCount = thumbs.length + loadingThumbs.length;
  // The spotlight's small windows: live ones, and ones only listened to, which
  // keep their window, showing the snapshot, so they can be switched back.
  const toggleCount = fullscreen.isFullscreen ? stripCount : pipIds.length;
  const columns = mains.length <= 1 ? 1 : mains.length <= 4 ? 2 : 3;

  function renderTile(id: string) {
    const toggle = () => toggleFullscreenFor(id);
    if (id === LOCAL_SPOTLIGHT) {
      // Your own broadcast can leave the large view, but not the strip.
      return (
        <div className="local-slot">
          {local?.renderStage({ active: fullscreen.isFullscreen, toggle })}
          {!fullscreen.isFullscreen && (
            <button
              className="tile-close"
              onClick={() => stopWatching(id)}
              title={t('grid.removeFromView')}
              aria-label={t('grid.removeFromView')}
            >
              <Icon>
                <path d="M6 6l12 12M18 6L6 18" />
              </Icon>
            </button>
          )}
        </div>
      );
    }
    const screen = screenById.get(id);
    if (!screen) return null;
    return (
      <RemoteTile
        screen={screen}
        audio={audioFor(id)}
        onAudioChange={(next) => updateAudio(id, next)}
        hq={!lowQuality.has(id)}
        onToggleHq={() =>
          setLowQuality((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          })
        }
        isFullscreen={fullscreen.isFullscreen}
        onToggleFullscreen={toggle}
        onClose={() => stopWatching(id)}
      />
    );
  }

  const [left, right] = mains;
  const splitLimits = pairSplitLimits(pairWidth);

  const mainsView =
    mains.length === 0 ? (
      // Nothing chosen yet: a dark stage, the way in to sharing, and the
      // broadcasts waiting below.
      <section className="stage remote-empty">
        <div className="overlay">
          <h2>{t('grid.pickTitle')}</h2>
          <p className="muted">{t('grid.pickBody')}</p>
          {!local && onStartSharing && (
            <div className="onboarding-actions">
              <button className="primary" onClick={onStartSharing}>
                {t('common.shareScreen')}
              </button>
            </div>
          )}
        </div>
      </section>
    ) : paired ? (
      <div className="mains paired" ref={mainsRef}>
        <div className="tile-slot" key={left} style={{ flexBasis: `${split * 100}%` }}>
          {renderTile(left!)}
        </div>
        <div
          className="splitter"
          role="separator"
          aria-orientation="vertical"
          aria-valuemin={Math.round(splitLimits.min * 100)}
          aria-valuemax={Math.round(splitLimits.max * 100)}
          aria-valuenow={Math.round(split * 100)}
          title={t('grid.splitTitle')}
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
      {hoverPreview}
      {snapshotTakers}
      <div className={`stage-area${fullscreen.idle ? ' idle' : ''}`} ref={areaRef}>
        {mainsView}

        {heardAside.map((id) => {
          const track = screenById.get(id)?.audioTrack;
          return track ? <ListenAudio key={id} track={track} audio={audioFor(id)} /> : null;
        })}

        {candidates.length > 1 && !fullId && (
          <div className="layout-switch" role="group" aria-label={t('grid.layout')}>
            {LAYOUTS.map((layout) => (
              <button
                key={layout.mode}
                className={mode === layout.mode ? 'active' : undefined}
                onClick={() => chooseLayout(layout.mode)}
                aria-pressed={mode === layout.mode}
                title={t(layout.label)}
                aria-label={t(layout.label)}
              >
                {layout.icon}
              </button>
            ))}
          </div>
        )}

        {/* The arrow has a spot of its own, bottom centre, and never moves:
            it used to ride along with the strip as it lifted and collapsed. */}
        {toggleCount > 0 && (
          <button
            className="thumb-toggle"
            onClick={toggleStrip}
            aria-expanded={!stripHidden}
            title={stripHidden ? t('grid.showStrip') : t('grid.hideStrip')}
          >
            <Icon>
              <path d={stripHidden ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} />
            </Icon>
            {stripHidden ? `${toggleCount}` : null}
          </button>
        )}
        {pipShown && pipIds.length > 0 && (
          <div className="thumb-overlay">
            <div className="thumb-strip">{pipIds.map((id) => renderThumb(id))}</div>
          </div>
        )}
        {stripShown && stripCount > 0 && (
          <div className="thumb-overlay">
            <div className="thumb-strip">
              {thumbs.map((id) => renderThumb(id))}
              {loadingThumbs.map((broadcast) => (
                <Thumbnail
                  key={broadcast.identity}
                  name={broadcast.name}
                  identity={broadcast.identity}
                  label={t('common.loading')}
                  loading
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
