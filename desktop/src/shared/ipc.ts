/**
 * The channel names and payload shapes shared between preload and renderer.
 * Kept in one file so the two sides cannot silently drift apart.
 */

export interface PairingStatus {
  paired: boolean;
  deviceName: string | null;
  /** Set when a stored credential exists but was rejected — revoked or corrupt. */
  error: string | null;
}

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
  holder: StageHolder | null;
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
  /** Present when ok is false: who currently holds the stage. */
  holder: StageHolder | null;
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

export const QUALITY_PRESETS: QualityPreset[] = [
  {
    id: '720p60',
    label: '720p · 60fps',
    width: 1280,
    height: 720,
    maxFramerate: 60,
    maxBitrate: 5_000_000,
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
    id: '1440p60',
    label: '1440p · 60fps',
    width: 2560,
    height: 1440,
    maxFramerate: 60,
    maxBitrate: 20_000_000,
  },
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
];

export const DEFAULT_PRESET_ID = '1080p60';

export interface IngressEndpoint {
  ingressId: string;
  streamKey: string;
  url: string;
}

export interface NvencStatus {
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

/**
 * Messages exchanged directly between clients over LiveKit's data channel.
 * The token already grants canPublishData, so this needs no server round trip.
 */
export type RoomMessage =
  | { type: 'takeover-request'; from: string; fromName: string }
  | { type: 'takeover-granted'; to: string }
  | { type: 'takeover-denied'; to: string };

export interface GpuStatus {
  /** False on machines with no NVIDIA encoder, where GPU mode cannot work. */
  hardwareEncoder: boolean;
  windowCapture: boolean;
  /** Why the hardware path is unavailable, if it is. */
  encoderReason: string | null;
  /** True only when Chromium reports an actually-enabled hardware encoder. */
  hardwareEncoding: boolean;
  /** Raw Chromium status string, e.g. "enabled" or "disabled_software". */
  videoEncode: string;
  /** Human-readable active adapter, for telling a 4070 from a basic driver. */
  adapter: string;
}

export interface SourceInfo {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  thumbnailDataUrl: string;
  processId: number | null;
  /** Win32 window handle; the GPU path uses it to locate the window on screen. */
  hwnd: number | null;
}

export const IPC = {
  pairingStatus: 'zoia:pairing:status',
  pairingStart: 'zoia:pairing:start',
  getToken: 'zoia:token:get',
  stageGet: 'zoia:stage:get',
  stageClaim: 'zoia:stage:claim',
  stageRelease: 'zoia:stage:release',
  sourcesList: 'zoia:sources:list',
  sourcesSelect: 'zoia:sources:select',
  audioStart: 'zoia:audio:start',
  audioStop: 'zoia:audio:stop',
  audioChunk: 'zoia:audio:chunk',
  gpuStatus: 'zoia:gpu:status',
  report: 'zoia:report',
  nvencStart: 'zoia:nvenc:start',
  nvencStop: 'zoia:nvenc:stop',
  nvencStatus: 'zoia:nvenc:status',
  ingressGet: 'zoia:ingress:get',
  ingressRelease: 'zoia:ingress:release',
  renameDevice: 'zoia:device:rename',
} as const;
