import { useEffect, useState } from 'react';
import type { PairingStatus } from '../../shared/ipc';
import { useT } from '../i18n';

/** How often a pending account asks whether it has been approved. */
const POLL_MS = 5_000;

/**
 * Signed in, but the account is waiting for an admin (ADR 0031). Nothing else
 * is reachable until then, so this asks the server every few seconds and
 * moves on by itself; signing out is the only thing to do here.
 */
export default function WaitingScreen({
  status,
  onChange,
}: {
  status: PairingStatus;
  onChange: (status: PairingStatus) => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => {
      void window.zoia.account.refresh().then(onChange);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [onChange]);

  async function signOut() {
    setBusy(true);
    try {
      onChange(await window.zoia.account.signOut());
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="pairing">
      <div className="pairing-card">
        <img className="pairing-logo" src="logo.png" alt="Zoia" draggable={false} />
        <h1>{t('wait.title')}</h1>
        <p className="muted">{t('wait.body', { email: status.account?.email ?? '' })}</p>
        <div className="waiting-spinner splash-spinner" aria-hidden="true" />
        <button type="button" className="link" onClick={() => void signOut()} disabled={busy}>
          {t('wait.signOut')}
        </button>
      </div>
    </main>
  );
}
