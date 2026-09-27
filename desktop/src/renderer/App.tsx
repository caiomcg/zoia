import { useCallback, useEffect, useRef, useState } from 'react';
import Banner from './components/Banner';
import CameraDialog from './components/CameraDialog';
import PairingScreen from './components/PairingScreen';
import Player from './components/Player';
import RemoteGrid, { type LoadingBroadcast } from './components/RemoteGrid';
import Sidebar from './components/Sidebar';
import SourcePicker from './components/SourcePicker';
import SettingsDialog from './components/SettingsDialog';
import Splash from './components/Splash';
import StatusLight, { type StatusTone } from './components/StatusLight';
import { useRoom } from './livekit/useRoom';
import { useGpuBroadcast } from './livekit/useGpuBroadcast';
import {
  DEFAULT_PRESET_ID,
  QUALITY_PRESETS,
  type BroadcastMode,
  type GpuStatus,
  type PairingStatus,
  type RoomInfo,
  type SourceInfo,
} from '../shared/ipc';

const PRESET_STORAGE_KEY = 'zoia.qualityPreset';
const ONBOARDING_STORAGE_KEY = 'zoia.onboardingDismissed';
const CHANNEL_STORAGE_KEY = 'zoia.channel';
/** How often the channel list (who is where, who is live) is refreshed. */
const ROOMS_POLL_MS = 5_000;

function storeChannel(id: string) {
  try {
    localStorage.setItem(CHANNEL_STORAGE_KEY, id);
  } catch {
    // Remembering is a convenience; the channel still applies this session.
  }
}

function readChannel(): string | null {
  try {
    return localStorage.getItem(CHANNEL_STORAGE_KEY);
  } catch {
    return null;
  }
}

