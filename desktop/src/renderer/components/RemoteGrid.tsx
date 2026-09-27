import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { LocalVideoTrack, RemoteTrack } from 'livekit-client';
import type { RemoteScreen } from '../livekit/useRoom';
import Avatar from './Avatar';
import { IconFullscreen, IconHeadphones, IconVolume } from './Player';

/**
 * Every broadcast in the room, laid out one of two ways:
 *
 * - spotlight: one large, the rest as thumbnails;
 * - mosaic: all of them large. Two sit side by side with a draggable split;
 *   more form a grid.
 *
 * Nothing opens by itself. Someone joining sees a dark stage and every
 * broadcast as a blurred, silent thumbnail; they choose to watch one (it goes
 * large, with sound) or only to listen to it (it stays a blurred thumbnail,
 * moves to the front of the strip, and its audio plays). A broadcast that starts later joins the thumbnails too. In the
 * spotlight, watching replaces what is large; in the mosaic, it adds to it.
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

function sourceText(sourceName: string | null, sourceKind: RemoteScreen['sourceKind']): string {
  if (sourceName) return sourceName;
  if (sourceKind === 'camera') return 'Camera';
  if (sourceKind === 'window') return 'Window';
  return 'Screen';
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
    label: 'Spotlight',
    icon: (
      <Icon>
        <rect x="3" y="4" width="18" height="11" rx="1.5" />
        <path d="M4 19h4M10 19h4M16 19h4" />
      </Icon>
    ),
  },
  {
    mode: 'mosaic',
    label: 'Mosaic',
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
            <button
              className={`hq-toggle${hq ? ' active' : ''}`}
              onClick={onToggleHq}
              aria-pressed={hq}
              title={
                hq
                  ? 'High quality on — click to save bandwidth'
                  : 'Low quality — click to go back to high quality'
              }
            >
              HQ
            </button>
          )}
          <button
            className="icon-button"
            onClick={onToggleFullscreen}
            title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            <IconFullscreen active={isFullscreen} />
          </button>
          {!isFullscreen && (
            <button
              className="icon-button"
              onClick={onClose}
              title="Stop watching"
              aria-label="Stop watching"
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

function Thumbnail({
  name,
  label,
  liveVideo = null,
  snapshot = null,
  captureTrack = null,
  capture = false,
  onCaptured,
  audioTrack = null,
  audio,
  onAudioChange,
  listening = false,
  onWatch,
  onToggleListen,
  onStop,
}: {
  name: string;
  label: string;
  /** Your own preview, which costs no bandwidth, stays live and sharp. */
  liveVideo?: LocalVideoTrack | RemoteTrack | null;
  /** A remote broadcast shows its latest snapshot instead of live video. */
  snapshot?: string | null;
  captureTrack?: RemoteTrack | null;
  capture?: boolean;
  onCaptured?: (url: string | null) => void;
  audioTrack?: RemoteTrack | null;
  audio?: AudioSetting;
  onAudioChange?: (next: AudioSetting) => void;
  listening?: boolean;
  onWatch?: () => void;
  onToggleListen?: () => void;
  /** Your own preview: stop sharing, right from the strip. */
  onStop?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useMediaStream(videoRef, liveVideo, null);
  useSnapshot(captureTrack, capture, (url) => onCaptured?.(url));

  const volume = audio?.volume ?? DEFAULT_VOLUME;
  const muted = Boolean(audio?.muted);

  return (
    <div className={`thumb${listening ? ' listening' : ''}`} title={`${name} — ${label}`}>
      <button
        className="thumb-watch"
        onClick={onWatch}
        disabled={!onWatch}
        aria-label={`Watch ${name}`}
      >
        {liveVideo ? (
          <video className="thumb-live" ref={videoRef} playsInline autoPlay muted />
        ) : snapshot ? (
          <img src={snapshot} alt="" />
        ) : (
          <span className="thumb-blank" />
        )}
        <span className="thumb-label">
          <Avatar name={name} live />
          <span>{label}</span>
        </span>
      </button>
      {listening && onAudioChange && (
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
          aria-label={`Volume de ${name}`}
        />
      )}
      {onWatch && (
        <div className="thumb-actions">
          <button className="thumb-action" onClick={onWatch} title="Watch" aria-label="Watch">
            <Icon>
              <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
              <circle cx="12" cy="12" r="3" />
            </Icon>
          </button>
          {audioTrack && onToggleListen && (
            <button
              className={`thumb-action${listening ? ' active' : ''}`}
              onClick={onToggleListen}
              aria-pressed={listening}
              title={listening ? 'Stop listening' : 'Listen only'}
              aria-label={listening ? 'Stop listening' : 'Listen only'}
            >
              <IconHeadphones />
            </button>
          )}
          {onStop && (
            <button
              className="thumb-action danger"
              onClick={onStop}
              title="Stop sharing"
              aria-label="Stop sharing"
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
}: {
  screens: RemoteScreen[];
  /** Present while this device is broadcasting. */
  local?: {
    renderStage: (fullscreen: { active: boolean; toggle: () => void }) => ReactNode;
    track: LocalVideoTrack | null;
    name: string;
    onStop: () => void;
  };
  /** Called with the remote broadcasts shown large, which get full quality. */
  onFocusChange: (identities: string[]) => void;
  loadingBroadcasts?: LoadingBroadcast[];
  showOnboarding?: boolean;
  onStartSharing?: () => void;
  onDismissOnboarding?: () => void;
  /** Called with the remote broadcasts whose video should not be forwarded. */
  onPausedChange: (identities: string[]) => void;
}) {
  const [mode, setMode] = useState<LayoutMode>(() =>
    // 'pair' was a layout of its own; mosaic now does side by side.
    readStored(LAYOUT_KEY, ['spotlight', 'mosaic', 'pair'], 'spotlight') === 'spotlight'
      ? 'spotlight'
      : 'mosaic',
  );
  // Spotlight picks, most recently chosen first.
  const [pinned, setPinned] = useState<string[]>([]);
  const [audio, setAudio] = useState<Record<string, AudioSetting>>(readAudioSettings);
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
  const remoteMains = mains.filter((id) => id !== LOCAL_SPOTLIGHT);
  // Broadcasts the viewer only listens to: they stay thumbnails, with sound.
  const [listening, setListening] = useState<Set<string>>(new Set());
  // Broadcasts this viewer turned HQ off for. Per broadcast, not room-wide.
  const [lowQuality, setLowQuality] = useState<Set<string>>(new Set());
  // Latest thumbnail picture per broadcast, and which are being taken now.
  const [snapshots, setSnapshots] = useState<Record<string, { url: string | null; at: number }>>(
    {},
  );
  const [capturing, setCapturing] = useState<Set<string>>(new Set());

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
  // on the server, except for the moment a snapshot is being taken. With the
  // strip tucked away no snapshot can be taken, so all of them stay paused.
  // Listening only brings the sound; the thumbnail stays a blurred snapshot.
  const remoteThumbKey = screens
    .map((screen) => screen.participantIdentity)
    .filter((id) => !mains.includes(id))
    .join('|');
  const pausedKey = (remoteThumbKey ? remoteThumbKey.split('|') : [])
    .filter((id) => stripHidden || !capturing.has(id))
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
    if (stripHidden) {
      setCapturing((current) => (current.size === 0 ? current : new Set()));
      return;
    }
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
  }, [remoteThumbKey, stripHidden]);

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

  function watch(id: string) {
    if (fullId) setFullscreenId(id);
    else if (mode === 'mosaic')
      setPinned((current) => [...current.filter((other) => other !== id), id]);
    else setPinned([id]);
    // Watching includes the sound; listening-only no longer applies.
    setListening((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }

  function stopWatching(id: string) {
    setPinned((current) => current.filter((other) => other !== id));
  }

  function toggleListen(id: string) {
    const starting = !listening.has(id);
    setListening((current) => {
      const next = new Set(current);
      if (starting) next.add(id);
      else next.delete(id);
      return next;
    });
    // Choosing to listen means hearing it, whatever it was left at before.
    if (starting) {
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
    if (listening.has(id)) return 0;
    return id === LOCAL_SPOTLIGHT ? 1 : 2;
  }

  function audioFor(id: string): AudioSetting {
    return audio[id] ?? { volume: DEFAULT_VOLUME, muted: false };
  }

  if (candidates.length === 0) {
    return (
      <section className="stage remote-empty">
        <div className="overlay">
          {loadingBroadcasts.length > 0 ? (
            <>
              <h2>Loading broadcast…</h2>
              <p className="muted">
                {loadingBroadcasts.map((broadcast) => broadcast.name).join(', ')}{' '}
                {loadingBroadcasts.length === 1 ? 'is' : 'are'} live, but still loading.
              </p>
            </>
          ) : showOnboarding ? (
            <div className="onboarding-card">
              <p className="onboarding-step">You are in the room</p>
              <h2>Ready to start</h2>
              <p className="muted">
                Watch a live broadcast from the list beside you, or share your screen.
              </p>
              <ol className="onboarding-list">
                <li>
                  Click <strong>Share screen</strong>.
                </li>
                <li>Pick a window or a screen.</li>
              </ol>
              <div className="onboarding-actions">
                <button className="primary" onClick={onStartSharing}>
                  Share screen
                </button>
                <button className="link" onClick={onDismissOnboarding}>
                  Not now
                </button>
              </div>
            </div>
          ) : (
            <>
              <h2>Nobody is broadcasting</h2>
              <p className="muted">When someone shares, their broadcast appears here.</p>
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
              title="Remove from view"
              aria-label="Remove from view"
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

  const paired = !fullId && mode === 'mosaic' && mains.length === 2;
  const [left, right] = mains;

  const mainsView =
    mains.length === 0 ? (
      // Nothing chosen yet: a dark stage, the way in to sharing, and the
      // broadcasts waiting below.
      <section className="stage remote-empty">
        <div className="overlay">
          <h2>Pick a broadcast</h2>
          <p className="muted">
            Watch or just listen to one of the broadcasts below, or share your own.
          </p>
          {!local && onStartSharing && (
            <div className="onboarding-actions">
              <button className="primary" onClick={onStartSharing}>
                Share screen
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
          aria-valuemin={SPLIT_MIN * 100}
          aria-valuemax={SPLIT_MAX * 100}
          aria-valuenow={Math.round(split * 100)}
          title="Drag to resize · double-click to split evenly"
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

        {[...listening]
          .filter((id) => !mains.includes(id))
          .map((id) => {
            const track = screenById.get(id)?.audioTrack;
            return track ? <ListenAudio key={id} track={track} audio={audioFor(id)} /> : null;
          })}

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
              title={stripHidden ? 'Show broadcasts' : 'Hide broadcasts'}
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
                        label="Your broadcast"
                        liveVideo={local?.track ?? null}
                        onWatch={() => watch(id)}
                        onStop={local?.onStop}
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
                      snapshot={snapshots[id]?.url ?? null}
                      captureTrack={screen.videoTrack}
                      capture={capturing.has(id)}
                      onCaptured={(url) => captured(id, url)}
                      audioTrack={screen.audioTrack}
                      audio={audioFor(id)}
                      onAudioChange={(next) => updateAudio(id, next)}
                      listening={listening.has(id)}
                      onWatch={() => watch(id)}
                      onToggleListen={() => toggleListen(id)}
                    />
                  );
                })}
                {loadingThumbs.map((broadcast) => (
                  <Thumbnail key={broadcast.identity} name={broadcast.name} label="Loading…" />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
