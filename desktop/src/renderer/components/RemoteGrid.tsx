import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import type { LocalVideoTrack, RemoteTrack } from 'livekit-client';
import { cameraView, viewOwner, type RemoteScreen } from '../livekit/useRoom';
import Avatar from './Avatar';
import { PopoutPlayer, usePopout } from './Popout';
import { IconEye, IconFullscreen, IconMic, IconVolume, useClickOrDoubleClick } from './Player';
import { useT, type T } from '../i18n';
import {
  DOCK_DRAG_THRESHOLD_PX,
  STRIP_EDGES,
  dockDragPosition,
  stripEdgeAt,
  type StripEdge,
} from '../strip-dock';
import type { MessageKey } from '../../shared/i18n';
import { clampPairSplit, pairSplitLimits } from '../pair-split';

/**
 * Every broadcast in the room, laid out one of two ways:
 *
 * - spotlight: one large, the rest of what is watched as small windows along
 *   one edge, which the arrow tucks away; clicking one swaps it with the large.
 *   The strip starts along the bottom and a drag snaps it to another edge;
 * - mosaic: all of them large. Two sit side by side with a draggable split
 *   that stops once a tile is too narrow for its controls; more form a grid.
 *
 * Both show the same thing, everything on the stage; switching layout only
 * changes how. On the stage are your own screen and camera, the screens
 * chosen from someone's row in the channel list, and the cameras put there by
 * the camera button beside someone's name. Nothing of anyone else opens by
 * itself. A screen and a camera shared together are two pictures, each a
 * tile of its own (ADR 0034). What is on the stage is heard; there is no
 * listening without watching.
 *
 * The broadcasts not on stage are found in the channel list: hovering someone
 * live there shows their thumbnail beside it (see GridControls), and clicking
 * them puts them on stage. Nothing lies over the stage for them, since in the
 * mosaic anything there covered the corners and controls of the tiles.
 *
 * Fullscreen hides the channel list, so there the others are in a thumbnail
 * strip over the picture, on that same edge, instead; clicking one swaps it in.
 * Leaving fullscreen lands back in whichever layout was chosen. After a few
 * still seconds the
 * overlays and the cursor fade. Large tiles ask for the high simulcast layer,
 * thumbnails for the low one (see setRemoteFocus).
 *
 * Volume and mute are kept per person, here rather than in the tile, so they
 * survive a tile moving between the strip and a large slot.
 */

/** Stands in for "your own broadcast" wherever a broadcast identity goes. */
export const LOCAL_SPOTLIGHT = '__local__';

/** Your camera, beside your screen, when you put it on your own stage. */
const LOCAL_CAMERA = cameraView(LOCAL_SPOTLIGHT);

/** Yours rather than someone else's: your broadcast, or your camera. */
const isLocalId = (id: string) => viewOwner(id) === LOCAL_SPOTLIGHT;

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
  /** Puts their camera on stage, or takes it off if it is there. */
  toggleCamera(identity: string): void;
}

/** What the channel list marks on each person: whose screen and camera are on stage. */
export interface StageState {
  watching: string[];
  cameras: string[];
  localWatched: boolean;
}

/** Long enough to move from a row in the list onto its thumbnail. */
const HOVER_CLOSE_MS = 250;
const PREVIEW_WIDTH = 320;
const PREVIEW_HEIGHT = 180;

const LAYOUT_KEY = 'zoia.layout';
const STRIP_HIDDEN_KEY = 'zoia.thumbnailsHidden';
const STRIP_EDGE_KEY = 'zoia.stripEdge';
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

/** What a click on a large picture does: enlarge it, or go back to the mosaic. */
type PictureAction = 'enlarge' | 'shrink' | null;

function pictureCursor(action: PictureAction): string | undefined {
  if (action === 'enlarge') return 'enlargeable';
  if (action === 'shrink') return 'closable';
  return undefined;
}

/**
 * One picture on offer: a person's broadcast, or the camera they share beside
 * their screen, which is watched on its own under its own id (ADR 0034).
 */
interface View {
  id: string;
  /** Whose it is: their sound and volume are shared by all their pictures. */
  owner: string;
  screen: RemoteScreen;
  /** A camera, which plays live in the overview; a screen shows snapshots. */
  camera: boolean;
}

