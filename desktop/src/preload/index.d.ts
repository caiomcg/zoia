import type {
  PairingStatus,
  RoomsList,
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
  ReleaseInfo,
  AuthOutcome,
  ActionOutcome,
  AccountDevice,
  AdminAccount,
  AdminAction,
  IssuedCode,
} from '../shared/ipc';

export interface ZoiaBridge {
  pairing: {
    status(): Promise<PairingStatus>;
    onChange(cb: (status: PairingStatus) => void): () => void;
  };
  /** Your account (ADR 0031). Refusals come back as the server's error code. */
  account: {
    signIn(server: string, email: string, password: string): Promise<AuthOutcome>;
    /** Creates the account, pending approval, and signs in to it. */
    signUp(server: string, email: string, password: string): Promise<AuthOutcome>;
    /** Spends a reset code from an admin, then signs in with the new password. */
    redeem(server: string, code: string, password: string): Promise<AuthOutcome>;
    /** Asks the server who this machine is now: approval, role, waiting sign-ups. */
    refresh(): Promise<PairingStatus>;
    /** Signs out, and frees this machine's seat. */
    signOut(): Promise<PairingStatus>;
    changePassword(
      current: string,
      next: string,
    ): Promise<ActionOutcome<{ ok: boolean; signedOut: number }>>;
    devices(): Promise<ActionOutcome<AccountDevice[]>>;
    removeDevice(id: string): Promise<ActionOutcome<{ ok: boolean }>>;
  };
  /** Only answers for admins; the server checks every call. */
  admin: {
    accounts(): Promise<ActionOutcome<AdminAccount[]>>;
    act(
      id: string,
      action: AdminAction,
      role?: 'admin' | 'user',
    ): Promise<ActionOutcome<{ account?: AdminAccount } & Partial<IssuedCode>>>;
  };
  token: {
    /** A join token for a channel; the first channel when none is named. */
    get(room?: string): Promise<TokenResult>;
  };
  rooms: {
    /** Every channel, and the most the server will hold. */
    list(): Promise<RoomsList>;
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
    /** Screens with their pictures and every window open right now without one. */
    instant(): Promise<SourceInfo[]>;
    select(source: Pick<SourceInfo, 'id' | 'name' | 'processId'>): Promise<void>;
    /** A window's current title, or null once it is gone. */
    title(hwnd: number): Promise<string | null>;
    /** Fast resolution of League of Legends game and client windows via native Win32 window manager. */
    league(): Promise<{ game: SourceInfo | null; client: SourceInfo | null }>;
    /** The open shareable windows, without thumbnails: cheap enough to poll. */
    windows(): Promise<SourceInfo[]>;
  };
  /** The hardware-encoding path: ffmpeg + NVENC + WHIP, bypassing Chromium. */
  encoder: {
    start(options: {
      framerate: number;
      bitrate: number;
      /** The preset's resolution, which a larger window is scaled down to. */
      maxWidth?: number;
      maxHeight?: number;
      /** Windows 11's yellow outline around the captured window. */
      showBorder?: boolean;
      processId: number | null;
      /** The window to capture natively; null captures the whole screen. */
      hwnd: number | null;
      displayId?: string | null;
      /** A screen share is silent; a window share carries that app's audio. */
      withAudio: boolean;
      sourceName: string;
      sourceKind: SourceInfo['kind'];
    }): Promise<void>;
    stop(): Promise<void>;
    onStatus(cb: (status: EncoderStatus) => void): () => void;
  };
  /**
   * NVIDIA only: NVENC frames from the native capture, sent on the room's own
   * WebRTC connection by the renderer (livekit/native-video.ts).
   */
  nativeVideo: {
    start(options: {
      /** A window to capture, or null to capture the screen named by displayId. */
      hwnd: number | null;
      displayId: string | null;
      framerate: number;
      bitrate: number;
      maxWidth: number;
      maxHeight: number;
      showBorder: boolean;
    }): Promise<{ width: number; height: number; encoder: string }>;
    stop(): Promise<void>;
    requestKeyframe(): Promise<void>;
    /** Moves the running encoder to a new target bitrate, without a keyframe. */
    setBitrate(bitsPerSecond: number): Promise<void>;
    onError(cb: (message: string) => void): () => void;
  };
  device: {
    /** `error` is the server's code when refused, such as `name_taken`. */
    rename(name: string): Promise<{ ok: true; name: string } | { ok: false; error: string }>;
    /** Stores a picture for this device; resolves to its new version. */
    setAvatar(bytes: Uint8Array): Promise<{ ok: boolean; avatar: string }>;
    removeAvatar(): Promise<{ ok: boolean }>;
  };
  avatars: {
    /** Someone's picture as a data: URL, or null when they have none. */
    get(identity: string, version: string): Promise<string | null>;
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
    /** The running version's GitHub release, or null if it has none. */
    releaseNotes(): Promise<ReleaseInfo | null>;
  };
  app: {
    version(): Promise<string>;
    /** The OS this copy runs on; application audio is Windows-only. */
    platform: NodeJS.Platform;
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
  devTools: {
    /** Whether developer tools can be opened via shortcuts or UI. */
    isEnabled(): Promise<boolean>;
    setEnabled(value: boolean): Promise<boolean>;
    open(): Promise<void>;
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
