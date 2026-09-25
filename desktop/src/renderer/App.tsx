import { useCallback, useEffect, useState } from 'react';
import Banner from './components/Banner';
import CameraDialog from './components/CameraDialog';
import PairingScreen from './components/PairingScreen';
import Player from './components/Player';
import RemoteGrid, { type LoadingBroadcast } from './components/RemoteGrid';
import Sidebar from './components/Sidebar';
import SourcePicker from './components/SourcePicker';
import StatusLight, { type StatusTone } from './components/StatusLight';
import { useRoom } from './livekit/useRoom';
import { useGpuBroadcast } from './livekit/useGpuBroadcast';
import {
  DEFAULT_PRESET_ID,
  QUALITY_PRESETS,
  type BroadcastMode,
  type GpuStatus,
  type PairingStatus,
  type SourceInfo,
} from '../shared/ipc';

const PRESET_STORAGE_KEY = 'zoia.qualityPreset';
const HARDWARE_STORAGE_KEY = 'zoia.hardwareAcceleration';

export default function App() {
  const [status, setStatus] = useState<PairingStatus | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [gpu, setGpu] = useState<GpuStatus | null>(null);
  const [stageError, setStageError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [presetId, setPresetId] = useState(
    () => localStorage.getItem(PRESET_STORAGE_KEY) ?? DEFAULT_PRESET_ID,
  );
  // Off unless the person turned it on, and it stays off after an upgrade:
  // absent means false. The GPU path is the newer half of the app and the one
  // that has broken on other people's hardware, so it is opt-in rather than
  // something to discover by having a broadcast fail.
  const [hardware, setHardware] = useState(
    () => localStorage.getItem(HARDWARE_STORAGE_KEY) === 'true',
  );

  const room = useRoom();
  const gpuCast = useGpuBroadcast();

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
    window.zoia.gpu.status().then((next) => {
      setGpu(next);
      // Turn it back off rather than leaving someone switched on to a path
      // this machine cannot take — they would only find out at "go live".
      if (!next.hardwareEncoder) {
        setHardware(false);
        localStorage.setItem(HARDWARE_STORAGE_KEY, 'false');
      }
    });
  }, []);

  useEffect(() => {
    if (status?.paired && room.state === 'idle') {
      window.zoia.token
        .get()
        .then(({ wsUrl, token, quality }) => room.connect(wsUrl, token, quality));
    }
  }, [status?.paired, room]);

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

  if (!status) return <div className="loading">Loading…</div>;
  if (!status.paired) return <PairingScreen status={status} onPaired={setStatus} />;

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
        setStageError('Could not claim your broadcast slot.');
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
  const loadingRemoteIds = new Set(loadingBroadcasts.map((broadcast) => broadcast.identity));

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
          <StatusLight tone={connectionTone} label={`Connection: ${room.state}`} />
          {(gpuLive || encodingLive) && (
            <StatusLight
              // Amber would mean something is wrong. While the CPU path is
              // the only one offered, encoding on the CPU is simply how this
              // works, so the light says "encoding, and healthy" and leaves
              // which encoder to the tooltip. It only warns when the GPU was
              // available and we ended up on the CPU anyway.
              // Amber would mean something is wrong, and encoding on the CPU
              // is not wrong unless hardware encoding was asked for and did
              // not happen.
              tone={gpuLive || !hardware ? 'ok' : 'warn'}
              label={gpuLive ? 'Encoding on the GPU' : 'Encoding on the CPU'}
              detail={encodeDetail}
            />
          )}
        </div>

        <div className="topbar-centre">
          {room.isReconnecting ? (
            <span className="connection-message">
              Reconectando… suas escolhas serão restauradas.
            </span>
          ) : isStarting ? (
            <span className="muted">Starting…</span>
          ) : room.state === 'connecting' ? (
            <span className="muted">Conectando…</span>
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
          {isLive ? (
            <Player
              remoteScreen={null}
              localTrack={room.localTrack}
              audioLevel={room.audioLevel}
              canMonitor={room.canMonitor}
              setMonitorGain={room.setMonitorGain}
              gpuBroadcasting={gpuLive}
              onStop={() => void stopSharing()}
              onSwitch={() => setPickerOpen(true)}
            />
          ) : (
            <RemoteGrid screens={room.remoteScreens} loadingBroadcasts={loadingBroadcasts} />
          )}
        </main>

        <Sidebar
          members={room.members}
          myName={status.deviceName ?? 'You'}
          onRename={handleRename}
          selectedRemoteIds={room.selectedRemoteIds}
          loadingRemoteIds={loadingRemoteIds}
          onToggleRemote={(identity) => {
            void room.setRemoteSubscription(identity, !room.selectedRemoteIds.has(identity));
          }}
          onWatchAll={() => {
            void Promise.all(
              room.members
                .filter((member) => member.isBroadcasting && !member.isLocal)
                .map((member) => room.setRemoteSubscription(member.identity, true)),
            );
          }}
          onWatchNone={() => {
            void Promise.all(
              room.members
                .filter((member) => member.isBroadcasting && !member.isLocal)
                .map((member) => room.setRemoteSubscription(member.identity, false)),
            );
          }}
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
          hardware={hardware}
          onHardwareChange={(next) => {
            setHardware(next);
            localStorage.setItem(HARDWARE_STORAGE_KEY, String(next));
          }}
          hardwareAvailable={Boolean(gpu?.hardwareEncoder)}
          hardwareDetail={
            gpu?.hardwareEncoder
              ? `${(gpu.gpuEncoder ?? '').toUpperCase()} on ${gpu.adapter}`
              : (gpu?.encoderReason ?? 'No hardware encoder was found on this machine.')
          }
        />
      )}

      {cameraOpen && (
        <CameraDialog
          onStart={(constraints) => {
            setCameraOpen(false);
            // A camera always goes through the Chromium path: there is no
            // window for the hardware encoder to capture, and the frame is
            // small enough that it does not need one.
            void (async () => {
              if (isLive) await stopSharing();
              await room.startCamera(constraints);
            })();
          }}
          onCancel={() => setCameraOpen(false)}
        />
      )}
    </div>
  );
}
