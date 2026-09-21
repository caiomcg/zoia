import { useEffect, useState } from 'react';
import PairingScreen from './components/PairingScreen';
import Player from './components/Player';
import { useRoom } from './livekit/useRoom';
import type { PairingStatus } from '../shared/ipc';

export default function App() {
  const [status, setStatus] = useState<PairingStatus | null>(null);
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

  return (
    <div className="room">
      <header className="bar">
        <span className="brand">Zoia</span>
        <span className={`pill ${room.state === 'connected' ? 'live' : ''}`}>{room.state}</span>
        <span className="spacer" />
        <span className="muted">{room.participantCount} here</span>
        <span className="muted">{status.deviceName}</span>
      </header>

      {room.error && <p className="error banner">{room.error}</p>}

      <Player remoteScreen={room.remoteScreen} />
    </div>
  );
}
