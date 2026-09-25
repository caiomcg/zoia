import { useCallback, useRef, useState } from 'react';
import type { PairingStatus } from '../../shared/ipc';

/**
 * First run, before this machine has a credential.
 *
 * Two quite different situations share this screen, and telling them apart is
 * most of its job:
 *
 *  - **No invite yet.** The build carries no server and no token — every
 *    published release is like this — so the user has to supply the invite
 *    they were sent. Dropping the file or picking it is the whole interaction.
 *  - **An invite is loaded.** Now the only question is whether to join *that*
 *    server, which is named plainly, because agreeing to it is a trust
 *    decision and a file someone sent you is a strange thing to trust blindly.
 */
export default function PairingScreen({
  status,
  onPaired,
}: {
  status: PairingStatus;
  onPaired: (status: PairingStatus) => void;
}) {
  const [deviceName, setDeviceName] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  // Counts enter/leave rather than toggling: dragging over a child element
  // fires leave on the parent, which would otherwise flicker the highlight.
  const dragDepth = useRef(0);

  const apply = useCallback(
    async (work: () => Promise<PairingStatus | null>) => {
      setBusy(true);
      try {
        const result = await work();
        if (result) onPaired(result);
      } finally {
        setBusy(false);
      }
    },
    [onPaired],
  );

  const handlePair = () => apply(() => window.zoia.pairing.start(deviceName || undefined));
  const handleChoose = () => apply(() => window.zoia.pairing.chooseInvite());

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);

    const file = event.dataTransfer.files[0];
    if (!file) return;
    const path = window.zoia.pairing.pathForFile(file);
    // Empty for anything that did not come from disk — a dragged selection,
    // an attachment straight out of a mail client.
    if (!path) return;
    void apply(() => window.zoia.pairing.useInvite(path));
  };

  const dragProps = {
    onDragEnter: (e: React.DragEvent) => {
      e.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    },
    onDragOver: (e: React.DragEvent) => e.preventDefault(),
    onDragLeave: (e: React.DragEvent) => {
      e.preventDefault();
      dragDepth.current -= 1;
      if (dragDepth.current <= 0) setDragging(false);
    },
    onDrop: handleDrop,
  };

  return (
    <main className="pairing" {...dragProps}>
      <div className={`pairing-card${dragging ? ' dragging' : ''}`}>
        <img className="pairing-logo" src="logo.png" alt="Zoia" draggable={false} />

        {status.needsInvite ? (
          <>
            <p className="onboarding-step">Passo 1 de 2</p>
            <h1>Cole ou abra seu convite</h1>
            <p className="muted">
              Use o arquivo <code>zoia-invite.json</code> enviado pela pessoa que criou a sala.
            </p>

            <div className="invite-drop">
              <p>Arraste seu convite para cá</p>
              <button onClick={handleChoose} disabled={busy}>
                Abrir arquivo de convite…
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="onboarding-step">Passo 2 de 2</p>
            <h1>Entre na sala</h1>
            <p className="muted">Confirme seu nome e entre para assistir ou compartilhar.</p>

            <div className="invite-target">
              <span className="muted">Sala</span>
              <strong>{status.serverUrl}</strong>
            </div>

            <label htmlFor="device-name">Seu nome (opcional)</label>
            <input
              id="device-name"
              placeholder="ex.: Alice"
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
              disabled={busy}
            />

            <button className="primary" onClick={handlePair} disabled={busy}>
              {busy ? 'Entrando…' : 'Entrar na sala'}
            </button>

            <button className="link" onClick={handleChoose} disabled={busy}>
              Usar outro convite
            </button>
          </>
        )}

        {status.error && <p className="error">{status.error}</p>}
      </div>
    </main>
  );
}
