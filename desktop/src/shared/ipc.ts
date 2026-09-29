/**
 * The channel names and payload shapes shared between preload and renderer.
 * Kept in one file so the two sides cannot silently drift apart.
 */

export interface PairingStatus {
  paired: boolean;
  deviceName: string | null;
  /** Set when a stored credential exists but was rejected — revoked or corrupt. */
  error: string | null;
  /**
   * The server this copy is pointed at, so the pairing screen can show it
   * before anyone commits to joining. Null until an invite supplies one.
   * The pairing token itself is never sent to the renderer.
   */
  serverUrl: string | null;
  /**
   * True when there is nothing to pair with and the user has to supply an
   * invite. Distinct from `error`: a server that is merely unreachable is not
   * something an invite fixes, and saying so sends people hunting for a file.
   */
  needsInvite: boolean;
  /** This device's id, which is also its identity in the room. */
  deviceId?: string | null;
  /** The version of this device's picture, or null without one. */
  avatar?: string | null;
}

/** A channel, who is in it, and who is live there. */
export interface RoomInfo {
  id: string;
  name: string;
  /** Where clients that name no channel land. Renamable, never removable. */
  isDefault: boolean;
  /** `avatar` is the version of their picture, when they have one. */
  participants: Array<{ identity: string; name: string; avatar?: string }>;
  broadcasters: Array<{ identity: string; name: string }>;
}

/** How a channel change went; `error` is the server's code when refused. */
export type ChannelOutcome = { ok: true } | { ok: false; error: string };

export interface TokenResult {
  token: string;
  wsUrl: string;
  room: string;
  identity: string;
  name: string;
  quality?: {
    maxBitrate: number;
    maxFramerate: number;
    width: number;
    height: number;
    codec: string;
  };
}

export interface StageHolder {
  identity: string;
  name: string;
  publishing: boolean;
}

export interface StageState {
  broadcasters: StageHolder[];
  participants: Array<{
    identity: string;
    name: string;
    canPublish: boolean;
    publishing: boolean;
    joinedAt: number;
  }>;
}

export interface ClaimResult {
  ok: boolean;
  broadcaster?: StageHolder;
}

/**
 * What the broadcaster can pick from. Bitrates are chosen for screen content
 * (large flat areas, sharp text) rather than camera video, which is why they
 * run higher than typical camera ladders at the same resolution.
 */
export interface QualityPreset {
  id: string;
  label: string;
  width: number;
  height: number;
  maxFramerate: number;
  maxBitrate: number;
}

// Ordered best first, and 60fps before 30 at the same resolution, so the
// list reads downwards from "as good as it gets" rather than upwards from the
// fallback.
export const QUALITY_PRESETS: QualityPreset[] = [
  {
    id: '4k60',
    label: '4K · 60fps',
    width: 3840,
    height: 2160,
    maxFramerate: 60,
    maxBitrate: 40_000_000,
  },
  {
    id: '4k30',
    label: '4K · 30fps',
    width: 3840,
    height: 2160,
    maxFramerate: 30,
    maxBitrate: 30_000_000,
  },
  {
    id: '1440p60',
    label: '1440p · 60fps',
    width: 2560,
    height: 1440,
    maxFramerate: 60,
    maxBitrate: 20_000_000,
  },
  {
    id: '1440p30',
    label: '1440p · 30fps',
    width: 2560,
    height: 1440,
    maxFramerate: 30,
    maxBitrate: 14_000_000,
  },
  {
    id: '1080p60',
    label: '1080p · 60fps',
    width: 1920,
    height: 1080,
    maxFramerate: 60,
    maxBitrate: 12_000_000,
  },
  {
    id: '1080p30',
    label: '1080p · 30fps',
    width: 1920,
    height: 1080,
    maxFramerate: 30,
    maxBitrate: 8_000_000,
  },
  {
    id: '720p60',
    label: '720p · 60fps',
    width: 1280,
    height: 720,
    maxFramerate: 60,
    maxBitrate: 5_000_000,
  },
  {
    id: '720p30',
    label: '720p · 30fps',
    width: 1280,
    height: 720,
    maxFramerate: 30,
    maxBitrate: 3_000_000,
  },
];

export const DEFAULT_PRESET_ID = '1080p60';

/**
 * Where a hardware-encoded broadcast is published, and permission to do it.
 * Only ever held in the main process: the token is a credential to publish
 * into the room, and the renderer has no use for one.
 */
export interface WhipEndpoint {
  /** The SFU's own WHIP endpoint, derived server-side from LIVEKIT_WS_URL. */
  url: string;
  /** A short-lived LiveKit token allowing publish-only access. */
  token: string;
}

export interface EncoderStatus {
  running: boolean;
  fps: number;
  encoder: string;
  /** The real capture size: GPU mode encodes the desktop at its native size. */
  width: number;
  height: number;
  error: string | null;
}