export default function App() {
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
  // The channel this device is in, or wants to be in; the last one it used.
  const [channel, setChannel] = useState<string | null>(readChannel);
  const [channels, setChannels] = useState<RoomInfo[]>([]);
  const [maxChannels, setMaxChannels] = useState(0);
  const [channelError, setChannelError] = useState<string | null>(null);
  // Bumped to refetch the channel list right after a change, not at the next poll.
  const [channelsVersion, setChannelsVersion] = useState(0);
  const connectingRef = useRef(false);
  const [presetId, setPresetId] = useState(
    () => localStorage.getItem(PRESET_STORAGE_KEY) ?? DEFAULT_PRESET_ID,
  );
  // Switched off for everyone for now; Settings shows it disabled. The GPU
  // path is the newer half of the app and the one that has broken on other
  // people's hardware. An earlier opt-in is still stored under
  // 'zoia.hardwareAcceleration', untouched, for when it comes back.
  const hardware = false;

  const room = useRoom();
  const gpuCast = useGpuBroadcast();
  const { setRemoteFocus, setRemotePaused } = room;

  // The rest of the app still thinks in terms of which path is publishing.
  const mode: BroadcastMode = hardware ? 'gpu' : 'window';

  const preset =
    QUALITY_PRESETS.find((p) => p.id === presetId) ??
    QUALITY_PRESETS.find((p) => p.id === DEFAULT_PRESET_ID) ??
    QUALITY_PRESETS[0]!;

  const isLive = room.broadcastState === 'live' || gpuCast.state === 'live';
  const isStarting = room.broadcastState === 'starting' || gpuCast.state === 'starting';

  useEffect(() => {
    window.zoia.pairing.status().then(setStatus);
    return window.zoia.pairing.onChange(setStatus);
  }, []);

  useEffect(() => {
    window.zoia.gpu.status().then(setGpu);
  }, []);

  useEffect(() => {
    if (!status?.paired || room.state !== 'idle' || connectingRef.current) return;
    connectingRef.current = true;
    window.zoia.token
      .get(channel ?? undefined)
      // A remembered channel the server no longer has: fall back to the first.
      .catch(() => window.zoia.token.get())
      .then(async ({ wsUrl, token, quality, room: joined }) => {
        if (joined !== channel) {
          setChannel(joined);
          storeChannel(joined);
        }
        await room.connect(wsUrl, token, quality);
      })
      .finally(() => {
        connectingRef.current = false;
      });
  }, [status?.paired, room, channel]);

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

  const CHANNEL_ERRORS: Record<string, string> = {
    room_limit: 'The server already has the most channels it allows.',
    room_not_empty: 'Only an empty channel can be deleted.',
    room_is_default: 'The main channel cannot be deleted.',
    invalid_name: 'Use a name of 1 to 32 characters.',
    unknown_room: 'That channel no longer exists.',
  };

  /** Runs a channel change, reports a refusal, and refreshes the list. */
  async function changeChannels(change: Promise<{ ok: boolean; error?: string }>) {
    try {
      const result = await change;
      setChannelError(
        result.ok ? null : (CHANNEL_ERRORS[result.error ?? ''] ?? 'Could not change the channel.'),
      );
    } catch {
      setChannelError('Could not reach the server.');
    }
    setChannelsVersion((v) => v + 1);
  }

  /**
   * Moves this device to another channel. A broadcast does not follow you:
   * sharing stops first, then the room is left, and the effect above joins
   * the new one. The channel is set before leaving so that it never sees an
   * idle room paired with the old channel and rejoins it.
   */
  async function switchChannel(id: string) {
    if (id === channel) return;
    if (isLive || isStarting) await stopSharing();
    setChannel(id);
    storeChannel(id);
    await room.disconnect();
  }

  // Held on the splash until the first connection settles, so a launch goes
  // straight from the logo to a populated room rather than through an empty
  // one. Capped, so a slow or failing server still gets its say on screen.
  const [booted, setBooted] = useState(false);
  useEffect(() => {
    if (room.state === 'connected' || room.state === 'error') setBooted(true);
  }, [room.state]);
  useEffect(() => {
    const timer = setTimeout(() => setBooted(true), 8000);
    return () => clearTimeout(timer);
  }, []);

  const handleRename = useCallback(
    async (name: string) => {
      // Stored server-side so it survives a restart, and pushed into the
      // room so everyone sees it now rather than after a reconnect.
      const result = await window.zoia.device.rename(name);
      setStatus((prev) => (prev ? { ...prev, deviceName: result.name } : prev));
      await room.setDisplayName(result.name).catch(() => {
        // The name is saved either way; it is picked up on the next join.
      });
    },
    [room],
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

    if (mode === 'window') {
      await room.startBroadcast(source, preset, { keepStage: switching });
      return;
    }

    if (!switching) {
      const claim = await window.zoia.stage.claim();
      if (!claim.ok) {
        setStageError('Could not start your broadcast.');
        return;
      }
    }

    setStageError(null);
    const ok = await gpuCast.start(preset, source);
    if (!ok && !switching) await window.zoia.stage.release().catch(() => {});
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
    room.state === 'connected' ? 'ok' : room.state === 'error' ? 'bad' : 'idle';

  const encodeDetail = gpuLive
    ? `NVENC on the GPU\n${gpuCast.status && gpuCast.status.width > 0 ? `${gpuCast.status.width}×${gpuCast.status.height} · ${Math.round(gpuCast.status.fps)}fps` : 'starting…'} · ${(preset.maxBitrate / 1e6).toFixed(0)}Mbps\n${gpu?.adapter ?? ''}`
    : encodingLive
      ? `${stats!.encoder} on the CPU\n${stats!.width}×${stats!.height} · ${stats!.fps}fps · ${(stats!.kbps / 1000).toFixed(1)}Mbps${room.audioLatencyMs > 0 ? `\naudio +${room.audioLatencyMs}ms` : ''}`
      : null;

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
          {/* One light: the connection, with the round trip to the server
              beside it. How your own broadcast is encoding is in its tooltip. */}
          <StatusLight
            tone={connectionTone}
            label={`Connection: ${room.state}`}
            detail={encodeDetail}
            text={room.state === 'connected' && room.pingMs !== null ? `${room.pingMs} ms` : null}
          />
        </div>

        <div className="topbar-centre">
          {room.isReconnecting ? (
            <span className="connection-message">Reconnecting… your choices will be restored.</span>
          ) : isStarting ? (
            <span className="muted">Starting…</span>
          ) : room.state === 'connecting' ? (
            <span className="muted">Connecting…</span>
          ) : null}
        </div>

        <div className="topbar-right">
          <div className="share-icons" role="group" aria-label="What to share">
            <button
              className={`icon-button${screenLive ? ' active' : ''}`}
              disabled={room.state !== 'connected' || isStarting}
              onClick={() => setPickerOpen(true)}
              title={
                screenLive
                  ? 'Sharing a screen or window — click to switch'
                  : 'Share a screen or window'
              }
              aria-label="Share a screen or window"
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
            </button>

            <button
              className={`icon-button${cameraLive ? ' active' : ''}`}
              disabled={room.state !== 'connected' || isStarting}
              onClick={() => void toggleCamera()}
              title={cameraLive ? 'Sharing your camera — click to stop' : 'Share your camera'}
              aria-label="Share your camera"
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
          <RemoteGrid
            key={channel ?? 'none'}
            screens={room.remoteScreens}
            onFocusChange={setRemoteFocus}
            local={
              isLive
                ? {
                    renderStage: (fullscreen) => (
                      <Player
                        fullscreen={fullscreen}
                        name={status.deviceName ?? 'You'}
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
                    track: room.localTrack,
                    onStop: () => void stopSharing(),
                    name: status.deviceName ?? 'You',
                  }
                : undefined
            }
            loadingBroadcasts={loadingBroadcasts}
            showOnboarding={showOnboarding && room.state === 'connected'}
            onStartSharing={() => {
              dismissOnboarding();
              setPickerOpen(true);
            }}
            onDismissOnboarding={dismissOnboarding}
            onPausedChange={setRemotePaused}
          />
        </main>

        <Sidebar
          members={room.members}
          myName={status.deviceName ?? 'You'}
          viewerIds={viewerIds}
          onOpenSettings={() => setSettingsOpen(true)}
          loadingRemoteIds={loadingRemoteIds}
          channels={channels}
          currentChannel={channel}
          onJoinChannel={(id) => void switchChannel(id)}
          maxChannels={maxChannels}
          onCreateChannel={(name) => void changeChannels(window.zoia.rooms.create(name))}
          onRenameChannel={(id, name) => void changeChannels(window.zoia.rooms.rename(id, name))}
          onRemoveChannel={(id) => void changeChannels(window.zoia.rooms.remove(id))}
        />
      </div>

      {pickerOpen && (
        <SourcePicker
          onPick={handlePick}
          onCancel={() => setPickerOpen(false)}
          presetId={presetId}
          onPresetChange={(id) => {
            setPresetId(id);
            localStorage.setItem(PRESET_STORAGE_KEY, id);
          }}
        />
      )}

      {cameraOpen && (
        <CameraDialog
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

      {settingsOpen && (
        <SettingsDialog
          onClose={() => setSettingsOpen(false)}
          myName={status.deviceName ?? 'You'}
          onRename={handleRename}
          hardwareDetail={
            gpu?.hardwareEncoder
              ? `${(gpu.gpuEncoder ?? '').toUpperCase()} on ${gpu.adapter}`
              : (gpu?.encoderReason ?? 'No hardware encoder was found on this machine.')
          }
        />
      )}
    </div>
  );
}
