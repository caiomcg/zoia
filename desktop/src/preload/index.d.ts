import type {
  PairingStatus,
  RoomInfo,
  ChannelOutcome,
  TokenResult,
  StageState,
  ClaimResult,
  SourceInfo,
  GpuStatus,
  EncoderStatus,
  UpdaterConfig,
  LanguageState,
  UpdaterCheckResult,
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
    /** A join token for a channel; the first channel when none is named. */
    get(room?: string): Promise<TokenResult>;
  };
  rooms: {
    /** Every channel, and the most the server will hold. */
    list(): Promise<{ rooms: RoomInfo[]; max: number }>;
    create(name: string): Promise<ChannelOutcome>;
    rename(id: string, name: string): Promise<ChannelOutcome>;
    /** Only an empty channel that is not the default. */
    remove(id: string): Promise<ChannelOutcome>;
  };
  stage: {
    get(): Promise<StageState>;
    claim(): Promise<ClaimResult>;
    release(): Promise<{ ok: boolean; released?: boolean }>;
  };
  sources: {
    list(fresh?: boolean): Promise<SourceInfo[]>;
    select(source: Pick<SourceInfo, 'id' | 'name' | 'processId'>): Promise<void>;
    /** A window's current title, or null once it is gone. */
    title(hwnd: number): Promise<string | null>;
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
      sourceName: string;
      sourceKind: SourceInfo['kind'];
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
  updater: {
    config(): Promise<UpdaterConfig>;
    save(config: UpdaterConfig): Promise<UpdaterConfig>;
    reset(): Promise<UpdaterConfig>;
    check(): Promise<UpdaterCheckResult>;
    install(): Promise<void>;
    openInstaller(url: string): Promise<void>;
  };
  app: {
    version(): Promise<string>;
  };
  /** The interface language: the user's choice, and what it resolves to. */
  language: {
    get(): Promise<LanguageState>;
    set(preference: LanguageState['preference']): Promise<LanguageState>;
  };
  tray: {
    /** Whether closing the window hides it to the tray instead of quitting. */
    closeToTray(): Promise<boolean>;
    setCloseToTray(value: boolean): Promise<boolean>;
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
