import { useCallback, useEffect, useState } from 'react';
import Banner from './components/Banner';
import PairingScreen from './components/PairingScreen';
import Player from './components/Player';
import Sidebar from './components/Sidebar';
import SourcePicker from './components/SourcePicker';
import StatusLight, { type StatusTone } from './components/StatusLight';
import { IncomingTakeover, OutgoingTakeover } from './components/TakeoverPrompts';
import { useRoom } from './livekit/useRoom';
import { useGpuBroadcast } from './livekit/useGpuBroadcast';
import { useTakeover } from './livekit/useTakeover';
import {
  DEFAULT_PRESET_ID,
  QUALITY_PRESETS,
  type BroadcastMode,
  type GpuStatus,
  type PairingStatus,
  type SourceInfo,
} from '../shared/ipc';

const PRESET_STORAGE_KEY = 'zoia.qualityPreset';
const MODE_STORAGE_KEY = 'zoia.broadcastMode';

export default function App() {
  const [status, setStatus] = useState<PairingStatus | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [gpu, setGpu] = useState<GpuStatus | null>(null);
  const [stageError, setStageError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [presetId, setPresetId] = useState(
    () => localStorage.getItem(PRESET_STORAGE_KEY) ?? DEFAULT_PRESET_ID,
  );
  const [mode, setMode] = useState<BroadcastMode>(
    () => (localStorage.getItem(MODE_STORAGE_KEY) as BroadcastMode) ?? 'gpu',
  );

  const room = useRoom();
  const gpuCast = useGpuBroadcast();

  const preset =
    QUALITY_PRESETS.find((p) => p.id === presetId) ??
    QUALITY_PRESETS.find((p) => p.id === DEFAULT_PRESET_ID) ??
    QUALITY_PRESETS[0]!;

  const isLive = room.broadcastState === 'live' || gpuCast.state === 'live';
  const isStarting = room.broadcastState === 'starting' || gpuCast.state === 'starting';

  // Granted means the holder stepped aside, so the stage is free to claim.
  const takeover = useTakeover(room.room, {
    onGranted: () => setPickerOpen(true),
  });

  useEffect(() => {
    room.onData(takeover.handleData);
  }, [room, takeover.handleData]);

  useEffect(() => {
    window.zoia.pairing.status().then(setStatus);
    return window.zoia.pairing.onChange(setStatus);
  }, []);

  useEffect(() => {
    window.zoia.gpu.status().then((next) => {
      setGpu(next);
      // Fall back rather than leaving someone in a mode that cannot work.
      if (!next.hardwareEncoder) {
        setMode('window');
        localStorage.setItem(MODE_STORAGE_KEY, 'window');
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
        setStageError(
          claim.holder ? `${claim.holder.name} is already sharing.` : 'The stage is busy.',
        );
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

  /** Takes the stage outright, once asking has not been answered. */
  async function takeStage() {
    takeover.cancelRequest();
    const claim = await window.zoia.stage.claim(true);
    if (!claim.ok) {
      setStageError('The stage could not be taken.');
      return;
    }
    setStageError(null);
    setPickerOpen(true);
  }

  const stats = room.videoStats;
  const encodingLive = Boolean(stats && (stats.fps > 0 || stats.kbps > 0));
  const gpuLive = gpuCast.state === 'live';
  const holder = room.remoteScreen;

  // GPU encoding needs an NVIDIA encoder, which an AMD or Intel machine will
  // never have. Reported up front rather than failing at broadcast time with
  // "nvEncodeAPI64.dll could not be loaded".
  const canUseGpu = gpu?.hardwareEncoder !== false;
  const cameraLive = room.broadcastState === 'live' && room.sharingKind === 'camera';
  const screenLive = isLive && !cameraLive;

  async function shareCamera() {
    if (cameraLive) {
      await stopSharing();
      return;
    }
    // The picker owns device selection; this is the quick path that uses
    // whatever was chosen last, or the system default.
    setPickerOpen(true);
  }

  const connectionTone: StatusTone =
    room.state === 'connected' ? 'ok' : room.state === 'error' ? 'bad' : 'idle';

  const encodeDetail = gpuLive
    ? `NVENC on the GPU\n${gpuCast.status && gpuCast.status.width > 0 ? `${gpuCast.status.width}×${gpuCast.status.height} · ${Math.round(gpuCast.status.fps)}fps` : 'starting…'} · ${(preset.maxBitrate / 1e6).toFixed(0)}Mbps\n${gpu?.adapter ?? ''}`
    : encodingLive
      ? `${stats!.encoder} on the CPU\n${stats!.width}×${stats!.height} · ${stats!.fps}fps · ${(stats!.kbps / 1000).toFixed(1)}Mbps${room.audioLatencyMs > 0 ? `\naudio +${room.audioLatencyMs}ms` : ''}`
      : null;

  const roomError = show('room', room.error);
  const broadcastError = show('broadcast', room.broadcastError);
  const gpuError = show('gpu', gpuCast.error);
  const audioWarning = show('audio', room.audioWarning);
  const stageMessage = show('stage', stageError);
  const gpuWarning = gpuLive ? show('gpustatus', gpuCast.status?.error) : null;

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
              tone={gpuLive ? 'ok' : 'warn'}
              label={gpuLive ? 'Encoding on the GPU' : 'Encoding on the CPU'}
              detail={encodeDetail}
            />
          )}
        </div>

        <div className="topbar-centre">
          {isLive ? (
            <>
              <button className="danger" onClick={() => void stopSharing()}>
                Stop sharing
              </button>
              <button onClick={() => setPickerOpen(true)} title="Share something else instead">
                Switch
              </button>
            </>
          ) : holder ? (
            <button
              className="primary"
              disabled={Boolean(takeover.outgoing)}
              onClick={() => takeover.request(holder.participantName)}
            >
              Ask to share
            </button>
          ) : (
            <button
              className="primary"
              disabled={room.state !== 'connected' || isStarting}
              onClick={() => setPickerOpen(true)}
            >
              {isStarting ? 'Starting…' : 'Share your screen'}
            </button>
          )}
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
              onClick={() => void shareCamera()}
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

          <div className="mode-switch" role="group" aria-label="Encoding mode">
            {(
              [
                ['gpu', 'GPU'],
                ['window', 'CPU'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                className={mode === value ? 'active' : ''}
                disabled={isLive || isStarting || (value === 'gpu' && !canUseGpu)}
                onClick={() => {
                  setMode(value);
                  localStorage.setItem(MODE_STORAGE_KEY, value);
                }}
                title={
                  value === 'gpu'
                    ? (gpu?.encoderReason ?? 'Encode with NVENC on the GPU.')
                    : 'Publish through Chromium, which encodes in software on the CPU.'
                }
              >
                {label}
              </button>
            ))}
          </div>

          <label className="quality-picker">
            <select
              value={presetId}
              disabled={isLive || isStarting}
              onChange={(e) => {
                setPresetId(e.target.value);
                localStorage.setItem(PRESET_STORAGE_KEY, e.target.value);
              }}
              title={isLive ? 'Stop sharing to change quality' : 'Resolution and frame rate'}
            >
              {QUALITY_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {mode === 'gpu' ? `${p.maxFramerate}fps · ${p.maxBitrate / 1e6}Mbps` : p.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      {takeover.incoming && (
        <IncomingTakeover
          request={takeover.incoming}
          onRespond={(accept) => {
            takeover.respond(accept);
            if (accept) void stopSharing();
          }}
        />
      )}

      {takeover.outgoing && (
        <OutgoingTakeover
          request={takeover.outgoing}
          onTake={() => void takeStage()}
          onCancel={takeover.cancelRequest}
        />
      )}

      {roomError && <Banner onDismiss={() => dismiss('room', roomError)}>{roomError}</Banner>}
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
          <Player
            remoteScreen={room.remoteScreen}
            localTrack={room.localTrack}
            audioLevel={room.audioLevel}
            canMonitor={room.canMonitor}
            setMonitorGain={room.setMonitorGain}
            gpuBroadcasting={gpuLive}
          />
        </main>

        <Sidebar
          members={room.members}
          myName={status.deviceName ?? 'You'}
          onRename={handleRename}
        />
      </div>

      {pickerOpen && (
        <SourcePicker
          onPick={handlePick}
          onPickCamera={(constraints) => {
            setPickerOpen(false);
            // A camera always goes through the Chromium path: there is no
            // window for the hardware encoder to capture, and the frame is
            // small enough that it does not need one.
            void room.startCamera(constraints);
          }}
          onCancel={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}