/** Which encoding path a broadcast uses. */
export type BroadcastMode = 'gpu' | 'window';

export interface GpuStatus {
  /** False only when no hardware adapter was found at all. */
  hardwareEncoder: boolean;
  windowCapture: boolean;
  /** Why the hardware path is unavailable, if it is. */
  encoderReason: string | null;
  /** Human-readable active adapter, shown in the encoder tooltip. */
  adapter: string;
  /** nvidia / amd / intel — which encoder family this machine will use. */
  gpuVendor: string;
  /** nvenc, amf, qsv, or none. Shown rather than assuming every GPU is NVIDIA. */
  gpuEncoder: 'nvenc' | 'amf' | 'qsv' | 'none';
}

/** What the Language setting shows: the choice, and what it resolves to. */
export interface LanguageState {
  preference: 'system' | 'en' | 'es' | 'pt';
  /** The language in use now. */
  language: 'en' | 'es' | 'pt';
  /** What 'system' would resolve to, for the setting's label. */
  system: 'en' | 'es' | 'pt';
}

export interface UpdaterConfig {
  repository: string;
  branch: string;
  manifestPath: string;
  manifestUrl?: string;
  commitUrl?: string;
  checkOnStartup?: boolean;
  autoInstall?: boolean;
}

export type UpdaterCheckResult =
  | { status: 'up-to-date' }
  | { status: 'available'; version: string; notes: string | null }
  | { status: 'full-required'; version: string; installerUrl: string; notes: string | null }
  | { status: 'disabled' }
  | { status: 'error'; message: string };

/** A published release: the notes shown after an update and from About. */
export interface ReleaseInfo {
  version: string;
  title: string;
  /** ISO 8601, or null for a release GitHub has not dated. */
  publishedAt: string | null;
  /** The release notes, as GitHub-flavoured Markdown. */
  notes: string;
  url: string;
}

export interface SourceInfo {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  thumbnailDataUrl: string;
  processId: number | null;
  /** Full executable path of the window's owning process, when available. */
  processPath: string | null;
  /** Win32 window handle; the GPU path uses it to locate the window on screen. */
  hwnd: number | null;
  /** For a screen: Electron's display id, which the GPU path turns into a monitor. */
  displayId?: string | null;
}

export const IPC = {
  pairingStatus: 'zoia:pairing:status',
  pairingStart: 'zoia:pairing:start',
  pairingUseInvite: 'zoia:pairing:use-invite',
  pairingChooseInvite: 'zoia:pairing:choose-invite',
  getToken: 'zoia:token:get',
  roomsList: 'zoia:rooms:list',
  roomsCreate: 'zoia:rooms:create',
  roomsRename: 'zoia:rooms:rename',
  roomsRemove: 'zoia:rooms:remove',
  stageGet: 'zoia:stage:get',
  stageClaim: 'zoia:stage:claim',
  stageRelease: 'zoia:stage:release',
  sourcesList: 'zoia:sources:list',
  sourcesSelect: 'zoia:sources:select',
  sourcesTitle: 'zoia:sources:title',
  sourcesLeague: 'zoia:sources:league',
  languageGet: 'zoia:language:get',
  languageSet: 'zoia:language:set',
  audioStart: 'zoia:audio:start',
  audioStop: 'zoia:audio:stop',
  audioChunk: 'zoia:audio:chunk',
  gpuStatus: 'zoia:gpu:status',
  report: 'zoia:report',
  encoderStart: 'zoia:encoder:start',
  encoderStop: 'zoia:encoder:stop',
  encoderStatus: 'zoia:encoder:status',
  nativeVideoStart: 'zoia:native-video:start',
  nativeVideoStop: 'zoia:native-video:stop',
  nativeVideoKeyframe: 'zoia:native-video:keyframe',
  nativeVideoPort: 'zoia:native-video:port',
  nativeVideoError: 'zoia:native-video:error',
  renameDevice: 'zoia:device:rename',
  setAvatar: 'zoia:device:avatar:set',
  removeAvatar: 'zoia:device:avatar:remove',
  avatarGet: 'zoia:avatar:get',
  updaterConfigGet: 'zoia:updater:config:get',
  updaterConfigSave: 'zoia:updater:config:save',
  updaterConfigReset: 'zoia:updater:config:reset',
  updaterCheck: 'zoia:updater:check',
  updaterInstall: 'zoia:updater:install',
  updaterOpenInstaller: 'zoia:updater:installer:open',
  updaterReleaseNotes: 'zoia:updater:release-notes',
  appVersion: 'zoia:app:version',
  trayCloseGet: 'zoia:tray:close:get',
  trayCloseSet: 'zoia:tray:close:set',
  devToolsGet: 'zoia:devtools:get',
  devToolsSet: 'zoia:devtools:set',
  devToolsOpen: 'zoia:devtools:open',
} as const;
