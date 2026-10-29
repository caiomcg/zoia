import type { ShortcutAction, ShortcutEvent, ShortcutsState } from '../shared/shortcuts';
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
  AdminActionOptions,
  IssuedCode,
  ChatList,
  ChatPage,
  ChatMessage,
  ChatAuthor,
  ChatPerson,
  ChatCommand,
  ChatSendExtras,
  ChatEvent,
  AddonInfo,
  AddonOutcome,
  AddonPreview,
  Presence,
  PresenceState,
} from '../shared/ipc';
import type { SoundPage } from '../shared/soundboard';

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
  /** Addons (ADR 0041). Only answers for the super admin; the server checks every call. */
  addons: {
    list(): Promise<AddonOutcome<{ addons: AddonInfo[]; available: boolean }>>;
    /** What installing a repository's latest release would mean. Installs nothing. */
    preview(repo: string): Promise<AddonOutcome<AddonPreview>>;
    /** Installs the release previewed; refused if it changed since. */
    install(repo: string, version: string): Promise<AddonOutcome<AddonInfo>>;
    enable(id: string): Promise<AddonOutcome<AddonInfo>>;
    disable(id: string): Promise<AddonOutcome<AddonInfo>>;
    /** To its latest release; `grant` agrees to permissions it adds. */
    update(id: string, grant: boolean): Promise<AddonOutcome<AddonInfo>>;
    uninstall(id: string): Promise<AddonOutcome<{ ok: boolean }>>;
    /** Values by key; a key left out keeps its value, null clears it. */
    settings(id: string, values: Record<string, unknown>): Promise<AddonOutcome<AddonInfo>>;
    /** What each command is typed as, for everyone; null puts one back. */
    commands(id: string, names: Record<string, string | null>): Promise<AddonOutcome<AddonInfo>>;
    /** The chats it listens to, as a whole. */
    chats(id: string, chats: string[]): Promise<AddonOutcome<AddonInfo>>;
    logs(id: string): Promise<AddonOutcome<string>>;
  };
  /** Only answers for admins; the server checks every call. */
  admin: {
    accounts(): Promise<ActionOutcome<AdminAccount[]>>;
    act(
      id: string,
      action: AdminAction,
      options?: AdminActionOptions,
    ): Promise<ActionOutcome<{ account?: AdminAccount } & Partial<IssuedCode>>>;
    /** Asks a machine (a participant identity) in a channel to switch to another. */
    moveDevice(id: string, channel: string): Promise<ActionOutcome<{ moved: boolean }>>;
    /** Takes one machine off the server: out of its channel and the chat. Not a ban. */
    kickDevice(id: string): Promise<ActionOutcome<{ kicked: boolean }>>;
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
    /** How many channels there may be, the default included. Admins only. */
    setLimit(max: number): Promise<ChannelOutcome>;
  };
  stage: {
    get(): Promise<StageState>;
    claim(): Promise<ClaimResult>;
    release(): Promise<{ ok: boolean; released?: boolean }>;
  };
  /** Voice in the current channel (ADR 0039). */
  voice: {
    /** Grants the microphone; false when this machine is not in the room yet. */
    join(): Promise<boolean>;
    leave(): Promise<{ ok: boolean }>;
    /** Silences every sound Zoia plays, in every window, or lets it play again. */
    deafen(deafened: boolean): Promise<void>;
  };
  /**
   * The global shortcuts: voice's (ADR 0039) and the soundboard pads'
   * (ADR 0040). Keys and mouse buttons, from anywhere.
   */
  shortcuts: {
    get(): Promise<ShortcutsState>;
    /** Takes the next keys or button held together; null if cancelled. */
    record(action: ShortcutAction): Promise<ShortcutsState | null>;
    cancel(): Promise<void>;
    clear(action: ShortcutAction): Promise<ShortcutsState>;
    onFire(cb: (event: ShortcutEvent) => void): () => void;
  };
  /** Sounds from Myinstants (ADR 0040), read by main and kept on this machine. */
  soundboard: {
    /** One page of a search, from 1; null when Myinstants could not be reached. */
    search(query: string, page: number): Promise<SoundPage | null>;
    /** A sound's file; null for a link that is not Myinstants' or cannot be fetched. */
    sound(url: string): Promise<Uint8Array | null>;
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
  /** Text chats (ADR 0036). Refusals come back as the server's error code. */
  chat: {
    list(): Promise<ActionOutcome<ChatList>>;
    create(name: string): Promise<ActionOutcome>;
    rename(id: string, name: string): Promise<ActionOutcome>;
    remove(id: string): Promise<ActionOutcome>;
    /** The super admin only. */
    setLimit(max: number): Promise<ActionOutcome>;
    /** Newest first; `before` is the oldest message already shown. */
    messages(chatId: string, before?: string): Promise<ActionOutcome<ChatPage>>;
    send(
      chatId: string,
      body: string,
      extras?: ChatSendExtras,
    ): Promise<ActionOutcome<{ message: ChatMessage; author: ChatAuthor }>>;
    /** A photo or video as a message of its own, up to 10 MB, with an optional caption. */
    sendMedia(
      chatId: string,
      bytes: Uint8Array,
      name: string,
      caption: string,
      extras?: ChatSendExtras,
    ): Promise<ActionOutcome<{ message: ChatMessage; author: ChatAuthor }>>;
    /** Everyone who can be @mentioned. */
    people(): Promise<ActionOutcome<ChatPerson[]>>;
    /** The ! commands this chat offers, under this server's names (ADR 0041). */
    commands(chatId: string): Promise<ActionOutcome<ChatCommand[]>>;
    /** Deletes a message: your own, or anyone's as an admin. */
    deleteMessage(chatId: string, messageId: string): Promise<ActionOutcome>;
    /** Edits a message of your own (ADR 0043); mentions are account ids, as when sending. */
    editMessage(
      chatId: string,
      messageId: string,
      body: string,
      mentions: string[],
    ): Promise<ActionOutcome<ChatMessage>>;
    /** Asks where, then saves a chat photo or video there; `saved` is false if not chosen. */
    saveMedia(
      chatId: string,
      mediaId: string,
      name: string | null,
      type: string,
    ): Promise<ActionOutcome<{ saved: boolean }>>;
    /** Adds your emoji to a message, or takes it off with `on` false. */
    react(chatId: string, messageId: string, emoji: string, on: boolean): Promise<ActionOutcome>;
    read(chatId: string, messageId: string): Promise<ActionOutcome>;
    /** Starts or stops the live stream of changes, which arrive through onEvent. */
    listen(on: boolean): Promise<void>;
    onEvent(cb: (event: ChatEvent) => void): () => void;
    /** An author's picture as a data: URL, or null when they have none. */
    avatar(accountId: string, version: string): Promise<string | null>;
  };
  /** Who is on the server (ADR 0038); changes arrive through chat.onEvent. */
  presence: {
    get(): Promise<ActionOutcome<PresenceState>>;
    set(status: Presence): Promise<ActionOutcome<{ status: Presence }>>;
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
    /** Opens the system's emoji picker over the focused field (Windows, macOS). */
    emojiPanel(): Promise<void>;
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