function viewsOf(screens: RemoteScreen[]): View[] {
  return screens.flatMap((screen) => {
    const owner = screen.participantIdentity;
    const main: View = { id: owner, owner, screen, camera: screen.sourceKind === 'camera' };
    if (!screen.cameraTrack) return [main];
    return [
      main,
      {
        id: cameraView(owner),
        owner,
        camera: true,
        screen: {
          ...screen,
          videoTrack: screen.cameraTrack,
          cameraTrack: null,
          sourceName: null,
          sourceKind: 'camera',
          simulcast: true,
        },
      },
    ];
  });
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

/**
 * Your camera on your own stage, beside your screen. It is in your grid for as
 * long as it is on, so there is no close button here: a click only brings the
 * grid back. Seen mirrored, and never heard.
 */
function LocalCameraTile({
  name,
  identity,
  track,
  isFullscreen,
  onToggleFullscreen,
  pictureAction = null,
  onPictureClick,
}: {
  name: string;
  identity?: string;
  track: LocalVideoTrack;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  pictureAction?: PictureAction;
  onPictureClick?: () => void;
}) {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement>(null);
  useMediaStream(videoRef, track, null);
  const pictureClicks = useClickOrDoubleClick(
    !isFullscreen && pictureAction !== null ? onPictureClick : undefined,
    onToggleFullscreen,
  );

  return (
    <article className="remote-tile">
      <video
        ref={videoRef}
        className={
          isFullscreen || !pictureAction ? 'mirrored' : `mirrored ${pictureCursor(pictureAction)}`
        }
        playsInline
        autoPlay
        muted
        {...pictureClicks}
      />
      <div className="remote-tile-footer">
        <span className="remote-tile-who">
          <Avatar name={name} identity={identity} live />
          <span className="remote-tile-label">
            <span className="remote-tile-name">{name}</span>
            <small className="stream-source">{t('grid.source.camera')}</small>
          </span>
        </span>
        <div className="remote-audio-controls">
          <button
            className="icon-button"
            onClick={onToggleFullscreen}
            title={isFullscreen ? t('common.exitFullscreen') : t('common.fullscreen')}
            aria-label={isFullscreen ? t('common.exitFullscreen') : t('common.fullscreen')}
          >
            <IconFullscreen active={isFullscreen} />
          </button>
        </div>
      </div>
    </article>
  );
}

/** Turns someone's microphone on or off for this viewer. */
function MicButton({ name, on, onToggle }: { name: string; on: boolean; onToggle: () => void }) {
  const t = useT();
  const label = on ? t('grid.muteMicOf', { name }) : t('grid.unmuteMicOf', { name });
  return (
    <button
      className={`icon-button${on ? ' active' : ''}`}
      onClick={onToggle}
      aria-pressed={on}
      title={label}
      aria-label={label}
    >
      <IconMic muted={!on} />
    </button>
  );
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
  micOn = false,
  pictureAction = null,
  onPictureClick,
  onToggleMic,
}: {
  screen: RemoteScreen;
  audio: AudioSetting;
  onAudioChange: (next: AudioSetting) => void;
  /** Their microphone, off until this viewer turns it on. */
  micOn?: boolean;
  onToggleMic?: () => void;
  /** This broadcast's own quality: HQ on takes the high layer. */
  hq: boolean;
  onToggleHq: () => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  /** Stop watching: off the stage. */
  onClose: () => void;
  /** What a click on the picture does here, if anything. */
  pictureAction?: PictureAction;
  onPictureClick?: () => void;
  /** The camera over this screen, and how it is shown; null when there is none. */
}) {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement>(null);
  const { volume, muted } = audio;
  // Picture only: the sound is played once per person by the grid, however
  // many of their pictures are on screen (see heardOwners).
  useMediaStream(videoRef, screen.videoTrack, null);
  const hasAudio = Boolean(screen.audioTrack || screen.micTrack);
  const pip = usePopout();
  // A click enlarges this tile out of the mosaic, or brings the mosaic back;
  // a double click is fullscreen. In fullscreen a single click does nothing.
  const clickable = !isFullscreen && pictureAction !== null;
  const pictureClicks = useClickOrDoubleClick(
    clickable ? onPictureClick : undefined,
    onToggleFullscreen,
  );

  return (
    <article className="remote-tile">
      <video
        ref={videoRef}
        className={pip.active ? 'popped-out' : clickable ? pictureCursor(pictureAction) : undefined}
        playsInline
        autoPlay
        muted
        {...pictureClicks}
      />
      {pip.active && (
        <div className="overlay">
          <h2>{t('grid.inPip')}</h2>
          <button className="primary" onClick={pip.close}>
            {t('grid.bringBack')}
          </button>
        </div>
      )}
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
          {hasAudio && (
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
          {screen.micTrack && onToggleMic && (
            <MicButton name={screen.participantName} on={micOn} onToggle={onToggleMic} />
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
            className={`icon-button${pip.active ? ' active' : ''}`}
            onClick={pip.toggle}
            aria-pressed={pip.active}
            title={pip.active ? t('common.exitPip') : t('common.pip')}
            aria-label={pip.active ? t('common.exitPip') : t('common.pip')}
          >
            <Icon>
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <rect x="12" y="12" width="8" height="6" rx="1" />
            </Icon>
          </button>
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
      {pip.target && (
        <PopoutPlayer
          target={pip.target}
          name={screen.participantName}
          videoTrack={screen.videoTrack}
          hasAudio={hasAudio}
          volume={volume}
          muted={muted}
          onAudioChange={onAudioChange}
          onClose={pip.close}
        />
      )}
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
  mirrored = false,
}: {
  name: string;
  /** Whose broadcast it is, for their profile picture. */
  identity?: string;
  label: string;
  /** A broadcast that has started but not arrived yet: its blank shimmers. */
  loading?: boolean;
  /** Your own preview, which costs no bandwidth, stays live and sharp. */
  liveVideo?: LocalVideoTrack | RemoteTrack | null;
  /** Your own camera, seen as in a mirror. */
  mirrored?: boolean;
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
   * Someone else's, in the spotlight: the eye watches it as a small window on
   * the strip, or closes that window. Clicking the tile puts it large.
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
            className={`thumb-live${mirrored ? ' mirrored' : ''}`}
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
    renderStage: (stage: {
      active: boolean;
      toggle: () => void;
      /** Leave the large view. The player hides it while fullscreen. */
      onClose?: () => void;
      /** Whether the footer offers a close too; never for your own broadcast. */
      closeButton: boolean;
    }) => ReactNode;
    track: LocalVideoTrack | null;
    /** `track` is your camera, which you see mirrored. */
    mirrored?: boolean;
    /**
     * Your camera while it is on, whatever the preview setting: it is always
     * in your grid.
     */
    camera?: LocalVideoTrack | null;
    /** Your camera is all you share, so it is your broadcast itself. */
    cameraIsMain?: boolean;
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
  // the rest as small windows along one edge. Watched means heard, too.
  const [pinned, setPinned] = useState<string[]>([]);
  const [audio, setAudio] = useState<Record<string, AudioSetting>>(readAudioSettings);
  const [stripHidden, setStripHidden] = useState(
    () => readStored(STRIP_HIDDEN_KEY, ['true', 'false'], 'false') === 'true',
  );
  // Which edge the strip is attached to. Remembered, like the layout.
  const [edge, setEdge] = useState<StripEdge>(() =>
    readStored(STRIP_EDGE_KEY, STRIP_EDGES, 'bottom'),
  );
  // Set for the gesture only. `edge` is where it rests; this is the pointer
  // and the edge it would dock to if released now.
  const [drag, setDrag] = useState<{ x: number; y: number; edge: StripEdge } | null>(null);
  const [split, setSplit] = useState(readSplit);
  // Measured width of the side-by-side row, so the divider's limits (and its
  // aria values) follow the window rather than a fixed fraction.
  const [pairWidth, setPairWidth] = useState(0);
  const mainsRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const areaRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const dragSession = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const dockListeners = useRef<{
    move: (event: PointerEvent) => void;
    end: (event: PointerEvent) => void;
  } | null>(null);
  // A drag past the threshold still ends over a button. Swallow that click.
  const suppressClick = useRef(false);

  // The resting place is CSS on the edge. While dragging, the same element is
  // pulled off that edge and centred on the pointer. Cleared before paint when
  // the gesture ends, so it never rests between edges.
  useLayoutEffect(() => {
    const el = dockRef.current;
    if (!el) return;
    if (!drag) {
      el.style.left = '';
      el.style.top = '';
      return;
    }
    const area = areaRef.current;
    if (!area) return;
    const rect = area.getBoundingClientRect();
    const next = dockDragPosition(
      drag.x,
      drag.y,
      { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      { width: el.offsetWidth, height: el.offsetHeight },
    );
    el.style.left = `${next.left}px`;
    el.style.top = `${next.top}px`;
  }, [drag]);

  useEffect(() => {
    return () => {
      const listeners = dockListeners.current;
      if (!listeners) return;
      window.removeEventListener('pointermove', listeners.move);
      window.removeEventListener('pointerup', listeners.end);
      window.removeEventListener('pointercancel', listeners.end);
    };
  }, []);
  const fullscreen = useFullscreen(areaRef);
  // In fullscreen the strip holds every broadcast, since the channel list is
  // hidden. In the spotlight it holds the small windows: the rest of what is
  // watched. The mosaic has none. Both tuck away with the same arrow.
  const stripShown = fullscreen.isFullscreen && !stripHidden;
  // One tile of the mosaic clicked to see it large, the rest on the strip
  // meanwhile. A click on the large picture brings the mosaic back.
  const [focusId, setFocusId] = useState<string | null>(null);
  const pipStrip = !fullscreen.isFullscreen && (mode === 'spotlight' || focusId !== null);
  const pipShown = pipStrip && !stripHidden;
  // Which broadcast fills the screen while fullscreen; null otherwise.
  const [fullscreenId, setFullscreenId] = useState<string | null>(null);

  const hasLocal = Boolean(local);
  // Every picture on offer: a screen and a camera shared together are two.
  const views = viewsOf(screens);
  const viewById = new Map(views.map((view) => [view.id, view]));
  // Your camera beside your screen is a picture of its own in your grid.
  // Shared alone, it is your broadcast itself.
  const localCameraId = local?.camera
    ? local.cameraIsMain
      ? LOCAL_SPOTLIGHT
      : LOCAL_CAMERA
    : null;
  const candidates = [
    ...(hasLocal ? [LOCAL_SPOTLIGHT] : []),
    ...(localCameraId === LOCAL_CAMERA ? [LOCAL_CAMERA] : []),
    ...views.map((view) => view.id),
  ];
  const livePinned = pinned.filter((id) => candidates.includes(id));

  // What is on the stage, all at once: the screens chosen from someone's row
  // in the channel list, your own screen and camera, and the cameras put
  // there by the camera button beside someone's name. Nobody else's screen or
  // camera opens by itself (ADR 0034); yours have no button, and are there
  // for as long as they are on.
  // Whose camera is on the stage, by person, never by picture: a camera
  // shared alone is someone's main picture, and becomes `#camera` the moment
  // they share a screen too. Kept by picture, their screen took the camera's
  // place on the stage, and the button stayed lit for it.
  const [cameraOwners, setCameraOwners] = useState<string[]>([]);
  const cameraIdOf = (owner: string): string | null => {
    if (viewById.has(cameraView(owner))) return cameraView(owner);
    return viewById.get(owner)?.camera ? owner : null;
  };
  const liveGridCameras = [
    ...(localCameraId ? [localCameraId] : []),
    ...cameraOwners.flatMap((owner) => {
      const id = cameraIdOf(owner);
      return id ? [id] : [];
    }),
  ];
  // In order of preference: your screen, your camera, the screens chosen (in
  // the order they were), then the cameras put on. Your camera alone is your
  // broadcast, so LOCAL_SPOTLIGHT is it then. The spotlight shows the first
  // large unless something was clicked to be (focusId); the mosaic shows them
  // all in this order. Your own screen is there with your preview off too:
  // its tile says you are live, and carries the eye that turns it on.
  const onStage = [
    ...new Set([
      ...(hasLocal ? [LOCAL_SPOTLIGHT] : []),
      ...(localCameraId ? [localCameraId] : []),
      ...livePinned,
      ...liveGridCameras,
    ]),
  ];
  const inMosaic = onStage;
  const focused = focusId && candidates.includes(focusId) ? focusId : null;
  const spotlightId = focused ?? onStage[0] ?? null;
  // The fullscreen broadcast ended: show whatever the layout would lead with.
  const fullId = fullscreen.isFullscreen
    ? fullscreenId && candidates.includes(fullscreenId)
      ? fullscreenId
      : spotlightId
    : null;

  let mains: string[];
  if (fullId) mains = [fullId];
  else if (focused) mains = [focused];
  else if (mode === 'mosaic') mains = inMosaic;
  else mains = spotlightId ? [spotlightId] : [];
  const paired = !fullId && !focused && mode === 'mosaic' && mains.length === 2;

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

  const remoteMains = mains.filter((id) => !isLocalId(id));
  // The small windows: everything on the stage but the large one.
  const pipIds = pipStrip ? onStage.filter((id) => id !== mains[0]) : [];
  // What plays: everything on the stage, large or small. Someone's
  // microphone with any picture of theirs; the sound of their screen only
  // with their screen, not their camera alone. Once per person, however many
  // of their pictures are on screen. Your own is never here, so you never
  // hear yourself.
  const watchedIds = [...onStage, ...remoteMains].filter((id) => !isLocalId(id));
  const heardOwners = [...new Set(watchedIds.map(viewOwner))];
  const heard = heardOwners.flatMap((owner) => {
    const screen = viewById.get(owner)?.screen;
    if (!screen) return [];
    const tracks = watchedIds.includes(owner)
      ? [screen.audioTrack, screen.micTrack]
      : [screen.micTrack];
    return tracks.flatMap((track) =>
      track ? [{ owner, track, mic: track === screen.micTrack }] : [],
    );
  });
  // Whose microphone this viewer turned on. Everyone's starts off, each time:
  // a room of open microphones playing at once is not something to walk
  // into. Not remembered, so it is off again next time too.
  const [micOn, setMicOn] = useState<Set<string>>(new Set());
  const toggleMic = (view: string) =>
    setMicOn((current) => {
      const owner = viewOwner(view);
      const next = new Set(current);
      if (next.has(owner)) next.delete(owner);
      else next.add(owner);
      return next;
    });
  // Broadcasts this viewer turned HQ off for. Per broadcast, not room-wide.
  const [lowQuality, setLowQuality] = useState<Set<string>>(new Set());
  // Latest thumbnail picture per broadcast, and which are being taken now.
  const [snapshots, setSnapshots] = useState<
    Record<string, { url: string | null; at: number; video: string }>
  >({});
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

  // Going live no longer puts your own preview on the stage: in the overview
  // you appear among everyone else, as in a call, and whatever you were
  // watching stays put.

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
  const remoteThumbKey = views
    .map((view) => view.id)
    .filter((id) => !mains.includes(id))
    .join('|');
  // Flowing besides the large tiles: a small window on screen, on the low
  // layer.
  const flowing = new Set([...(pipShown ? pipIds : [])]);
  const pausedKey = (remoteThumbKey ? remoteThumbKey.split('|') : [])
    .filter((id) => id !== hovered?.id)
    .filter((id) => !capturing.has(id) && !flowing.has(id))
    .join('|');
  useEffect(() => {
    onPausedChange(pausedKey ? pausedKey.split('|') : []);
  }, [pausedKey, onPausedChange]);

  const snapshotsRef = useRef(snapshots);
  useEffect(() => {
    snapshotsRef.current = snapshots;
  }, [snapshots]);

  // Which video each picture is of. Someone's broadcast changes what it shows
  // — a camera alone becomes their screen once they share one too — and a
  // snapshot of the old video kept standing in for the new one for up to a
  // minute: their screen's thumbnail showed their camera. A snapshot only
  // counts for the video it was taken of; a new video is pictured at once.
  const videoOf = (id: string) => viewById.get(id)?.screen.videoTrack?.mediaStreamTrack.id ?? '';
  const videoKey = views.map((view) => `${view.id}=${videoOf(view.id)}`).join('|');
  const videoOfRef = useRef(videoOf);
  videoOfRef.current = videoOf;
  const snapshotFor = (id: string) => {
    const shot = snapshots[id];
    return shot && shot.video === videoOf(id) ? shot.url : null;
  };

  useEffect(() => {
    const due = remoteThumbKey ? remoteThumbKey.split('|') : [];
    const tick = () => {
      const now = Date.now();
      setCapturing((current) => {
        const next = new Set([...current].filter((id) => due.includes(id)));
        for (const id of due) {
          const shot = snapshotsRef.current[id];
          const last = shot && shot.video === videoOfRef.current(id) ? shot.at : 0;
          if (now - last >= SNAPSHOT_INTERVAL_MS) next.add(id);
        }
        const same = next.size === current.size && [...next].every((id) => current.has(id));
        return same ? current : next;
      });
    };
    tick();
    const timer = setInterval(tick, SNAPSHOT_CHECK_MS);
    return () => clearInterval(timer);
  }, [remoteThumbKey, videoKey]);

  function captured(id: string, url: string | null) {
    const video = videoOf(id);
    setSnapshots((current) => {
      const previous = current[id]?.video === video ? current[id]?.url : null;
      return {
        ...current,
        // A failed grab keeps the last picture of the same video, and waits a
        // full interval.
        [id]: { url: url ?? previous ?? null, at: Date.now(), video },
      };
    });
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
    setFocusId(null);
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
  // small window, the channel list, or its hover thumbnail is therefore a swap.
  function watch(id: string) {
    keepHover();
    setHovered(null);
    // On the stage, after what is already there.
    if (!onStage.includes(id)) {
      setPinned((current) => (current.includes(id) ? current : [...current, id]));
    }
    // In the spotlight, or with something enlarged, what is chosen now is
    // what is shown large; the mosaic just gains a tile.
    if (fullId) setFullscreenId(id);
    else if (focused || mode === 'spotlight') setFocusId(id);
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
  function ensureAudible(view: string) {
    const id = viewOwner(view);
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

  /** Off the stage: no longer watched, nor enlarged, nor a camera on offer. */
  function stopWatching(id: string) {
    setPinned((current) => current.filter((other) => other !== id));
    // Only their camera takes their camera button down; closing their screen
    // leaves the camera where it is.
    const owner = viewOwner(id);
    if (cameraIdOf(owner) === id) {
      setCameraOwners((current) => current.filter((other) => other !== owner));
    }
    if (focused === id) setFocusId(null);
  }

  // A click on a large picture: in the mosaic it enlarges that tile, and on
  // the enlarged one it brings the mosaic back. The spotlight already shows
  // one large, so there it does nothing.
  function pictureActionFor(id: string): PictureAction {
    // The spotlight always shows one large; a click there changes nothing.
    if (focused === id) return mode === 'mosaic' ? 'shrink' : null;
    if (!focused && !fullId && mode === 'mosaic' && mains.length > 1) return 'enlarge';
    return null;
  }

  function clickPicture(id: string) {
    const action = pictureActionFor(id);
    if (action === 'shrink') setFocusId(null);
    else if (action === 'enlarge') setFocusId(id);
  }

  // Sound is per person: muting someone's camera mutes their screen too.
  function updateAudio(view: string, nextSetting: AudioSetting) {
    const id = viewOwner(view);
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

  function audioFor(view: string): AudioSetting {
    return audio[viewOwner(view)] ?? { volume: DEFAULT_VOLUME, muted: false };
  }

  useImperativeHandle(controlRef, () => ({
    watch: (target) => watch(idFor(target)),
    hover: (target, anchor) => {
      if (!target || !anchor) return releaseHover();
      keepHover();
      setHovered({ id: idFor(target), anchor });
    },
    // Puts their camera in the grid, never straight onto the large view; the
    // grid shows once nothing is enlarged. Again, and it leaves the grid, and
    // the large view too if it was there.
    toggleCamera: (identity) => {
      // Yours is always there; your own row has no button for it.
      if (identity === local?.identity) return;
      if (cameraOwners.includes(identity)) {
        setCameraOwners((current) => current.filter((other) => other !== identity));
        const id = cameraIdOf(identity);
        if (id && focused === id) setFocusId(null);
        return;
      }
      setCameraOwners((current) => (current.includes(identity) ? current : [...current, identity]));
      ensureAudible(identity);
    },
  }));

  // The channel list marks people, not pictures: whose screen is watched, and
  // whose camera is in the grid, each on its own.
  const remotePinned = livePinned.filter((id) => !isLocalId(id));
  const stageKey = JSON.stringify([
    [...new Set(remotePinned.filter((id) => !viewById.get(id)?.camera).map(viewOwner))],
    [...(localCameraId && local?.identity ? [local.identity] : []), ...cameraOwners],
    livePinned.includes(LOCAL_SPOTLIGHT),
  ]);
  useEffect(() => {
    const [watching, cameras, localWatched] = JSON.parse(stageKey) as [string[], string[], boolean];
    onStageChange?.({ watching, cameras, localWatched });
  }, [stageKey, onStageChange]);

  const hoverPreview = hovered ? renderPreview(hovered.id, hovered.anchor) : null;

  // Beside the channel list, on the left of the hovered row, and kept on
  // screen. In a portal: the stage clips what overflows it.
  function renderPreview(id: string, anchor: DOMRect): ReactNode {
    const card = renderCard(id, anchor);
    if (!card) return null;
    return createPortal(card, document.body);
  }

  // The thumbnail, and only what it is for from here: clicking it watches,
  // the same as a thumbnail on the strip, and in the spotlight its eye opens
  // a small window without taking over the large one.
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
          mirrored={local.mirrored}
          onWatch={() => watch(id)}
          onStop={local.onStop}
          preview={{ on: local.showPreview, onToggle: local.onTogglePreview }}
        />,
      );
    }
    const screen = viewById.get(id)?.screen;
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
        snapshot={snapshotFor(id)}
        onWatch={() => watch(id)}
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
    if (id === LOCAL_CAMERA) {
      if (!local?.camera) return null;
      return (
        <Thumbnail
          key={id}
          name={local.name}
          identity={local.identity}
          label={t('grid.source.camera')}
          liveVideo={local.camera}
          mirrored
          onWatch={() => watch(id)}
        />
      );
    }
    if (id === LOCAL_SPOTLIGHT) {
      if (!local) return null;
      return (
        <Thumbnail
          key={id}
          name={local.name}
          identity={local.identity}
          label={t('grid.yourBroadcast')}
          liveVideo={local.track}
          mirrored={local.mirrored}
          onWatch={() => watch(id)}
          onStop={local.onStop}
          preview={{ on: local.showPreview, onToggle: local.onTogglePreview }}
        />
      );
    }
    const screen = viewById.get(id)?.screen;
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
        snapshot={snapshotFor(id)}
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
      track={viewById.get(id)?.screen.videoTrack ?? null}
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
    if (id === LOCAL_CAMERA) {
      if (!local?.camera) return null;
      return (
        <LocalCameraTile
          name={local.name}
          identity={local.identity}
          track={local.camera}
          isFullscreen={fullscreen.isFullscreen}
          onToggleFullscreen={toggle}
          pictureAction={pictureActionFor(id)}
          onPictureClick={() => clickPicture(id)}
        />
      );
    }
    if (id === LOCAL_SPOTLIGHT) {
      // Your own broadcast is on your stage for as long as it is on, so it
      // has no close: a click only enlarges it or brings the mosaic back.
      return (
        <div className="local-slot">
          {local?.renderStage({
            active: fullscreen.isFullscreen,
            toggle,
            onClose: pictureActionFor(id) ? () => clickPicture(id) : undefined,
            closeButton: false,
          })}
        </div>
      );
    }
    const screen = viewById.get(id)?.screen;
    if (!screen) return null;
    return (
      <RemoteTile
        screen={screen}
        micOn={micOn.has(viewOwner(id))}
        onToggleMic={() => toggleMic(id)}
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
        pictureAction={pictureActionFor(id)}
        onPictureClick={() => clickPicture(id)}
      />
    );
  }

  const [left, right] = mains;
  const splitLimits = pairSplitLimits(pairWidth);

  const mainsView =
    mains.length === 0 ? (
      // Nothing on the stage: screens wait in the channel list, cameras behind
      // the camera buttons, and your own preview is off.
      <section className="stage remote-empty">
        <div className="overlay">
          {local ? (
            <>
              <h2>{t('player.youreLive')}</h2>
              <p className="muted">{t('player.previewHidden')}</p>
            </>
          ) : (
            <>
              <h2>{t('grid.pickTitle')}</h2>
              <p className="muted">{t('grid.pickBody')}</p>
              {onStartSharing && (
                <div className="onboarding-actions">
                  <button className="primary" onClick={onStartSharing}>
                    {t('common.shareScreen')}
                  </button>
                </div>
              )}
            </>
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

  // A small movement is a click (watch, tuck the strip away, mute). Past the
  // threshold the strip follows the pointer and turns for whichever edge it is
  // nearest; releasing parks it there. Capture starts only then, so a click
  // still lands on its button.
  function onDockPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || dragSession.current) return;
    const target = event.target;
    if (target instanceof Element && target.closest('input, .thumb-action')) return;
    dragSession.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
    const move = (e: PointerEvent) => {
      const session = dragSession.current;
      if (!session || e.pointerId !== session.pointerId) return;
      if (!session.moved) {
        const distance = Math.hypot(e.clientX - session.startX, e.clientY - session.startY);
        if (distance < DOCK_DRAG_THRESHOLD_PX) return;
        session.moved = true;
        try {
          dockRef.current?.setPointerCapture(e.pointerId);
        } catch {
          // The window listeners still follow the pointer inside the window.
        }
      }
      e.preventDefault();
      const rect = areaRef.current?.getBoundingClientRect();
      if (!rect) return;
      setDrag({
        x: e.clientX,
        y: e.clientY,
        edge: stripEdgeAt(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height),
      });
    };
    const end = (e: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      if (dockListeners.current?.end === end) dockListeners.current = null;
      if (dockRef.current?.hasPointerCapture(e.pointerId)) {
        dockRef.current.releasePointerCapture(e.pointerId);
      }
      const session = dragSession.current;
      dragSession.current = null;
      if (!session || e.pointerId !== session.pointerId || !session.moved) {
        setDrag(null);
        return;
      }
      suppressClick.current = true;
      // The click is dispatched in this same task, before timers run. If the
      // pointer was released off the button and no click comes, this still
      // clears the flag so the next click is not swallowed.
      setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      const rect = areaRef.current?.getBoundingClientRect();
      const next = rect
        ? stripEdgeAt(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height)
        : edge;
      setEdge(next);
      store(STRIP_EDGE_KEY, next);
      setDrag(null);
    };
    dockListeners.current = { move, end };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  function onDockClickCapture(event: ReactMouseEvent) {
    if (!suppressClick.current) return;
    suppressClick.current = false;
    event.preventDefault();
    event.stopPropagation();
  }

  const stripOpen = fullscreen.isFullscreen
    ? stripShown && stripCount > 0
    : pipShown && pipIds.length > 0;
  // While the strip is in hand it already wears the edge under the pointer, so
  // the frames turn as soon as that edge changes. Releasing only parks it there.
  const dockEdge = drag?.edge ?? edge;

  return (
    <section className="broadcast-layout">
      {hoverPreview}
      {snapshotTakers}
      <div
        className={`stage-area dock-${dockEdge}${drag ? ' is-docking' : ''}${fullscreen.idle ? ' idle' : ''}`}
        data-dock-target={drag?.edge}
        ref={areaRef}
      >
        {mainsView}

        {/* Every sound plays here, once per person: what they share and their
            microphone, at their volume; the microphone only once turned on.
            Keyed by track so a tile moving between layouts does not restart
            it. */}
        {heard.map(({ owner, track, mic }, index) => {
          const setting = audioFor(owner);
          return (
            <ListenAudio
              key={track.sid ?? `${owner}:${index}`}
              track={track}
              audio={mic && !micOn.has(owner) ? { ...setting, muted: true } : setting}
            />
          );
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

        {/* Toggle toward the edge, thumbnails inward. A drag moves both. */}
        {toggleCount > 0 && (
          <div
            ref={dockRef}
            className={`thumb-dock${drag ? ' is-dragging' : ''}`}
            onPointerDown={onDockPointerDown}
            onClickCapture={onDockClickCapture}
          >
            <button
              className="thumb-toggle"
              onClick={toggleStrip}
              aria-expanded={!stripHidden}
              title={`${stripHidden ? t('grid.showStrip') : t('grid.hideStrip')} · ${t('grid.moveStrip')}`}
            >
              <Icon>
                <path d={stripHidden ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} />
              </Icon>
              {stripHidden ? `${toggleCount}` : null}
            </button>
            {stripOpen && (
              <div className="thumb-strip" title={t('grid.moveStrip')}>
                {fullscreen.isFullscreen ? (
                  <>
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
                  </>
                ) : (
                  pipIds.map((id) => renderThumb(id))
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
