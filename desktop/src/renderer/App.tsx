import { useCallback, useEffect, useRef, useState } from 'react';
import Banner from './components/Banner';
import CameraDialog from './components/CameraDialog';
import PairingScreen from './components/PairingScreen';
import Player from './components/Player';
import RemoteGrid, {
  type GridControls,
  type LoadingBroadcast,
  type StageState,
} from './components/RemoteGrid';
import Sidebar from './components/Sidebar';
import SourcePicker from './components/SourcePicker';
import SettingsDialog from './components/SettingsDialog';
import ReleaseNotesDialog from './components/ReleaseNotesDialog';
import Splash from './components/Splash';
import StatusLight, { type StatusStat, type StatusTone } from './components/StatusLight';
import { WHIP_SUFFIX, useRoom, type RoomMember } from './livekit/useRoom';
import { useGpuBroadcast } from './livekit/useGpuBroadcast';
import { useSoundCues } from './sounds/useSoundCues';
import { LAST_VERSION_STORAGE_KEY, shouldShowReleaseNotes } from './whats-new';
import { useExit } from './presence';
import { primeAvatar, publishAvatarVersions, type EncodedAvatar } from './avatars';
import {
  DEFAULT_PRESET_ID,
  QUALITY_PRESETS,
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
      isIngress: false,
      broadcastSource: null,
      avatar: p.avatar,
    }));
  return me ? [{ ...me, isBroadcasting: false, broadcastSource: null }, ...others] : others;
}

