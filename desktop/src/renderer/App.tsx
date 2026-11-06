import { useCallback, useEffect, useRef, useState } from 'react';
import BellAlerts from './components/BellAlerts';
import CameraDialog from './components/CameraDialog';
import AuthScreen from './components/AuthScreen';
import WaitingScreen from './components/WaitingScreen';
import Player from './components/Player';
import RemoteGrid, {
  type GridControls,
  type LoadingBroadcast,
  type StageState,
} from './components/RemoteGrid';
import Sidebar, { useSidebarCollapsed } from './components/Sidebar';
import ChatList from './components/ChatList';
import DirectList from './components/DirectList';
import { EventsPanel, EventCarousel, pinnedEvents, useNow } from './components/EventList';
import EventDialog from './components/EventDialog';
import { useSchedule } from './schedule/useSchedule';
import {
  listenForNotificationClicks,
  notify,
  setNotifyHandler,
  type NotifyTarget,
} from './notify/notify';
import type { ScheduledEvent } from '../shared/ipc';
import ChatTab from './components/ChatTab';
import ChatView from './components/ChatView';
import PeopleList from './components/PeopleList';
import { useChat } from './chat/useChat';
import { useThread } from './chat/useThread';
import ThreadPanel from './components/ThreadPanel';
import NotificationBell from './components/NotificationBell';
import { useDucked } from './voice/duck';
import { shownUnread } from './chat/silence';
import { useSilencedChats } from './chat/silence-store';
import { usePresence } from './chat/usePresence';
import SourcePicker from './components/SourcePicker';
import SettingsDialog, { type Section as SettingsSection } from './components/SettingsDialog';
import ReleaseNotesDialog from './components/ReleaseNotesDialog';
import Splash from './components/Splash';
import type { StatusStat, StatusTone } from './components/StatusLight';
import { WHIP_SUFFIX, useRoom, type RoomMember } from './livekit/useRoom';
import { useGpuBroadcast } from './livekit/useGpuBroadcast';
import { useVoice } from './voice/useVoice';
import VoiceAudio from './voice/VoiceAudio';
import { setPushToTalk } from './voice/pipeline';
import { playVoiceCue, VOICE_CUE_MS } from './sounds/synth';
import { getSoundSettings } from './sounds/settings';
import { useSoundCues, useViewerCues } from './sounds/useSoundCues';
import { useEntrance } from './soundboard/useEntrance';
import { useSoundboard } from './soundboard/useSoundboard';
import { shortcutSound } from '../shared/shortcuts';
import { LAST_VERSION_STORAGE_KEY, shouldShowReleaseNotes } from './whats-new';
import { useExit } from './presence';
import { primeAvatar, publishAvatarVersions, type EncodedAvatar } from './avatars';
import {
  DEFAULT_PRESET_ID,
  QUALITY_PRESETS,
  threadIdOf,
  threadParts,
  type BroadcastMode,
  type GpuStatus,
  type PairingStatus,
  type RoomInfo,
  type SourceInfo,
} from '../shared/ipc';
import { isLeagueSource } from '../shared/league';
import { useT } from './i18n';
import type { MessageKey } from '../shared/i18n';
import type { ReleaseInfo } from '../shared/ipc';

/** WebRTC's quality-limitation reasons, each with a translation. */
const LIMITS = ['none', 'cpu', 'bandwidth', 'other'] as const;
const PRESET_STORAGE_KEY = 'zoia.qualityPreset';
const HARDWARE_STORAGE_KEY = 'zoia.hardwareAcceleration';
const PREVIEW_STORAGE_KEY = 'zoia.showOwnPreview';
const ONBOARDING_STORAGE_KEY = 'zoia.onboardingDismissed';
/** How often the channel list (who is where, who is live) is refreshed. */
// The server answers this in ~10ms (measured), so polling often is cheap. At
// 5s a move between channels showed up late: the mover needs about a second
// to reach their new channel, after the immediate re-read had already run.
const ROOMS_POLL_MS = 2_000;
/** How long someone dragged is shown in their new channel before the server must agree. */
const PENDING_MOVE_MS = 6_000;
/** When to re-read the channels after a drag: about when the moved app has switched. */
const MOVE_RECHECK_MS = 1_200;
/**
 * How often a signed-in account asks the server who it is now: a rename, a
 * role change. Admins ask more often, since a sign-up is someone waiting.
 */
const ACCOUNT_POLL_MS = 30_000;
const ADMIN_POLL_MS = 10_000;

/**
 * Who to list in a channel being hopped to, before its room has connected:
 * the people the channel poll last saw there, plus this device. The old
 * room's list would otherwise sit under the new channel for a moment. The
 * identities match the room's own, so nobody re-animates when it arrives.
 */
function hopMembers(
  members: RoomMember[],
  channels: RoomInfo[],
  target: string | null,
): RoomMember[] {
  const me = members.find((member) => member.isLocal);
  const info = channels.find((c) => c.id === target);
  const broadcasting = new Set(info?.broadcasters.map((b) => b.identity.replace(WHIP_SUFFIX, '')));
  const others: RoomMember[] = (info?.participants ?? [])
    .filter((p) => !p.identity.endsWith(WHIP_SUFFIX) && p.identity !== me?.identity)
    .map((p) => ({
      identity: p.identity,
      name: p.name || p.identity,
      isLocal: false,
      isBroadcasting: broadcasting.has(p.identity),
      // The poll cannot tell a screen from a camera; the room says, soon.
      sharesScreen: broadcasting.has(p.identity),
      hasCamera: false,
      isIngress: false,
      broadcastSource: null,
      avatar: p.avatar,
      // The room says, as soon as it connects; until then, nobody is.
      inVoice: false,
      voiceMuted: true,
      voiceDeafened: false,
      // The poll says a bot is one, not whose; the room says, soon.
      bot: p.bot ? p.name : null,
    }));
  return me
    ? [
        {
          ...me,
          isBroadcasting: false,
          sharesScreen: false,
          hasCamera: false,
          broadcastSource: null,
        },
        ...others,
      ]
    : others;
}

