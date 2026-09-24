import type {
  PairingStatus,
  TokenResult,
  StageState,
  ClaimResult,
  SourceInfo,
  GpuStatus,
  EncoderStatus,
} from '../shared/ipc';

export interface ZoiaBridge {
  pairing: {
    status(): Promise<PairingStatus>;
    start(deviceName?: string): Promise<PairingStatus>;
    /** Adopts an invite the user dropped on the window, by absolute path. */
    useInvite(path: string): Promise<PairingStatus>;
    /** Opens a file dialog; resolves to null if the user cancelled. */
    chooseInvite(): Promise<PairingStatus | null>;
    /** The on-disk path of a dropped File. Empty for anything not from disk. */
    pathForFile(file: File): string;
    onChange(cb: (status: PairingStatus) => void): () => void;
  };
  token: {
    get(): Promise<TokenResult>;
  };
  stage: {
    get(): Promise<StageState>;
    /** force ends a takeover the holder never answered. */
    claim(force?: boolean): Promise<ClaimResult>;
    release(): Promise<{ ok: boolean; released?: boolean }>;
  };
  sources: {
    list(): Promise<SourceInfo[]>;
    select(source: Pick<SourceInfo, 'id' | 'name' | 'processId'>): Promise<void>;
  };
  /** The hardware-encoding path: ffmpeg + NVENC + WHIP, bypassing Chromium. */
  encoder: {
    start(options: {
      framerate: number;
      bitrate: number;
      processId: number | null;
      /** The window to capture natively; null captures the whole screen. */
      hwnd: number | null;
      /** A screen share is silent; a window share carries that app's audio. */
      withAudio: boolean;
    }): Promise<void>;
    stop(): Promise<void>;
    onStatus(cb: (status: EncoderStatus) => void): () => void;
  };
  device: {
    rename(name: string): Promise<{ ok: boolean; name: string }>;
  };
  /** Sends a renderer-side failure to the server. */
  report(entry: { kind: string; message: string; stack?: string; context?: string }): void;
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
