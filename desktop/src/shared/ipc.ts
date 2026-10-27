/**
 * The channel names and payload shapes shared between preload and renderer.
 * Kept in one file so the two sides cannot silently drift apart.
 */

export interface PairingStatus {
  paired: boolean;
  deviceName: string | null;
  /** Why this device is not signed in, or why the server could not be reached. */
  error: string | null;
  /**
   * The server this copy is pointed at, which the sign-in screen offers as
   * its address. Null until something supplies one: an earlier sign-in or
   * the build. Nothing secret is ever sent to the renderer.
   */
  serverUrl: string | null;
  /**
   * True when a stored credential is believed good but the server could not
   * be reached. Signing in again is not what fixes that; waiting is.
   */
  offline?: boolean;
  /** This device's id, which is also its identity in the room. */
  deviceId?: string | null;
  /** The version of this device's picture, or null without one. */
  avatar?: string | null;
  /** The account this machine is signed in to (ADR 0031); absent when signed out. */
  account?: AccountInfo;
}

export type AccountRole = 'user' | 'admin' | 'super_admin';
export type AccountState = 'pending' | 'active' | 'disabled';

/** Who a signed-in device is, as the server describes it. */
export interface AccountInfo {
  id: string;
  email: string;
  role: AccountRole;
  status: AccountState;
  /** Sign-ups waiting for an admin. Only sent to admins. */
  pendingApprovals?: number;
}

/** An account as an admin sees it. */
export interface AdminAccount {
  id: string;
  email: string;
  name: string;
  role: AccountRole;
  status: AccountState;
  createdAt: string;
  lastSeen: string | null;
  signupIp: string | null;
  devices: number;
  /** Their picture's version, and a machine of theirs to fetch it by. */
  avatar: string | null;
  avatarIdentity: string | null;
}

/** One of your own signed-in machines. */
export interface AccountDevice {
  id: string;
  name: string;
  createdAt: string;
  lastSeen: string | null;
  current: boolean;
}

export type AdminAction = 'approve' | 'reject' | 'disable' | 'enable' | 'reset' | 'role';

/** What some admin actions need: `role` the new role. */
export interface AdminActionOptions {
  role?: 'admin' | 'user';
}

/** A one-time code an admin hands on, to set a forgotten password. */
export interface IssuedCode {
  code: string;
  expiresAt: string;
}

/**
 * How an account request went. `error` is the server's code when it refused,
 * `unreachable` when there was no answer, or `invalid_server` for an address
 * that is not one; the renderer turns it into words.
 */
export type AuthOutcome = { ok: true; status: PairingStatus } | { ok: false; error: string };
export type ActionOutcome<T = undefined> = { ok: true; value: T } | { ok: false; error: string };

/** A channel, who is in it, and who is live there. */
export interface RoomInfo {
  id: string;
  name: string;
  /** Where clients that name no channel land. Renamable, never removable. */
  isDefault: boolean;
  /**
   * `avatar` is the version of their picture, when they have one; `role` is
   * there for admins and the super admin, from the server's own records.
   */
  participants: Array<{ identity: string; name: string; avatar?: string; role?: AccountRole }>;
  broadcasters: Array<{ identity: string; name: string }>;
}

/**
 * The channel list, the most channels the server holds, and who is asking as
 * the server sees them now — so a role given or taken away shows within one
 * poll rather than at the next account check.
 */
export interface RoomsList {
  rooms: RoomInfo[];
  max: number;
  /** The most channels an admin may allow; older servers do not say. */
  ceiling?: number;
  you?: { role: AccountRole; pendingApprovals?: number };
}

/** How a channel change went; `error` is the server's code when refused. */
export type ChannelOutcome = { ok: true } | { ok: false; error: string };

/** A text chat (ADR 0036). Not a room: everyone sees every chat. */
export interface ChatInfo {
  id: string;
  name: string;
  isDefault: boolean;
  /** Messages others wrote that you have not read, up to 100; null when unknown. */
  unread: number | null;
}

/** The chats, how many there may be, and whether messages can be reached. */
export interface ChatList {
  chats: ChatInfo[];
  max: number;
  /** The most the super admin may allow. */
  ceiling: number;
  /** False while the server's message database is not reachable. */
  available: boolean;
}

export interface ChatMessage {
  /** A time-based uuid: orders the messages and is the paging cursor. */
  id: string;
  chatId: string;
  /** The author's account id. */
  authorId: string;
  /** Empty when a photo or video is the whole message. */
  body: string;
  sentAt: string;
  attachment?: ChatAttachment | null;
  /** What it answers, as that message was: messages are never edited. */
  replyTo?: ChatReply | null;
  /** Who it @mentions, by the names written in it. */
  mentions?: ChatMention[];
}

/** The message a reply answers, kept with the reply. */
export interface ChatReply {
  id: string;
  authorId: string;
  authorName?: string | null;
  /** Its opening words, up to 200 characters; empty for a bare photo or video. */
  body?: string;
  kind?: 'image' | 'video' | null;
  /** The message answered was deleted since: nothing of it is kept. */
  deleted?: boolean;
}

