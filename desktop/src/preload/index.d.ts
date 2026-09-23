import type {
  PairingStatus,
  TokenResult,
  StageState,
  ClaimResult,
  SourceInfo,
  GpuStatus,
  IngressEndpoint,
  NvencStatus,
} from '../shared/ipc';

export interface ZoiaBridge {
  pairing: {
    status(): Promise<PairingStatus>;
    start(deviceName?: string): Promise<PairingStatus>;
    onChange(cb: (status: PairingStatus) => void): () => void;
  };
  token: {
    get(): Promise<TokenResult>;
  };
  stage: {
    get(): Promise<StageState>;
    claim(): Promise<ClaimResult>;
    release(): Promise<{ ok: boolean; released?: boolean }>;
  };
  sources: {
    list(): Promise<SourceInfo[]>;
    select(source: Pick<SourceInfo, 'id' | 'name' | 'processId'>): Promise<void>;
  };
  /** The hardware-encoding path: ffmpeg + NVENC + WHIP, bypassing Chromium. */
  nvenc: {
    start(options: {
      whipUrl: string;
      framerate: number;
      bitrate: number;
      processId: number | null;
      /** The window to capture natively; null captures the whole screen. */
      hwnd: number | null;
      /** A screen share is silent; a window share carries that app's audio. */
      withAudio: boolean;
    }): Promise<void>;
    stop(): Promise<void>;
    onStatus(cb: (status: NvencStatus) => void): () => void;
  };
  ingress: {
    get(): Promise<IngressEndpoint>;
    release(): Promise<{ ok: boolean; released: boolean }>;
  };
  device: {
    rename(name: string): Promise<{ ok: boolean; name: string }>;
  };
  gpu: {
    status(): Promise<GpuStatus>;
  };
  audio: {
    /** `processId: null` captures the whole system's output instead of one app. */
    start(processId: number | null): Promise<void>;
    stop(): Promise<void>;
    /** Each chunk is S16LE stereo PCM at 48kHz. Returns an unsubscribe function. */
    onChunk(cb: (chunk: Uint8Array) => void): () => void;
  };
}

declare global {
  interface Window {
    zoia: ZoiaBridge;
  }
}
