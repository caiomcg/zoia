import { useEffect, useState } from 'react';
import PairingScreen from './components/PairingScreen';
import Player from './components/Player';
import SourcePicker from './components/SourcePicker';
import { useRoom } from './livekit/useRoom';
import type { PairingStatus, SourceInfo } from '../shared/ipc';

export default function App() {
  const [status, setStatus] = useState<PairingStatus | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const room = useRoom();

  useEffect(() => {
    window.zoia.pairing.status().then(setStatus);
    return window.zoia.pairing.onChange(setStatus);
  }, []);

  useEffect(() => {
    if (status?.paired && room.state === 'idle') {
      window.zoia.token.get().then(({ wsUrl, token }) => room.connect(wsUrl, token));
    }
  }, [status?.paired, room]);

  if (!status) return <div className="loading">Loading…</div>;

  if (!status.paired) {
    return <PairingScreen status={status} onPaired={setStatus} />;
  }

  async function handlePick(source: SourceInfo) {
    setPickerOpen(false);
    await room.startBroadcast(source);
  }

  return (
    <div className="room">
      <header className="bar">
        <span className="brand">Zoia</span>
        <span className={`pill ${room.state === 'connected' ? 'live' : ''}`}>{room.state}</span>
        <span className="spacer" />
        {room.broadcastState === 'live' ? (
          <button className="danger" onClick={() => room.stopBroadcast()}>
            Stop sharing
          </button>
        ) : (
          <button
            className="primary"
            disabled={room.state !== 'connected' || room.broadcastState === 'starting'}
            onClick={() => setPickerOpen(true)}
          >
            {room.broadcastState === 'starting' ? 'Starting…' : 'Share your screen'}
          </button>
        )}
        <span className="muted">{room.participantCount} here</span>
        <span className="muted">{status.deviceName}</span>
      </header>

      {room.error && <p className="error banner">{room.error}</p>}
      {room.broadcastError && <p className="error banner">{room.broadcastError}</p>}

      <Player remoteScreen={room.remoteScreen} localTrack={room.localTrack} />

      {pickerOpen && <SourcePicker onPick={handlePick} onCancel={() => setPickerOpen(false)} />}
    </div>
  );
}