export default function App({ preview = false }: { preview?: boolean }) {
  const demo = import.meta.env.DEV && preview;
  const t = useT();
  const [status, setStatus] = useState<PairingStatus | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('profile');
  const [showOnboarding, setShowOnboarding] = useState(
    () => localStorage.getItem(ONBOARDING_STORAGE_KEY) !== 'true',
  );
  const [gpu, setGpu] = useState<GpuStatus | null>(null);
  const [stageError, setStageError] = useState<string | null>(null);
  // The channel this device is in, or wants to be in. None at launch: the app
  // lists the channels and joins one only when it is clicked.
  const [channel, setChannel] = useState<string | null>(demo ? 'demo-stage' : null);
  const [channels, setChannels] = useState<RoomInfo[]>([]);
  // Running as administrator, where Windows will not let Zoia capture a
  // window (src/main/elevation.ts): said up front, with the way out.
  const [elevated, setElevated] = useState(false);
  useEffect(() => {
    window.zoia.app
      .elevated()
      .then(setElevated)
      .catch(() => {});
  }, []);
  // Your screen share, for the live card: what it is and since when.
  const [liveSource, setLiveSource] = useState<string | null>(null);
  const [liveSince, setLiveSince] = useState<number | null>(null);
  const [maxChannels, setMaxChannels] = useState(0);
  const [channelCeiling, setChannelCeiling] = useState(0);
  const [channelError, setChannelError] = useState<string | null>(null);
  // Being disconnected from the channel: told, in yellow, and gone after a while.
  const [channelNotice, setChannelNotice] = useState<string | null>(null);
  // Bumped to refetch the channel list right after a change, not at the next poll.
  const [channelsVersion, setChannelsVersion] = useState(0);
  const connectingRef = useRef(false);
  // The channel list finds broadcasts; the grid owns what the stage shows.
  const gridRef = useRef<GridControls>(null);
  const [stage, setStage] = useState<StageState>({
    watching: [],
    cameras: [],
    localWatched: false,
  });
  const [presetId, setPresetId] = useState(
    () => localStorage.getItem(PRESET_STORAGE_KEY) ?? DEFAULT_PRESET_ID,
  );
  // On unless someone turned it off: absent reads as on, and only a choice
  // made in Settings is ever stored, so an explicit "off" is always kept.
  // Machines without a hardware encoder fall back on their own (see `mode`).
  const [hardware, setHardware] = useState(
    () => localStorage.getItem(HARDWARE_STORAGE_KEY) !== 'false',
  );

  const handleHardwareChange = (enabled: boolean) => {
    setHardware(enabled);
    localStorage.setItem(HARDWARE_STORAGE_KEY, String(enabled));
  };

  const room = useRoom();
  const voice = useVoice(room.room, room.state);
  // Being in a channel is being in its voice (ADR 0039). Leaving the channel
  // leaves voice with it: the server forgets the participant. The away
  // channel is the exception (ADR 0044): nobody there talks or hears anyone,
  // and a channel made the away channel takes its people out of voice.
  const away = channels.some((c) => c.id === channel && c.away === true);
  const { join: joinVoice, leave: leaveVoice } = voice;
  useEffect(() => {
    if (room.state !== 'connected') return;
    void (away ? leaveVoice() : joinVoice());
  }, [room.state, away, joinVoice, leaveVoice]);
  // Mute and deafen, from the footer's buttons or the global shortcuts (ADR
  // 0039), each with a tone to say it happened: from a shortcut Zoia may well
  // be out of sight. Read through a ref, so the shortcut listener stays put
  // while mute and deafen change under it.
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const toggleMute = useCallback(() => {
    const current = voiceRef.current;
    // Without a microphone there is nothing to unmute, nor a tone to say so.
    if (current.state !== 'on' || current.noMicrophone) return;
    const volume = getSoundSettings().volume;
    if (current.muted) {
      // Unmuting while deafened undeafens too, which would silence a tone
      // played first: it plays once you can hear again.
      void current.setMuted(false).then(() => playVoiceCue('unmute', volume));
    } else {
      playVoiceCue('mute', volume);
      void current.setMuted(true);
    }
  }, []);
  const toggleDeafen = useCallback(() => {
    const current = voiceRef.current;
    if (current.state !== 'on') return;
    const volume = getSoundSettings().volume;
    if (current.deafened) {
      void current.setDeafened(false).then(() => playVoiceCue('undeafen', volume));
    } else {
      // Deafening silences every Zoia sound, its own tone included, so the
      // tone plays out first.
      playVoiceCue('deafen', volume);
      setTimeout(() => void voiceRef.current.setDeafened(true), VOICE_CUE_MS);
    }
  }, []);
  // Hear yourself is deafen while it is on (useVoice's setHearingSelf).
  const hearingSelf = useDucked();
  useEffect(() => {
    if (voiceRef.current.state !== 'on') return;
    void voiceRef.current.setHearingSelf(hearingSelf);
  }, [hearingSelf]);
  // The soundboard (ADR 0040): what others play, and playing to them.
  const soundboard = useSoundboard(room.room, room.state, voice);
  // The sound someone arrives with (ADR 0046), after their join cue.
  useEntrance(room.room, room.state, channel, voice, away);
  const { sendPad } = soundboard;
  useEffect(
    () =>
      window.zoia.shortcuts.onFire(({ action, pressed }) => {
        if (action === 'pushToTalk') setPushToTalk(pressed);
        else if (!pressed) return;
        else if (action === 'toggleMute') toggleMute();
        else if (action === 'toggleDeafen') toggleDeafen();
        else {
          const slug = shortcutSound(action);
          if (slug) sendPad(slug);
        }
      }),
    [toggleMute, toggleDeafen, sendPad],
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useSidebarCollapsed();
  const gpuCast = useGpuBroadcast();
  const { setRemoteFocus, setRemotePaused } = room;

  // The rest of the app still thinks in terms of which path is publishing.
  // Only use GPU mode if the flag is active AND hardware encoding is supported.
  const mode: BroadcastMode = hardware && gpu?.hardwareEncoder ? 'gpu' : 'window';

  const preset =
    QUALITY_PRESETS.find((p) => p.id === presetId) ??
    QUALITY_PRESETS.find((p) => p.id === DEFAULT_PRESET_ID) ??
    QUALITY_PRESETS[0]!;

  // A screen and a camera are shared independently, and either makes you live.
  const screenLive = room.broadcastState === 'live' || gpuCast.state === 'live';
  const cameraLive = room.cameraState === 'live';
  const isLive = screenLive || cameraLive;
  const isStarting =
    room.broadcastState === 'starting' ||
    gpuCast.state === 'starting' ||
    room.cameraState === 'starting';
  useSoundCues(room.members, room.state === 'connected', channel, isLive);
  // Only while live and connected: going live or reconnecting starts a fresh
  // baseline rather than announcing everyone already watching.
  useViewerCues(
    isLive && room.state === 'connected' ? room.viewers.map((viewer) => viewer.identity) : null,
  );

  // The camera gives the stage back on its own only when no screen is shared,
  // and the hardware screen is shared from here rather than from useRoom.
  const { setGpuScreen } = room;
  useEffect(() => {
    setGpuScreen(gpuCast.state !== 'idle');
  }, [gpuCast.state, setGpuScreen]);

  useEffect(() => {
    window.zoia.pairing.status().then(setStatus);
    return window.zoia.pairing.onChange(setStatus);
  }, []);

  // Signed in and let in: an account still waiting for approval is signed in
  // but can reach nothing, so nothing that talks to the room runs for it.
  const usable = Boolean(status?.paired) && status?.account?.status !== 'pending';
  const account = status?.account ?? null;
  const pendingApprovals = account?.pendingApprovals ?? 0;

  // By id: the account object is new after every refresh, and restarting the
  // timer each time would be harmless but pointless.
  const accountId = account?.id ?? null;
  // The poll below compares against this without restarting whenever the
  // account object changes, which is after every refresh.
  const accountRef = useRef(account);
  accountRef.current = account;
  const isAdmin = account?.role === 'admin' || account?.role === 'super_admin';
  useEffect(() => {
    if (!usable || !accountId) return;
    const every = isAdmin ? ADMIN_POLL_MS : ACCOUNT_POLL_MS;
    const timer = setInterval(() => void window.zoia.account.refresh(), every);
    return () => clearInterval(timer);
  }, [usable, accountId, isAdmin]);

  useEffect(() => {
    // Not written back to storage when there is no encoder: that would read
    // as the person having turned it off, and keep it off on a machine that
    // gains one. `mode` already requires an encoder.
    void window.zoia.gpu.status().then(setGpu);
  }, []);

  useEffect(() => {
    if (demo || !usable || channel === null || room.state !== 'idle' || connectingRef.current) {
      return;
    }
    connectingRef.current = true;
    window.zoia.token
      .get(channel)
      .then(({ wsUrl, token, quality }) => room.connect(wsUrl, token, quality))
      .catch(() => {
        // Removed since the list was read, or the server is unreachable:
        // back to no channel, rather than into one that was not clicked.
        setChannel(null);
        setHopping(false);
        setChannelError(t('channel.error.unreachable'));
        setChannelsVersion((v) => v + 1);
      })
      .finally(() => {
        connectingRef.current = false;
      });
  }, [demo, usable, room, channel, t]);

  // Who is in which channel, and who is live there, for the channel list.
  useEffect(() => {
    if (!usable) return;
    let cancelled = false;
    const load = () =>
      window.zoia.rooms
        .list()
        .then(({ rooms, max, ceiling, you }) => {
          if (cancelled) return;
          setChannels(rooms);
          setMaxChannels(max);
          setChannelCeiling(ceiling ?? max);
          setBooted(true);
          // Made or unmade an admin, or new sign-ups waiting: take it in now.
          const known = accountRef.current;
          if (
            you &&
            known &&
            (you.role !== known.role ||
              (you.pendingApprovals ?? 0) !== (known.pendingApprovals ?? 0))
          ) {
            void window.zoia.account.refresh();
          }
        })
        .catch((err: unknown) => {
          // Refused rather than unreachable: this machine was signed out or
          // its account disabled. Asking who it is now finds out at once,
          // instead of at the next account check, half a minute away.
          if (/\b40[13]\b/.test(String((err as Error)?.message ?? err))) {
            void window.zoia.account.refresh();
          }
        });
    load();
    const timer = setInterval(load, ROOMS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [usable, channel, room.state, channelsVersion]);

  // Someone joining or leaving this channel has also left or joined another,
  // and the poll would not show that for up to five seconds. Re-read now.
  const memberKey = room.members
    .map((m) => m.identity)
    .sort()
    .join(',');
  useEffect(() => {
    if (memberKey) setChannelsVersion((v) => v + 1);
  }, [memberKey]);

  const CHANNEL_ERRORS: Record<string, MessageKey> = {
    room_limit: 'channel.error.limit',
    invalid_limit: 'channel.error.limitRange',
    room_not_empty: 'channel.error.notEmpty',
    room_is_default: 'channel.error.isDefault',
    invalid_name: 'channel.error.invalidName',
    unknown_room: 'channel.error.unknown',
  };

  /** Runs a channel change, reports a refusal, and refreshes the list. */
  async function changeChannels(change: Promise<{ ok: boolean; error?: string }>) {
    try {
      const result = await change;
      setChannelError(
        result.ok ? null : t(CHANNEL_ERRORS[result.error ?? ''] ?? 'channel.error.generic'),
      );
    } catch {
      setChannelError(t('channel.error.unreachable'));
    }
    setChannelsVersion((v) => v + 1);
  }

  /**
   * Joins a channel, or moves this device to another one. A broadcast does
   * not follow you: sharing stops first, then the room is left, and the
   * effect above joins the new one. The channel is set before leaving so that
   * it never sees an idle room paired with the old channel and rejoins it.
   */
  async function switchChannel(id: string) {
    if (demo) {
      setChannel(id);
      return;
    }
    if (id === channel) return;
    if (channel === null) {
      // The first join from the list: a plain connect, shown as one.
      setChannel(id);
      return;
    }
    if (isLive || isStarting) await stopSharing();
    setHopping(true);
    setChannel(id);
    await room.disconnect();
  }

  // An admin took this machine out of its channel: out of every channel, and
  // say so, rather than a lost connection that would try again.
  const { removed, clearRemoved } = room;
  useEffect(() => {
    if (!removed) return;
    clearRemoved();
    setHopping(false);
    setChannel(null);
    setChannelNotice(t('channel.error.removed'));
    void room.disconnect();
    // Only a new removal acts; room is read as it is now.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [removed]);

  // Disconnected by the server (ADR 0037), by an admin or for sitting idle:
  // out of the channel, sharing stopped, and told why. Only the channel: the
  // chats and the channel list stay, and any channel can be joined again.
  const { kicked, clearKicked } = room;
  useEffect(() => {
    if (!kicked) return;
    clearKicked();
    void leaveChannel().then(() =>
      setChannelNotice(
        t(
          kicked === 'idle'
            ? 'channel.error.idle'
            : kicked === 'elsewhere'
              ? 'channel.error.elsewhere'
              : 'channel.error.removed',
        ),
      ),
    );
    // Only a new disconnect acts; leaveChannel is read as it is now.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kicked]);

  /**
   * Admins: takes someone off the server altogether. No confirmation: the
   * menu names who it is about, and they can reconnect at once.
   */
  async function kickMember(identity: string) {
    try {
      const outcome = await window.zoia.admin.kickDevice(identity);
      setChannelError(outcome.ok ? null : t('channel.error.kickFailed', { code: outcome.error }));
    } catch {
      setChannelError(t('channel.error.unreachable'));
    }
    setChannelsVersion((v) => v + 1);
  }

  // An admin moved this machine: go, the way a click would.
  const { moveRequest, clearMoveRequest } = room;
  useEffect(() => {
    if (!moveRequest) return;
    clearMoveRequest();
    void switchChannel(moveRequest.channel);
    // Only a new request moves; switchChannel is read as it is now.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moveRequest]);

  // Who was just dragged to which channel; see shownChannels.
  const [pendingMoves, setPendingMoves] = useState<ReadonlyMap<string, string>>(new Map());

  /**
   * Someone dropped on a channel in the sidebar. Yourself is a plain switch;
   * anyone else is an admin asking the server to move that machine, which
   * shows in the list once their app has switched.
   */
  async function moveMember(identity: string, id: string) {
    if (identity === myIdentity) return switchChannel(id);
    // Shown where they were dropped at once, rather than at the next poll;
    // a quick re-read shortly after picks up where they really are.
    setPendingMoves((previous) => new Map(previous).set(identity, id));
    const settle = () =>
      setPendingMoves((previous) => {
        if (previous.get(identity) !== id) return previous;
        const next = new Map(previous);
        next.delete(identity);
        return next;
      });
    setTimeout(settle, PENDING_MOVE_MS);
    setTimeout(() => setChannelsVersion((v) => v + 1), MOVE_RECHECK_MS);
    try {
      const outcome = await window.zoia.admin.moveDevice(identity, id);
      setChannelError(outcome.ok ? null : t('channel.error.moveFailed', { code: outcome.error }));
      if (!outcome.ok) settle();
    } catch {
      setChannelError(t('channel.error.unreachable'));
      settle();
    }
  }

  /**
   * The channel list with anyone just dragged already shown where they were
   * dropped, until the server's list catches up or the move is given up on.
   */
  const shownChannels =
    pendingMoves.size === 0
      ? channels
      : channels.map((c) => {
          const people = c.participants.filter((p) => !pendingMoves.has(p.identity));
          for (const [identity, to] of pendingMoves) {
            if (to !== c.id) continue;
            const person =
              channels
                .flatMap((other) => other.participants)
                .find((p) => p.identity === identity) ??
              room.members.find((m) => m.identity === identity);
            if (person) people.push({ identity, name: person.name });
          }
          return { ...c, participants: people };
        });

  /** Leaves the channel for none, the way the app starts. Sharing stops first. */
  async function leaveChannel() {
    if (channel === null) return;
    if (isLive || isStarting) await stopSharing();
    setHopping(false);
    setChannel(null);
    await room.disconnect();
  }

  // Held on the splash until the channel list first arrives, so a launch goes
  // straight from the logo to a populated list rather than an empty one.
  // Capped, so a slow or failing server still gets its say on screen.
  const [booted, setBooted] = useState(false);
  // From a click on another channel until its room is connected. The app is
  // still connected in every sense that matters to the person, so the hop
  // shows as a move, not as a disconnect and a fresh connect: no
  // "Connecting…", no dimmed buttons, and the new channel's people listed
  // from the channel poll straight away.
  const [hopping, setHopping] = useState(false);
  // Seeing your own broadcast is opt-in, and the choice is remembered.
  const [showPreview, setShowPreview] = useState(
    () => localStorage.getItem(PREVIEW_STORAGE_KEY) === 'true',
  );
  const togglePreview = () =>
    setShowPreview((current) => {
      localStorage.setItem(PREVIEW_STORAGE_KEY, String(!current));
      return !current;
    });
  useEffect(() => {
    if (room.state !== 'connected' && room.state !== 'error') return;
    setBooted(true);
    setHopping(false);
  }, [room.state]);
  useEffect(() => {
    const timer = setTimeout(() => setBooted(true), 8000);
    return () => clearTimeout(timer);
  }, []);

  // The notes of a version open by themselves on its first start, once the
  // app is in use rather than over the splash or pairing. The version is only
  // recorded once they have been read, so being offline on that start means
  // they appear on the next one instead of never.
  const [releaseNotes, setReleaseNotes] = useState<ReleaseInfo | null>(null);
  const releaseNotesChecked = useRef(false);
  useEffect(() => {
    if (!usable || !booted || releaseNotesChecked.current) return;
    releaseNotesChecked.current = true;
    void (async () => {
      const version = await window.zoia.app.version();
      let lastVersion: string | null = null;
      try {
        lastVersion = localStorage.getItem(LAST_VERSION_STORAGE_KEY);
      } catch {
        // Unreadable storage: treated as unknown, as on a first run.
      }
      const existingUser = !showOnboarding;
      const remember = () => {
        try {
          localStorage.setItem(LAST_VERSION_STORAGE_KEY, version);
        } catch {
          // Remembering is a convenience; at worst the notes show again.
        }
      };
      if (!shouldShowReleaseNotes(lastVersion, version, existingUser)) {
        remember();
        return;
      }
      const notes = await window.zoia.updater.releaseNotes();
      remember();
      if (notes?.notes.trim()) setReleaseNotes(notes);
    })().catch(() => {
      // Offline or rate-limited: try again on the next start.
    });
  }, [usable, booted, showOnboarding]);

  // Dialogs fade out however they are closed; see useExit. The notes are
  // kept while theirs fades, since the state holding them is already cleared.
  const picker = useExit(pickerOpen);
  const camera = useExit(cameraOpen);
  const settings = useExit(settingsOpen);

  /** Leaves the room first, so nobody is left watching a session that has ended. */
  async function handleSignOut() {
    setSettingsOpen(false);
    await leaveChannel();
    setStatus(await window.zoia.account.signOut());
  }

  // Signed out or disabled from elsewhere: out of the channel too, sharing
  // stopped, rather than left in a room the server no longer lets us use.
  useEffect(() => {
    if (status && !usable && channel !== null) void leaveChannel();
    // leaveChannel is a fresh function each render; what matters is the state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, usable, channel]);

  function openSettings(section: SettingsSection = 'profile') {
    setSettingsSection(section);
    setSettingsOpen(true);
  }
  const notesDialog = useExit(releaseNotes !== null);
  const [shownNotes, setShownNotes] = useState<ReleaseInfo | null>(null);
  if (releaseNotes && releaseNotes !== shownNotes) setShownNotes(releaseNotes);

  const handleRename = useCallback(
    async (name: string) => {
      // Stored server-side so it survives a restart, and pushed into the
      // room so everyone sees it now rather than after a reconnect.
      const result = await window.zoia.device.rename(name);
      if (!result.ok) {
        // Names are unique on a server; say so rather than "request failed".
        throw new Error(
          t(result.error === 'name_taken' ? 'profile.nameTaken' : 'profile.renameFailed'),
        );
      }
      setStatus((prev) => (prev ? { ...prev, deviceName: result.name } : prev));
      await room.setDisplayName(result.name).catch(() => {
        // The name is saved either way; it is picked up on the next join.
      });
    },
    [room, t],
  );

  // Who has which picture, for every avatar on screen. The channel poll
  // covers the other channels; this room's own participants are more current,
  // and this device's own record is the most current of all, so they go last.
  const myIdentity =
    room.members.find((member) => member.isLocal)?.identity ?? status?.deviceId ?? undefined;
  useEffect(() => {
    const entries: Array<[string, string | null | undefined]> = [];
    for (const c of channels) {
      for (const p of c.participants) entries.push([p.identity, p.avatar]);
    }
    for (const m of room.members) if (!m.isIngress) entries.push([m.identity, m.avatar]);
    if (status?.deviceId) entries.push([status.deviceId, status.avatar]);
    publishAvatarVersions(entries);
  }, [channels, room.members, status?.deviceId, status?.avatar]);

  /** Publishes a framed picture, or removes this device's picture (null). */
  const handleAvatarChange = useCallback(
    async (encoded: EncodedAvatar | null) => {
      let version: string | null = null;
      if (encoded) {
        version = (await window.zoia.device.setAvatar(encoded.bytes)).avatar;
        if (myIdentity) primeAvatar(myIdentity, version, encoded.url);
      } else {
        await window.zoia.device.removeAvatar();
        if (myIdentity) primeAvatar(myIdentity, null);
      }
      setStatus((prev) => (prev ? { ...prev, avatar: version } : prev));
      await room.setAvatar(version).catch(() => {
        // Saved either way; the next join's token carries it.
      });
    },
    [room, myIdentity],
  );

  // ---- text chat (ADR 0036) -----------------------------------------------
  // The main area shows the broadcasts or the chat. Tabs switch between them;
  // starting to watch brings the stage forward, and nothing else moves you.
  const [view, setView] = useState<'stage' | 'chat'>('chat');
  const [focused, setFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, []);
  const watchingSomething =
    stage.watching.length > 0 || stage.cameras.length > 0 || stage.localWatched;
  // Starting to watch something brings the stage forward; stopping leaves you
  // where you are, since the stage is where a channel is.
  const wasWatching = useRef(watchingSomething);
  useEffect(() => {
    if (watchingSomething && !wasWatching.current) setView('stage');
    wasWatching.current = watchingSomething;
  }, [watchingSomething]);
  // Joining or changing channels leaves you where you were: being in one is
  // being in its voice, not a wish to look at its stage. Out of every channel
  // there is only the chat.
  useEffect(() => {
    if (channel === null) setView('chat');
  }, [channel]);
  const [chatError, setChatError] = useState<string | null>(null);
  const chatShownIfEnabled = channel === null || view === 'chat';
  // The thread open beside the chat (ADR 0048), if any. It belongs to the chat
  // it was opened in: going to another chat puts it away (below).
  const [threadRoot, setThreadRoot] = useState<{ chatId: string; rootId: string } | null>(null);
  const chat = useChat({
    usable,
    me: accountId,
    visible: chatShownIfEnabled && focused,
    // Its replies are read as they arrive, as the open chat's messages are.
    openThreadId: threadRoot ? threadIdOf(threadRoot.chatId, threadRoot.rootId) : null,
    // A direct message, a reply in a direct chat's thread, or an @mention,
    // while you are not reading it.
    onNotify: ({ kind, chatId, message, author }) => {
      const name = author?.name ?? t('chat.someone');
      const where = chat.find(chatId);
      const body =
        message.body.replace(/\s+/g, ' ').trim().slice(0, 140) ||
        (message.attachment?.kind === 'video' ? t('chat.video') : t('chat.photo'));
      notify(
        {
          kind,
          // A person's messages, or a chat's mentions, are one entry under the bell.
          group: `${kind}:${chatId}`,
          title:
            kind === 'direct'
              ? t('notify.dmFrom', { name })
              : t('notify.mentionIn', { name, chat: where?.name ?? '' }),
          body,
          // A reply goes straight to its thread.
          target: { type: 'chat', id: chatId, thread: threadParts(message.chatId)?.rootId },
          actionLabel: t('notify.openChat'),
        },
        // A direct message already shows on the Chats tab and beside its
        // sender; the bell is for mentions and events.
        { bell: kind !== 'direct' },
      );
    },
  });
  const chatShown =
    chat.enabled && chatShownIfEnabled && (chat.openId !== null || channel === null);
  // Going to another chat puts its thread away.
  useEffect(() => {
    setThreadRoot((open) => (open && open.chatId === chat.openId ? open : null));
  }, [chat.openId]);
  const threadPanel = useThread({
    chatId: threadRoot?.chatId ?? null,
    rootId: threadRoot?.rootId ?? null,
    chatName: chat.openChat?.name ?? '',
    me: accountId,
    visible: chatShown && focused,
    available: chat.available,
    people: chat.mentionable,
    knownAuthors: chat.authors,
  });
  const silencedChats = useSilencedChats();
  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    tabsRef.current
      ?.querySelector('[role="tab"][aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [chat.openId, chatShown]);
  // Ctrl+Tab and Ctrl+Shift+Tab go round the tabs as the strip shows them:
  // the channel's first, while in one, then the chats, wrapping at the ends.
  const cycleTabsRef = useRef<(back: boolean) => void>(() => {});
  cycleTabsRef.current = (back) => {
    if (!chat.enabled) return;
    const strip: (string | null)[] = [...(channel !== null ? [null] : []), ...chat.tabs];
    if (strip.length < 2) return;
    const here = strip.indexOf(chatShown ? chat.openId : null);
    const next = strip[(Math.max(here, 0) + (back ? -1 : 1) + strip.length) % strip.length];
    if (next === null) {
      setView('stage');
    } else {
      chat.open(next as string);
      setView('chat');
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !e.ctrlKey || e.altKey || e.metaKey) return;
      e.preventDefault();
      cycleTabsRef.current(e.shiftKey);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // Who is on the server (ADR 0038), told on the chat's stream.
  const presence = usePresence({ usable: usable && chat.enabled, me: accountId });
  // An admin may rename you. The chat stream says so at once, so your own
  // name follows rather than waiting for the next account poll. Only when the
  // list changes: a rename of your own sets it first, and the list catches up.
  const myListedName = chat.people.find((p) => p.id === accountId)?.name;
  useEffect(() => {
    if (!myListedName) return;
    setStatus((prev) =>
      prev && prev.deviceName !== myListedName ? { ...prev, deviceName: myListedName } : prev,
    );
  }, [myListedName]);
  // Scheduled events (ADR 0050), told on the chat's stream like the rest. One
  // that starts is a notification (see notify.ts), with the way into its channel.
  const schedule = useSchedule({
    usable: usable && chat.enabled,
    onNotice: (event) => {
      const where = channels.find((c) => c.id === event.channelId);
      notify({
        kind: 'event',
        group: `event:${event.id}`,
        title: t('event.startingNow', { title: event.title }),
        body: where ? `#${where.name}` : (event.description ?? ''),
        target: { type: 'event', id: event.id, channelId: event.channelId },
        actionLabel: where ? t('event.join', { channel: where.name }) : t('event.details'),
      });
    },
  });
  // Following a notification, from the bell or from Windows: join its channel
  // and show it, or open its chat. Always the app as it is now, so a click long
  // after the notification arrived still does the right thing.
  const followRef = useRef<(target: NotifyTarget) => void>(() => {});
  followRef.current = (target) => {
    const join = (id: string) => {
      console.info(`[notify] joining channel ${id} (in ${channel ?? 'none'})`);
      void switchChannel(id);
      setView('stage');
    };
    if (target.type === 'chat') {
      chat.open(target.id);
      setThreadRoot(target.thread ? { chatId: target.id, rootId: target.thread } : null);
      setView('chat');
      return;
    }
    if (target.type === 'channel') return join(target.id);
    if (target.type === 'action') {
      if (target.id === 'restart-unelevated') void window.zoia.app.restartUnelevated();
      return;
    }
    // An event: into its channel when it has one that still exists; else the
    // event itself, to see where and when.
    const where = target.channelId ? channels.find((c) => c.id === target.channelId) : undefined;
    if (where) return join(where.id);
    const event = schedule.events.find((e) => e.id === target.id);
    if (event) setEventOpen(event);
  };
  // Set on every render, not once: nothing can leave a click with no handler.
  useEffect(() => setNotifyHandler((target) => followRef.current(target)));
  useEffect(() => listenForNotificationClicks(), []);
  // The event open in its dialog, or 'new' to schedule one.
  // The event open in its dialog, or a new one, maybe in a channel already.
  const [eventOpen, setEventOpen] = useState<
    ScheduledEvent | { new: true; channelId: string | null } | null
  >(null);
  const eventNow = useNow();
  // On now and coming up this week, in the sidebar's carousel.
  const pinned = schedule.enabled ? pinnedEvents(schedule.events, eventNow) : [];
  // Who has written to you and not been read, for a dot in the People tab.
  const unreadFrom = Object.fromEntries(
    chat.direct
      .filter((d) => d.peer && (d.unread ?? 0) > 0)
      .map((d) => [d.peer!.id, d.unread ?? 0]),
  );
  // The same, by name: a room knows people by machine, not account, and names
  // are unique on the server.
  const unreadByName = Object.fromEntries(
    chat.direct
      .filter((d) => d.peer && (d.unread ?? 0) > 0)
      .map((d) => [d.peer!.name, d.unread ?? 0]),
  );

  // When your screen went live, for the live card's clock. A switch keeps it;
  // only stopping the screen clears it.
  const screenIdle = room.broadcastState === 'idle' && gpuCast.state === 'idle';
  useEffect(() => {
    if (screenIdle) {
      setLiveSince(null);
      setLiveSource(null);
    } else if (screenLive) {
      setLiveSince((since) => since ?? Date.now());
    }
  }, [screenIdle, screenLive]);

  // Nobody shares in the away channel (ADR 0044): a channel made it while you
  // share there takes the share down.
  const sharingAnything = screenLive || cameraLive || gpuCast.state !== 'idle';
  useEffect(() => {
    if (away && sharingAnything) void stopSharing();
    // stopSharing is a new function each render; only these decide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [away, sharingAnything]);

  if (!status) return <Splash />;
  if (!status.paired) return <AuthScreen status={status} onSignedIn={setStatus} />;
  if (status.account?.status === 'pending') {
    return <WaitingScreen status={status} onChange={setStatus} />;
  }
  if (!booted) return <Splash />;

  async function handlePick(source: SourceInfo) {
    setPickerOpen(false);
    // For the live card: what is going out, in words.
    setLiveSource(source.name || null);
    // Already sharing a screen means this is a source switch, and the stage is
    // ours to keep — dropping and re-claiming it would put the viewer's
    // picture out for no reason, and briefly offer the stage to someone else.
    // A camera alone is not switched away: the screen joins it.
    const switching = screenLive;

    let target = source;
    if (isLeagueSource(source)) {
      const { game, client } = await window.zoia.sources
        .league()
        .catch(() => ({ game: null, client: null }));
      const resolved = game ?? client;
      if (resolved) target = resolved;
    }

    if (mode === 'window') {
      await room.startBroadcast(target, preset, { keepStage: switching });
      return;
    }

    // NVIDIA or AMD sharing a window or a screen: NVENC's or AMF's frames go
    // out on the room's own WebRTC connection, alongside the audio
    // (livekit/native-video.ts). Intel keeps the ffmpeg route below.
    const encodesNatively = gpu?.gpuEncoder === 'nvenc' || gpu?.gpuEncoder === 'amf';
    if (
      encodesNatively &&
      (target.kind === 'window' || (target.kind === 'screen' && target.displayId))
    ) {
      if (switching && gpuCast.state !== 'idle') await gpuCast.stop();
      const ok = await room.startBroadcast(target, preset, {
        keepStage: switching,
        nativeVideo: true,
      });
      if (ok) return;
      if (gpu?.gpuEncoder === 'nvenc') {
        console.warn('[native-video] failed, falling back to window broadcast');
        await room.startBroadcast(target, preset, { keepStage: switching });
        return;
      }
      // A Radeon whose AMF declined still has the ffmpeg route, which reads
      // the frames back and encodes them there — what every Radeon did before.
      console.warn('[native-video] AMF failed, falling back to the ffmpeg route');
    }

    if (!switching) {
      const claim = await window.zoia.stage.claim();
      if (!claim.ok) {
        setStageError(t('room.couldNotStart'));
        return;
      }
    }

    setStageError(null);
    room.setGpuScreen(true);
    const ok = await gpuCast.start(preset, target);
    if (!ok) {
      console.warn('[gpu] GPU broadcast failed, falling back to window broadcast');
      room.setGpuScreen(false);
      try {
        const fallbackOk = await room.startBroadcast(target, preset, { keepStage: true });
        if (!fallbackOk) await room.releaseStage();
      } catch (fallbackErr) {
        await room.releaseStage();
        setStageError(fallbackErr instanceof Error ? fallbackErr.message : t('room.couldNotStart'));
      }
    }
  }

  /** Stops the screen, leaving the camera on if it is. */
  async function stopScreen() {
    if (gpuCast.state !== 'idle') {
      await gpuCast.stop();
      // Told now rather than by the effect: stopCamera may run next.
      room.setGpuScreen(false);
      await room.releaseStage();
    }
    if (room.broadcastState !== 'idle') await room.stopBroadcast();
  }

  /** Stops everything this device shares. */
  async function stopSharing() {
    await stopScreen();
    if (room.cameraState !== 'idle') await room.stopCamera();
  }

  /** The player's stop: the screen if there is one, otherwise the camera. */
  async function stopMain() {
    if (room.broadcastState !== 'idle' || gpuCast.state !== 'idle') await stopScreen();
    else await room.stopCamera();
  }

  const stats = room.videoStats;
  const encodingLive = Boolean(stats && (stats.fps > 0 || stats.kbps > 0));
  const gpuLive = gpuCast.state === 'live';

  /**
   * The camera button stands on its own, but it does not turn a camera on by
   * itself: it opens a preview so the device and microphone can be checked
   * before anything is published. It never touches the screen.
   */
  async function toggleCamera() {
    if (cameraLive) {
      await room.stopCamera();
      return;
    }
    setCameraOpen(true);
  }

  const connectionTone: StatusTone =
    room.state === 'connected' || hopping ? 'ok' : room.state === 'error' ? 'bad' : 'idle';

  // What the voice bar's hover card lists: always the link to the
  // server, and while you are sharing, how your broadcast is being encoded.
  const connectionStats: StatusStat[] = [];
  if (room.state === 'connected' && room.pingMs !== null) {
    connectionStats.push({ label: t('stats.ping'), value: `${room.pingMs} ms` });
  }
  if (gpuLive) {
    const g = gpuCast.status;
    const encName = g?.encoder || gpu?.gpuEncoder || 'GPU';
    // What the broadcast is subscribed back as, which is the only measurement
    // this path has: ffmpeg publishes to the SFU itself, so there is no local
    // sender to read, and ffmpeg's own `fps=` is a running average that sits
    // frozen on the target after the first minute. Falls back to the preset
    // and to ffmpeg's average until the first two samples are in — about four
    // seconds — rather than showing a dash where a number belongs.
    const sent = room.ingressStats;
    connectionStats.push(
      {
        label: t('stats.encoder'),
        value: t('broadcast.encoderOn', {
          encoder: encName.toUpperCase(),
          adapter: gpu?.adapter || t('stats.theGpu'),
        }),
      },
      {
        label: t('stats.resolution'),
        value: g && g.width > 0 ? `${g.width}×${g.height}` : t('stats.starting'),
      },
      {
        label: t('stats.frameRate'),
        value:
          sent && sent.fps > 0
            ? `${sent.fps} fps`
            : g && g.width > 0
              ? `${Math.round(g.fps)} fps`
              : '—',
      },
      {
        label: t('stats.bitrate'),
        value:
          sent && sent.kbps > 0
            ? `${(sent.kbps / 1000).toFixed(1)} Mbps`
            : `${(preset.maxBitrate / 1e6).toFixed(0)} Mbps`,
      },
    );
  } else if (encodingLive && stats) {
    connectionStats.push(
      { label: t('stats.target'), value: preset.label },
      {
        label: t('stats.capture'),
        value: `${stats.captureWidth}×${stats.captureHeight} · ${stats.captureFps} fps`,
      },
      { label: t('stats.sending'), value: `${stats.width}×${stats.height} · ${stats.fps} fps` },
      { label: t('stats.bitrate'), value: `${(stats.kbps / 1000).toFixed(1)} Mbps` },
      { label: t('stats.encoder'), value: `${stats.encoder} (${stats.codec})` },
      {
        label: t('stats.limitedBy'),
        value: LIMITS.includes(stats.limitation as (typeof LIMITS)[number])
          ? t(`stats.limit.${stats.limitation as (typeof LIMITS)[number]}`)
          : stats.limitation,
      },
    );
  }

  // Windows refused to capture a window (E_ACCESSDENIED, in every capture
  // path's errors). Elevated, restarting fixes it; otherwise the window's own
  // program runs as administrator, and only a whole screen can be shared.
  const accessDenied = [room.broadcastError, gpuCast.error, stageError].some((e) =>
    e?.includes('0x80070005'),
  );
  const activeRemoteIds = new Set(room.remoteScreens.map((screen) => screen.participantIdentity));
  const loadingBroadcasts: LoadingBroadcast[] = room.members
    .filter(
      (member) =>
        member.isBroadcasting &&
        !member.isLocal &&
        room.selectedRemoteIds.has(member.identity) &&
        !activeRemoteIds.has(member.identity),
    )
    .map((member) => ({ identity: member.identity, name: member.name }));
  // Only while live: a stale list would say people are watching nothing.
  const viewerIds = new Set(isLive ? room.viewers.map((v) => v.identity) : []);
  const loadingRemoteIds = new Set(loadingBroadcasts.map((broadcast) => broadcast.identity));

  /** What an admin is told when the server refuses a chat change. */
  function chatErrorText(code: string): string {
    switch (code) {
      case 'chat_limit':
        return t('chat.error.limit');
      case 'invalid_name':
        return t('chat.error.name');
      case 'invalid_limit':
        return t('chat.error.limitRange');
      case 'forbidden':
        return t('chat.error.forbidden');
      case 'chat_unavailable':
        return t('chat.unavailable');
      default:
        return t('chat.error.generic');
    }
  }

  function dismissOnboarding() {
    setShowOnboarding(false);
    localStorage.setItem(ONBOARDING_STORAGE_KEY, 'true');
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-left">
          <img
            className="brand"
            src="logo.png"
            alt="Zoia"
            draggable={false}
            // Resolved against the loaded document rather than a root-absolute
            // path: under file:// a leading slash means the filesystem root,
            // not the folder the page was loaded from.
          />
        </div>

        <div className="topbar-centre">
          {room.isReconnecting ? (
            <span className="connection-message">{t('top.reconnecting')}</span>
          ) : isStarting ? (
            <span className="muted">{t('top.starting')}</span>
          ) : room.state === 'connecting' && !hopping ? (
            <span className="muted">{t('top.connecting')}</span>
          ) : null}
        </div>

        {/* Screen and camera live in the sidebar's voice bar now, with the
            rest of what you send (ADR 0039). Notifications sit at the top
            right, where they are looked for, whatever the sidebar shows. */}
        <div className="topbar-right">{usable && <NotificationBell />}</div>
      </header>

      {/* Everyone else in voice, heard while you are in it. */}
      <VoiceAudio tracks={voice.state === 'on' ? room.voiceTracks : []} />
      {/* Errors and warnings go under the bell, not over the window. */}
      <BellAlerts
        alerts={[
          { key: 'room', text: room.error },
          { key: 'voice', text: voice.error, tone: 'warn' },
          { key: 'room-notice', text: room.roomNotice, tone: 'warn' },
          { key: 'broadcast', text: room.broadcastError },
          { key: 'gpu', text: gpuCast.error },
          {
            key: accessDenied ? 'elevated-refused' : 'elevated',
            text: elevated ? t('elevated.message') : null,
            tone: 'warn',
            action: {
              target: { type: 'action', id: 'restart-unelevated' },
              label: t('elevated.restart'),
            },
          },
          {
            key: 'protected-window',
            text: !elevated && accessDenied ? t('capture.protectedWindow') : null,
            tone: 'warn',
          },
          { key: 'stage', text: stageError },
          { key: 'channel', text: channelError },
          // Cleared once told: the next disconnect, with the same words, is told too.
          {
            key: 'channel-notice',
            text: channelNotice,
            tone: 'warn',
            onTold: () => setChannelNotice(null),
          },
          { key: 'chat', text: chatError },
          { key: 'audio', text: room.audioWarning, tone: 'warn' },
          { key: 'gpustatus', text: gpuLive ? gpuCast.status?.error : null, tone: 'warn' },
        ]}
      />

      <div className="body">
        <main className={`main${chatShown ? ' chat-full' : ''}`}>
          {chat.enabled && (channel !== null || chat.tabs.length > 0) && (
            <div className="main-tabs" role="tablist" ref={tabsRef}>
              {channel !== null && (
                <button
                  role="tab"
                  aria-selected={!chatShown}
                  className={`main-tab${chatShown ? '' : ' current'}`}
                  onClick={() => setView('stage')}
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="16"
                    height="16"
                    aria-hidden="true"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <rect x="2.5" y="4" width="19" height="13" rx="2" />
                    <path d="M8 20.5h8" strokeLinecap="round" />
                  </svg>
                  {t('chat.tabStage')}
                </button>
              )}
              {chat.tabs.map((id) => {
                const info = chat.find(id);
                if (!info) return null;
                return (
                  <ChatTab
                    key={id}
                    chat={info}
                    current={chatShown && chat.openId === id}
                    unread={shownUnread(info, silencedChats)}
                    pinned={chat.pinnedTabs.includes(id)}
                    onOpen={() => {
                      chat.open(id);
                      setView('chat');
                    }}
                    onClose={() => {
                      chat.close(id);
                      if (chat.tabs.length === 1) setView('stage');
                    }}
                    onPin={(pinned) => chat.pin(id, pinned)}
                    onMove={(dragged) => chat.move(dragged, id)}
                  />
                );
              })}
            </div>
          )}
          <div className="main-panes">
            {chat.enabled && (
              <ChatView
                chat={chat}
                me={accountId}
                canModerate={isAdmin && !chat.openChat?.peer}
                visible={chatShown}
                onOpenThread={(message) =>
                  chat.openId && setThreadRoot({ chatId: chat.openId, rootId: message.id })
                }
                openThreadRootId={threadRoot?.rootId ?? null}
                aside={
                  threadRoot && (
                    <ThreadPanel
                      thread={threadPanel}
                      chatName={chat.openChat?.name ?? ''}
                      direct={Boolean(chat.openChat?.peer)}
                      me={accountId}
                      canModerate={isAdmin && !chat.openChat?.peer}
                      visible={chatShown}
                      onClose={() => setThreadRoot(null)}
                    />
                  )
                }
              />
            )}
            {/* Behind the chat rather than unmounted: what you watch keeps
              playing, and its sound with it, while you read. */}
            <div className={`main-pane${chatShown ? ' behind' : ''}`}>
              {/* Keyed by channel: what you watched or listened to in one channel
              means nothing in the next. */}
              {channel === null ? (
                <section className="stage remote-empty">
                  <div className="overlay">
                    <h2>{t('grid.noChannelTitle')}</h2>
                    <p className="muted">{t('grid.noChannelBody')}</p>
                  </div>
                </section>
              ) : (
                <RemoteGrid
                  // Choosing someone in the channel list, or its hover card, is
                  // asking to see them: from the chat too, whatever was on stage.
                  onShow={() => setView('stage')}
                  key={channel ?? 'none'}
                  screens={room.remoteScreens}
                  onFocusChange={setRemoteFocus}
                  local={
                    isLive
                      ? {
                          renderStage: ({ active, toggle, onClose, closeButton }) => (
                            <Player
                              fullscreen={{ active, toggle }}
                              onClose={onClose}
                              closeButton={closeButton}
                              name={status.deviceName ?? t('common.you')}
                              identity={myIdentity}
                              // Your camera alone is shown whatever the preview:
                              // it is always in your grid, to be seen.
                              showPreview={showPreview || !screenLive}
                              onTogglePreview={togglePreview}
                              localTrack={screenLive ? room.localTrack : room.cameraTrack}
                              mirrored={!screenLive}
                              gpuBroadcasting={gpuLive}
                              sendAudio={
                                room.sendingAudio
                                  ? {
                                      value: room.sendAudio,
                                      canSetVolume: room.canSetSendVolume,
                                      onChange: (next) => void room.setSendAudio(next),
                                    }
                                  : undefined
                              }
                              onStop={() => void stopMain()}
                              onSwitch={() => setPickerOpen(true)}
                            />
                          ),
                          // The strip's thumbnail and the overview follow the
                          // same choice: you only see yourself if you asked to.
                          track: showPreview
                            ? screenLive
                              ? room.localTrack
                              : room.cameraTrack
                            : null,
                          // A camera alone is the picture, and is shown mirrored.
                          mirrored: !screenLive,
                          showPreview,
                          onTogglePreview: togglePreview,
                          // Always in your grid while it is on, whatever the preview.
                          camera: room.cameraState === 'live' ? room.cameraTrack : null,
                          cameraIsMain: !screenLive,
                          onStop: () => void stopMain(),
                          name: status.deviceName ?? t('common.you'),
                          identity: myIdentity,
                        }
                      : undefined
                  }
                  loadingBroadcasts={loadingBroadcasts}
                  showOnboarding={showOnboarding && (room.state === 'connected' || hopping)}
                  onStartSharing={() => {
                    dismissOnboarding();
                    setPickerOpen(true);
                  }}
                  onDismissOnboarding={dismissOnboarding}
                  onPausedChange={setRemotePaused}
                  controlRef={gridRef}
                  onStageChange={setStage}
                />
              )}
            </div>
          </div>
        </main>

        <Sidebar
          collapsed={sidebarCollapsed}
          onCollapsedChange={setSidebarCollapsed}
          members={
            // Out of every channel, the last room's list would hide its people
            // from the poll's, since the sidebar takes them for your own.
            // Until a join connects, the room's list is still the last
            // room's (after a kick, say), so the poll's stands in for it.
            channel === null
              ? []
              : hopping || (room.state !== 'connected' && !room.isReconnecting)
                ? hopMembers(room.members, channels, channel)
                : room.members
          }
          myName={status.deviceName ?? t('common.you')}
          myIdentity={myIdentity}
          viewerIds={viewerIds}
          onOpenSettings={(section) => openSettings(section)}
          settingsBadge={pendingApprovals}
          myRole={account?.role}
          loadingRemoteIds={loadingRemoteIds}
          channels={shownChannels}
          currentChannel={channel}
          onJoinChannel={(id) => void switchChannel(id)}
          onLeaveChannel={() => void leaveChannel()}
          maxChannels={maxChannels}
          onCreateChannel={(name) => void changeChannels(window.zoia.rooms.create(name))}
          onRenameChannel={(id, name) => void changeChannels(window.zoia.rooms.rename(id, name))}
          onRemoveChannel={(id) => void changeChannels(window.zoia.rooms.remove(id))}
          onMoveMember={(identity, id) => void moveMember(identity, id)}
          stage={{
            watching: new Set(stage.watching),
            cameras: new Set(stage.cameras),
            localWatched: stage.localWatched,
          }}
          onToggleCamera={(identity) => gridRef.current?.toggleCamera(identity)}
          away={away}
          voice={{
            state: voice.state,
            muted: voice.muted,
            noMicrophone: voice.noMicrophone,
            deafened: voice.deafened,
            speaking: voice.speaking,
            onToggleMute: toggleMute,
            onToggleDeafen: toggleDeafen,
          }}
          soundboard={soundboard}
          connection={{
            tone: connectionTone,
            label: t('top.connection', {
              state: t(`top.state.${hopping ? 'connected' : room.state}`),
            }),
            stats: connectionStats,
          }}
          share={{
            screenLive,
            cameraLive,
            disabled: room.state !== 'connected' || isStarting || away,
            hopping,
            onScreen: () => setPickerOpen(true),
            onCamera: () => void toggleCamera(),
            live: {
              source: liveSource,
              since: liveSince,
              watching: viewerIds.size,
              onStop: () => void stopScreen(),
              onSwitch: () => setPickerOpen(true),
            },
          }}
          onHoverBroadcast={(target, anchor) => gridRef.current?.hover(target, anchor)}
          onWatchBroadcast={(target) => gridRef.current?.watch(target)}
          onKickMember={
            account?.role === 'admin' || account?.role === 'super_admin'
              ? (identity) => void kickMember(identity)
              : undefined
          }
          textChats={
            chat.enabled
              ? (collapsed) => (
                  <ChatList
                    chat={chat}
                    collapsed={collapsed}
                    showing={chatShown}
                    myRole={account?.role}
                    onOpen={(id) => {
                      chat.open(id);
                      setView('chat');
                    }}
                    onError={(code) => setChatError(chatErrorText(code))}
                  />
                )
              : undefined
          }
          unreadByName={unreadByName}
          onMessageMember={(name) => {
            const person = chat.people.find((p) => p.name === name && p.id !== accountId && !p.bot);
            if (!person) return;
            void chat.openDirect(person.id).then((refused) => {
              if (refused) setChatError(chatErrorText(refused));
              else setView('chat');
            });
          }}
          chats={
            chat.enabled
              ? (collapsed) => (
                  <>
                    <DirectList
                      chat={chat}
                      me={accountId}
                      collapsed={collapsed}
                      showing={chatShown}
                      onOpen={(id) => {
                        chat.open(id);
                        setView('chat');
                      }}
                      onShow={() => setView('chat')}
                      onError={(code) => setChatError(chatErrorText(code))}
                    />
                    {/* Who is around, under the conversations: click someone to write
                        to them (ADR 0038, 0047). Collapsed, the column is for channels. */}
                    {presence.enabled && !collapsed && (
                      <PeopleList
                        people={chat.people}
                        presence={presence}
                        me={accountId}
                        myRole={account?.role}
                        collapsed={collapsed}
                        unreadFrom={unreadFrom}
                        onMessage={(person) =>
                          void chat.openDirect(person.id).then((refused) => {
                            if (refused) setChatError(chatErrorText(refused));
                            else setView('chat');
                          })
                        }
                      />
                    )}
                  </>
                )
              : undefined
          }
          chatsBadge={
            chat.enabled
              ? {
                  // Direct messages alone: the chats everyone sees show their
                  // own counts on the Channels tab.
                  unread: chat.direct.reduce((sum, d) => sum + (d.unread ?? 0), 0),
                }
              : undefined
          }
          events={
            schedule.enabled
              ? {
                  count: schedule.events.length,
                  panel: (
                    <EventsPanel
                      events={schedule.events}
                      me={accountId}
                      now={eventNow}
                      onOpen={setEventOpen}
                      onNew={() => setEventOpen({ new: true, channelId: null })}
                    />
                  ),
                  card:
                    pinned.length > 0 ? (
                      <EventCarousel
                        events={pinned}
                        me={accountId}
                        channels={channels}
                        people={chat.people}
                        now={eventNow}
                        onJoin={(id) => void switchChannel(id)}
                        onAnswer={(event, answer) => void schedule.rsvp(event.id, answer)}
                      />
                    ) : null,
                }
              : undefined
          }
          onScheduleIn={
            schedule.enabled ? (id) => setEventOpen({ new: true, channelId: id }) : undefined
          }
          presence={presence.enabled ? presence : undefined}
        />
      </div>

      {picker.mounted && (
        <SourcePicker
          closing={picker.closing}
          onPick={handlePick}
          onCancel={() => setPickerOpen(false)}
          presetId={presetId}
          onPresetChange={(id) => {
            setPresetId(id);
            localStorage.setItem(PRESET_STORAGE_KEY, id);
          }}
        />
      )}

      {camera.mounted && (
        <CameraDialog
          closing={camera.closing}
          onStart={(constraints) => {
            setCameraOpen(false);
            // A camera always goes through the Chromium path: there is no
            // window for the hardware encoder to capture, and the frame is
            // small enough that it does not need one. Whatever screen is
            // shared stays shared; the camera joins it.
            void room.startCamera(constraints);
          }}
          onCancel={() => setCameraOpen(false)}
        />
      )}

      {eventOpen && (
        <EventDialog
          key={'new' in eventOpen ? `new:${eventOpen.channelId ?? ''}` : eventOpen.id}
          schedule={schedule}
          event={'new' in eventOpen ? null : eventOpen}
          newChannelId={
            'new' in eventOpen
              ? (eventOpen.channelId ??
                channels.find((c) => c.id === channel && !c.away)?.id ??
                null)
              : null
          }
          channels={channels}
          people={chat.people}
          me={accountId}
          isAdmin={isAdmin}
          onJoin={(id) => void switchChannel(id)}
          onClose={() => setEventOpen(null)}
        />
      )}

      {settings.mounted && (
        <SettingsDialog
          closing={settings.closing}
          onClose={() => setSettingsOpen(false)}
          myName={status.deviceName ?? t('common.you')}
          onRename={handleRename}
          myIdentity={myIdentity}
          hasAvatar={Boolean(status.avatar)}
          onAvatarChange={handleAvatarChange}
          hardwareDetail={
            gpu?.hardwareEncoder
              ? t('broadcast.encoderOn', {
                  encoder: (gpu.gpuEncoder ?? '').toUpperCase(),
                  adapter: gpu.adapter,
                })
              : (gpu?.encoderReason ?? t('broadcast.noEncoder'))
          }
          hardware={hardware}
          onHardwareChange={handleHardwareChange}
          hardwareAvailable={Boolean(gpu?.hardwareEncoder)}
          account={account}
          onSignOut={handleSignOut}
          onAccountsChanged={() => void window.zoia.account.refresh()}
          initialSection={settingsSection}
          away={{
            channels: channels.filter((c) => !c.isDefault),
            current: channels.find((c) => c.away)?.id ?? null,
            onChange: (id) => void changeChannels(window.zoia.rooms.setAway(id)),
          }}
          limits={{
            channels: {
              count: channels.length,
              max: maxChannels,
              ceiling: channelCeiling,
              onChange: (max) => void changeChannels(window.zoia.rooms.setLimit(max)),
            },
            chats: chat.enabled
              ? {
                  count: chat.chats.length,
                  max: chat.max,
                  ceiling: chat.ceiling,
                  onChange: (max) =>
                    void chat.setLimit(max).then((code) => {
                      if (code) setChatError(chatErrorText(code));
                    }),
                }
              : undefined,
          }}
        />
      )}

      {notesDialog.mounted && shownNotes && (
        <ReleaseNotesDialog
          closing={notesDialog.closing}
          release={shownNotes}
          onClose={() => setReleaseNotes(null)}
        />
      )}
    </div>
  );
}
