import { useCallback, useEffect, useState } from 'react';
import PairingScreen from './components/PairingScreen';
import Player from './components/Player';
import Sidebar from './components/Sidebar';
import SourcePicker from './components/SourcePicker';
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
const MODE_STORAGE_KEY = 'zoia.broadcastMode';

export default function App() {
  const [status, setStatus] = useState<PairingStatus | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [gpu, setGpu] = useState<GpuStatus | null>(null);
  const [stageError, setStageError] = useState<string | null>(null);
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

  useEffect(() => {
    window.zoia.pairing.status().then(setStatus);
    return window.zoia.pairing.onChange(setStatus);
  }, []);

  useEffect(() => {
    window.zoia.gpu.status().then(setGpu);
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
        // The name is saved either way; it will be picked up on next join.
      });
    },
    [room],
  );

  if (!status) return <div className="loading">Loading…</div>;
  if (!status.paired) return <PairingScreen status={status} onPaired={setStatus} />;

  const isLive = room.broadcastState === 'live' || gpuCast.state === 'live';
  const isStarting = room.broadcastState === 'starting' || gpuCast.state === 'starting';

  async function handlePick(source: SourceInfo) {
    setPickerOpen(false);
    if (mode === 'window') {
      await room.startBroadcast(source, preset);
      return;
    }

    const claim = await window.zoia.stage.claim();
    if (!claim.ok) {
      // Previously this returned in silence, so a busy stage looked exactly
      // like a broadcast that simply never started.
      setStageError(
        claim.holder ? `${claim.holder.name} is already sharing.` : 'The stage is busy.',
      );
      return;
    }

    setStageError(null);
    const ok = await gpuCast.start(preset, source);
    if (!ok) await window.zoia.stage.release().catch(() => {});
  }

  function startSharing() {
    // Both paths pick a source now: GPU mode encodes a chosen window through
    // Chromium's capture, or the whole screen if a screen is picked.
    setPickerOpen(true);
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

  return (
    <div className="app">
      <header className="topbar">
        <img
          className="brand"
          src="logo.png"
          alt="Zoia"
          draggable={false}
          // Resolved against the loaded document rather than a root-absolute
          // path: under file:// a leading slash means the filesystem root,
          // not the folder the page was loaded from.
        />
        <span className={`pill ${room.state === 'connected' ? 'ok' : ''}`}>{room.state}</span>

        {gpuLive && (
          <span className="pill ok" title={`NVENC via ffmpeg → WHIP\n${gpu?.adapter ?? ''}`}>
            GPU encoding · NVENC
          </span>
        )}
        {!gpuLive && encodingLive && (
          <span className="pill warn" title={`encoder: ${stats!.encoder}`}>
            CPU encoding · {stats!.encoder}
          </span>
        )}

        {gpuLive && gpuCast.status && (
          <span className="stats-readout">
            {gpuCast.status.width > 0
              ? `${gpuCast.status.width}×${gpuCast.status.height}`
              : 'native'}{' '}
            · {Math.round(gpuCast.status.fps)}fps · {(preset.maxBitrate / 1e6).toFixed(0)}Mbps
          </span>
        )}
        {!gpuLive && encodingLive && (
          <span className="stats-readout">
            {stats!.width}×{stats!.height} · {stats!.fps}fps · {(stats!.kbps / 1000).toFixed(1)}
            Mbps
            {room.audioLatencyMs > 0 && <> · audio +{room.audioLatencyMs}ms</>}
          </span>
        )}

        <span className="spacer" />

        <div className="mode-switch" role="group" aria-label="Encoding mode">
          {(
            [
              ['gpu', 'GPU encode'],
              ['window', 'CPU encode'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              className={mode === value ? 'active' : ''}
              disabled={isLive || isStarting}
              onClick={() => {
                setMode(value);
                localStorage.setItem(MODE_STORAGE_KEY, value);
              }}
              title={
                value === 'gpu'
                  ? 'Encode with NVENC on the GPU. Works for a single window or a whole screen.'
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

        {isLive ? (
          <button className="danger" onClick={() => void stopSharing()}>
            Stop sharing
          </button>
        ) : (
          <button
            className="primary"
            disabled={room.state !== 'connected' || isStarting}
            onClick={() => startSharing()}
          >
            {isStarting ? 'Starting…' : 'Share your screen'}
          </button>
        )}
      </header>

      {room.error && <p className="banner error">{room.error}</p>}
      {room.broadcastError && <p className="banner error">{room.broadcastError}</p>}
      {gpuCast.error && <p className="banner error">{gpuCast.error}</p>}
      {stageError && <p className="banner error">{stageError}</p>}
      {room.audioWarning && <p className="banner warn">{room.audioWarning}</p>}
      {gpuLive && gpuCast.status?.error && <p className="banner warn">{gpuCast.status.error}</p>}

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