export default function App() {
  const t = useT();
  const [status, setStatus] = useState<PairingStatus | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(
    () => localStorage.getItem(ONBOARDING_STORAGE_KEY) !== 'true',
  );
  const [gpu, setGpu] = useState<GpuStatus | null>(null);
  const [stageError, setStageError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  // The channel this device is in, or wants to be in. None at launch: the app
  // lists the channels and joins one only when it is clicked.
  const [channel, setChannel] = useState<string | null>(null);
  const [channels, setChannels] = useState<RoomInfo[]>([]);
  const [maxChannels, setMaxChannels] = useState(0);
  const [channelError, setChannelError] = useState<string | null>(null);
  // Bumped to refetch the channel list right after a change, not at the next poll.
  const [channelsVersion, setChannelsVersion] = useState(0);
  const connectingRef = useRef(false);
  // The channel list finds broadcasts; the grid owns what the stage shows.
  const gridRef = useRef<GridControls>(null);
  const [stage, setStage] = useState<StageState>({ watching: [], localWatched: false });
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
  const gpuCast = useGpuBroadcast();
  const { setRemoteFocus, setRemotePaused } = room;

  // The rest of the app still thinks in terms of which path is publishing.
  // Only use GPU mode if the flag is active AND hardware encoding is supported.
  const mode: BroadcastMode = hardware && gpu?.hardwareEncoder ? 'gpu' : 'window';

  const preset =
    QUALITY_PRESETS.find((p) => p.id === presetId) ??
    QUALITY_PRESETS.find((p) => p.id === DEFAULT_PRESET_ID) ??
    QUALITY_PRESETS[0]!;

  const isLive = room.broadcastState === 'live' || gpuCast.state === 'live';
  const isStarting = room.broadcastState === 'starting' || gpuCast.state === 'starting';
  useSoundCues(room.members, room.state === 'connected', channel, isLive);

  useEffect(() => {
    window.zoia.pairing.status().then(setStatus);
    return window.zoia.pairing.onChange(setStatus);
  }, []);

  useEffect(() => {
    // Not written back to storage when there is no encoder: that would read
    // as the person having turned it off, and keep it off on a machine that
    // gains one. `mode` already requires an encoder.
    void window.zoia.gpu.status().then(setGpu);
  }, []);

  useEffect(() => {
    if (!status?.paired || channel === null || room.state !== 'idle' || connectingRef.current) {
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
  }, [status?.paired, room, channel, t]);

  // Who is in which channel, and who is live there, for the channel list.
  useEffect(() => {
    if (!status?.paired) return;
    let cancelled = false;
    const load = () =>
      window.zoia.rooms
        .list()
        .then(({ rooms, max }) => {
          if (cancelled) return;
          setChannels(rooms);
          setMaxChannels(max);
          setBooted(true);
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, ROOMS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [status?.paired, channel, room.state, channelsVersion]);

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
    if (!status?.paired || !booted || releaseNotesChecked.current) return;
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
  }, [status?.paired, booted, showOnboarding]);

  // Dialogs fade out however they are closed; see useExit. The notes are
  // kept while theirs fades, since the state holding them is already cleared.
  const picker = useExit(pickerOpen);
  const camera = useExit(cameraOpen);
  const settings = useExit(settingsOpen);
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

  if (!status) return <Splash />;
  if (!status.paired) return <PairingScreen status={status} onPaired={setStatus} />;
  if (!booted) return <Splash />;

  /** Messages are keyed by content, so a new one reappears after a dismissal. */
  const show = (key: string, text: string | null | undefined) =>
    text && !dismissed.has(`${key}:${text}`) ? text : null;
  const dismiss = (key: string, text: string) =>
    setDismissed((prev) => new Set(prev).add(`${key}:${text}`));

  async function handlePick(source: SourceInfo) {
    setPickerOpen(false);
    // Already live means this is a source switch, and the stage is ours to
    // keep — dropping and re-claiming it would put the viewer's picture out
    // for no reason, and briefly offer the stage to someone else.
    const switching = isLive;

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
    const ok = await gpuCast.start(preset, target);
    if (!ok) {
      console.warn('[gpu] GPU broadcast failed, falling back to window broadcast');
      try {
        const fallbackOk = await room.startBroadcast(target, preset, { keepStage: true });
        if (!fallbackOk) {
          await window.zoia.stage.release().catch(() => {});
        }
      } catch (fallbackErr) {
        await window.zoia.stage.release().catch(() => {});
        setStageError(fallbackErr instanceof Error ? fallbackErr.message : t('room.couldNotStart'));
      }
    }
  }

  async function stopSharing() {
    if (gpuCast.state !== 'idle') {
      await gpuCast.stop();
      await window.zoia.stage.release().catch(() => {});
    }
    if (room.broadcastState !== 'idle') await room.stopBroadcast();
  }

  const stats = room.videoStats;
  const encodingLive = Boolean(stats && (stats.fps > 0 || stats.kbps > 0));
  const gpuLive = gpuCast.state === 'live';
  const cameraLive = room.broadcastState === 'live' && room.sharingKind === 'camera';
  const screenLive = isLive && !cameraLive;

  /**
   * The camera button stands on its own, but it does not turn a camera on by
   * itself: it opens a preview so the device and microphone can be checked
   * before anything is published.
   */
  async function toggleCamera() {
    if (cameraLive) {
      await stopSharing();
      return;
    }
    setCameraOpen(true);
  }

  const connectionTone: StatusTone =
    room.state === 'connected' || hopping ? 'ok' : room.state === 'error' ? 'bad' : 'idle';

  // What the connection light's hover card lists: always the link to the
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

  const roomError = show('room', room.error);
  const roomNotice = show('room-notice', room.roomNotice);
  const broadcastError = show('broadcast', room.broadcastError);
  const gpuError = show('gpu', gpuCast.error);
  const audioWarning = show('audio', room.audioWarning);
  const stageMessage = show('stage', stageError);
  const channelMessage = show('channel', channelError);
  const gpuWarning = gpuLive ? show('gpustatus', gpuCast.status?.error) : null;
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
          {/* One light: the connection. Ping and, while sharing, how your
              broadcast is encoding are on its hover card. */}
          <StatusLight
            tone={connectionTone}
            label={t('top.connection', {
              state: t(`top.state.${hopping ? 'connected' : room.state}`),
            })}
            stats={connectionStats}
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

        <div className="topbar-right">
          <div className="share-icons" role="group" aria-label={t('top.whatToShare')}>
            <button
              className={`share-button${screenLive ? ' active' : ''}${hopping ? ' hopping' : ''}`}
              disabled={room.state !== 'connected' || isStarting}
              onClick={() => setPickerOpen(true)}
              title={screenLive ? t('top.screenTitleLive') : t('top.screenTitle')}
              aria-label={t('top.screenTitle')}
            >
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <rect x="2.5" y="4" width="19" height="13" rx="2" />
                <path d="M8 20.5h8" strokeLinecap="round" />
              </svg>
              {/* The label stays put when live: green and the dot say so, and
                  "Compartilhando" did not fit. */}
              <span className="share-label">{t('top.screen')}</span>
              {screenLive && <span className="share-live-dot" aria-hidden="true" />}
            </button>

            <button
              className={`share-button${cameraLive ? ' active' : ''}${hopping ? ' hopping' : ''}`}
              disabled={room.state !== 'connected' || isStarting}
              onClick={() => void toggleCamera()}
              title={cameraLive ? t('top.cameraTitleLive') : t('top.cameraTitle')}
              aria-label={t('top.cameraTitle')}
            >
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <rect x="2.5" y="6" width="13" height="12" rx="2" />
                <path d="M15.5 11l6-3.5v9l-6-3.5z" strokeLinejoin="round" />
              </svg>
              <span className="share-label">{t('top.camera')}</span>
              {cameraLive && <span className="share-live-dot" aria-hidden="true" />}
            </button>
          </div>
        </div>
      </header>

      {roomError && <Banner onDismiss={() => dismiss('room', roomError)}>{roomError}</Banner>}
      {roomNotice && (
        <Banner tone="warn" onDismiss={() => dismiss('room-notice', roomNotice)}>
          {roomNotice}
        </Banner>
      )}
      {broadcastError && (
        <Banner onDismiss={() => dismiss('broadcast', broadcastError)}>{broadcastError}</Banner>
      )}
      {gpuError && <Banner onDismiss={() => dismiss('gpu', gpuError)}>{gpuError}</Banner>}
      {stageMessage && (
        <Banner onDismiss={() => dismiss('stage', stageMessage)}>{stageMessage}</Banner>
      )}
      {channelMessage && (
        <Banner onDismiss={() => dismiss('channel', channelMessage)}>{channelMessage}</Banner>
      )}
      {audioWarning && (
        <Banner tone="warn" onDismiss={() => dismiss('audio', audioWarning)}>
          {audioWarning}
        </Banner>
      )}
      {gpuWarning && (
        <Banner tone="warn" onDismiss={() => dismiss('gpustatus', gpuWarning)}>
          {gpuWarning}
        </Banner>
      )}

      <div className="body">
        <main className="main">
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
              key={channel ?? 'none'}
              screens={room.remoteScreens}
              onFocusChange={setRemoteFocus}
              local={
                isLive
                  ? {
                      renderStage: ({ active, toggle, onClose }) => (
                        <Player
                          fullscreen={{ active, toggle }}
                          onClose={onClose}
                          name={status.deviceName ?? t('common.you')}
                          identity={myIdentity}
                          showPreview={showPreview}
                          onTogglePreview={togglePreview}
                          localTrack={room.localTrack}
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
                          onStop={() => void stopSharing()}
                          onSwitch={() => setPickerOpen(true)}
                        />
                      ),
                      // The strip's thumbnail follows the same choice.
                      track: showPreview ? room.localTrack : null,
                      showPreview,
                      onTogglePreview: togglePreview,
                      onStop: () => void stopSharing(),
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
        </main>

        <Sidebar
          members={
            // Out of every channel, the last room's list would hide its people
            // from the poll's, since the sidebar takes them for your own.
            channel === null
              ? []
              : hopping
                ? hopMembers(room.members, channels, channel)
                : room.members
          }
          myName={status.deviceName ?? t('common.you')}
          myIdentity={myIdentity}
          viewerIds={viewerIds}
          onOpenSettings={() => setSettingsOpen(true)}
          loadingRemoteIds={loadingRemoteIds}
          channels={channels}
          currentChannel={channel}
          onJoinChannel={(id) => void switchChannel(id)}
          onLeaveChannel={() => void leaveChannel()}
          maxChannels={maxChannels}
          onCreateChannel={(name) => void changeChannels(window.zoia.rooms.create(name))}
          onRenameChannel={(id, name) => void changeChannels(window.zoia.rooms.rename(id, name))}
          onRemoveChannel={(id) => void changeChannels(window.zoia.rooms.remove(id))}
          stage={{
            watching: new Set(stage.watching),
            localWatched: stage.localWatched,
          }}
          onHoverBroadcast={(target, anchor) => gridRef.current?.hover(target, anchor)}
          onWatchBroadcast={(target) => gridRef.current?.watch(target)}
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
          onStart={(constraints, muteMicrophone) => {
            setCameraOpen(false);
            // A camera always goes through the Chromium path: there is no
            // window for the hardware encoder to capture, and the frame is
            // small enough that it does not need one.
            void (async () => {
              if (isLive) await stopSharing();
              await room.startCamera(constraints, muteMicrophone);
            })();
          }}
          onCancel={() => setCameraOpen(false)}
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
