import type { KickReason } from '../livekit/useRoom';
import { useT } from '../i18n';

/**
 * Kicked off the server (ADR 0037): by an admin, or for sitting in a channel
 * neither sharing nor watching. Nothing talks to the server from here until
 * the person comes back by hand; it is not a ban, so coming back always works.
 */
export default function KickedScreen({
  reason,
  onReconnect,
}: {
  reason: KickReason;
  onReconnect: () => void;
}) {
  const t = useT();
  return (
    <main className="pairing">
      <div className="pairing-card">
        <img className="pairing-logo" src="logo.png" alt="Zoia" draggable={false} />
        <h1>{t('kicked.title')}</h1>
        <p className="muted">{t(reason === 'idle' ? 'kicked.idle' : 'kicked.admin')}</p>
        <button type="button" className="primary" onClick={onReconnect} autoFocus>
          {t('kicked.reconnect')}
        </button>
      </div>
    </main>
  );
}