/** Someone @mentioned, by the name they had when it was written. */
export interface ChatMention {
  id: string;
  name: string;
}

/** Someone who can be @mentioned. */
export interface ChatPerson {
  id: string;
  name: string;
  avatar: string | null;
}

/** What may go with a message beside its text. */
export interface ChatSendExtras {
  /** The id of the message it answers. */
  replyTo?: string;
  /** Account ids; the server keeps those whose @name is in the text. */
  mentions?: string[];
}

/** A photo or video sent in a chat, kept on the server's disk. */
export interface ChatAttachment {
  id: string;
  type: string;
  kind: 'image' | 'video';
  size: number;
  name: string | null;
}

/** The most a photo or video may be. Must match MEDIA_MAX_BYTES in server/src/chat-media.js. */
export const CHAT_MEDIA_MAX_BYTES = 10 * 1024 * 1024;

/** The scheme the window loads chat photos and videos from; see main/chat-media.ts. */
export const CHAT_MEDIA_SCHEME = 'zoia-media';

export const chatMediaUrl = (chatId: string, mediaId: string) =>
  `${CHAT_MEDIA_SCHEME}://file/${chatId}/${mediaId}`;

/** How an author is shown; null for an account that no longer exists. */
export type ChatAuthor = { name: string; avatar: string | null } | null;

/** A page of messages, newest first, with who wrote them and who read what. */
export interface ChatPage {
  messages: ChatMessage[];
  hasMore: boolean;
  /** Everyone the page mentions, as author or reader, by account id. */
  authors: Record<string, ChatAuthor>;
  /** Account id -> the last message id they have read. */
  readers: Record<string, string>;
}

/** What the server pushes while the app is listening. */
export type ChatEvent =
  | { type: 'message'; message: ChatMessage; author: ChatAuthor }
  | { type: 'read'; chatId: string; accountId: string; messageId: string; reader: ChatAuthor }
  | { type: 'chats' }
  /** A message deleted by its author or an admin. */
  | { type: 'deleted'; chatId: string; messageId: string }
  /** The stream itself: connected, or lost and retrying. */
  | { type: 'stream'; connected: boolean };

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

/** Updates come from the latest GitHub release of `repository`. */
export interface UpdaterConfig {
  repository: string;
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
  accountSignIn: 'zoia:account:sign-in',
  accountSignUp: 'zoia:account:sign-up',
  accountRedeem: 'zoia:account:redeem',
  accountRefresh: 'zoia:account:refresh',
  accountSignOut: 'zoia:account:sign-out',
  accountPassword: 'zoia:account:password',
  accountDevices: 'zoia:account:devices',
  accountRemoveDevice: 'zoia:account:devices:remove',
  adminAccounts: 'zoia:admin:accounts',
  adminAction: 'zoia:admin:action',
  adminMoveDevice: 'zoia:admin:moveDevice',
  adminKickDevice: 'zoia:admin:kickDevice',
  getToken: 'zoia:token:get',
  roomsList: 'zoia:rooms:list',
  roomsCreate: 'zoia:rooms:create',
  roomsRename: 'zoia:rooms:rename',
  roomsRemove: 'zoia:rooms:remove',
  roomsSetLimit: 'zoia:rooms:limit',
  chatList: 'zoia:chat:list',
  chatCreate: 'zoia:chat:create',
  chatRename: 'zoia:chat:rename',
  chatRemove: 'zoia:chat:remove',
  chatSetLimit: 'zoia:chat:limit',
  chatMessages: 'zoia:chat:messages',
  chatSend: 'zoia:chat:send',
  chatRead: 'zoia:chat:read',
  chatSendMedia: 'zoia:chat:media',
  chatListen: 'zoia:chat:listen',
  chatEvent: 'zoia:chat:event',
  chatAvatar: 'zoia:chat:avatar',
  chatPeople: 'zoia:chat:people',
  chatDeleteMessage: 'zoia:chat:deleteMessage',
  stageGet: 'zoia:stage:get',
  stageClaim: 'zoia:stage:claim',
  stageRelease: 'zoia:stage:release',
  sourcesList: 'zoia:sources:list',
  sourcesInstant: 'zoia:sources:instant',
  sourcesSelect: 'zoia:sources:select',
  sourcesTitle: 'zoia:sources:title',
  sourcesLeague: 'zoia:sources:league',
  sourcesWindows: 'zoia:sources:windows',
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
  nativeVideoBitrate: 'zoia:native-video:bitrate',
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
  appEmojiPanel: 'zoia:app:emojiPanel',
  trayCloseGet: 'zoia:tray:close:get',
  trayCloseSet: 'zoia:tray:close:set',
  devToolsGet: 'zoia:devtools:get',
  devToolsSet: 'zoia:devtools:set',
  devToolsOpen: 'zoia:devtools:open',
} as const;
