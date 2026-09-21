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

export interface SourceInfo {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  thumbnailDataUrl: string;
  processId: number | null;
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
} as const;
