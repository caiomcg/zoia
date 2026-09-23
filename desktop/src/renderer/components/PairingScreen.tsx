import { useState } from 'react';
import type { PairingStatus } from '../../shared/ipc';

export default function PairingScreen({
  status,
  onPaired,
}: {
  status: PairingStatus;
  onPaired: (status: PairingStatus) => void;
}) {
  const [deviceName, setDeviceName] = useState('');
  const [pairing, setPairing] = useState(false);

  async function handlePair() {
    setPairing(true);
    try {
      const result = await window.zoia.pairing.start(deviceName || undefined);
      onPaired(result);
    } finally {
      setPairing(false);
    }
  }

  return (
    <main className="pairing">
      <div className="pairing-card">
        <img className="pairing-logo" src="logo.png" alt="Zoia" draggable={false} />
        <p className="muted">This copy of Zoia hasn&rsquo;t been set up on this machine yet.</p>

        <label htmlFor="device-name">Name for this device (optional)</label>
        <input
          id="device-name"
          placeholder="e.g. Living room PC"
          value={deviceName}
          onChange={(e) => setDeviceName(e.target.value)}
          disabled={pairing}
        />

        <button className="primary" onClick={handlePair} disabled={pairing}>
          {pairing ? 'Pairing…' : 'Pair this device'}
        </button>

        {status.error && <p className="error">{status.error}</p>}
      </div>
    </main>
  );
}
