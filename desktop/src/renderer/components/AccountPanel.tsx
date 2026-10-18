import { useCallback, useEffect, useState } from 'react';
import type { AccountDevice, AccountInfo } from '../../shared/ipc';
import { isStrongPassword } from '../../shared/password';
import PasswordRules from './PasswordRules';
import { authError } from '../account-errors';
import { useT } from '../i18n';

/**
 * Your account, under Profile: which email you sign in with, your password,
 * and the machines signed in as you (ADR 0031). Shown only for a machine that
 * belongs to an account; one paired before accounts has none of this.
 */
export default function AccountPanel({
  account,
  onSignOut,
}: {
  account: AccountInfo;
  onSignOut: () => Promise<void>;
}) {
  const t = useT();

  return (
    <>
      <h3 className="settings-subheading">{t('account.title')}</h3>
      {account.email && (
        <p className="muted">
          {t('account.signedInAs', { email: account.email })}
          {account.role !== 'user' && (
            <span className="settings-badge">{t(`account.role.${account.role}`)}</span>
          )}
        </p>
      )}
      <PasswordForm />
      <Devices />
      <p>
        <button type="button" onClick={() => void onSignOut()}>
          {t('account.signOut')}
        </button>
      </p>
    </>
  );
}

function PasswordForm() {
  const t = useT();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!isStrongPassword(next)) {
      setError(authError(t, 'weak_password'));
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const outcome = await window.zoia.account.changePassword(current, next);
      if (outcome.ok) {
        setCurrent('');
        setNext('');
        setMessage(t('account.passwordChanged'));
      } else {
        setError(
          outcome.error === 'invalid_login'
            ? t('account.error.invalid_login')
            : authError(t, outcome.error),
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="settings-password" onSubmit={(event) => void submit(event)}>
      <label className="settings-field">
        <span>{t('account.currentPassword')}</span>
        <input
          type="password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          autoComplete="current-password"
          disabled={busy}
          required
        />
      </label>
      <label className="settings-field">
        <span>{t('auth.newPassword')}</span>
        <div className="settings-inline">
          <input
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            disabled={busy}
            required
          />
          <button className="primary" type="submit" disabled={busy || !current || !next}>
            {t('account.changePassword')}
          </button>
        </div>
      </label>
      {next && <PasswordRules password={next} />}
      {error && <p className="settings-error">{error}</p>}
      {message && <p className="settings-message">{message}</p>}
    </form>
  );
}

function Devices() {
  const t = useT();
  const [devices, setDevices] = useState<AccountDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const outcome = await window.zoia.account.devices();
    if (outcome.ok) setDevices(outcome.value);
    else setError(authError(t, outcome.error));
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove(id: string) {
    const outcome = await window.zoia.account.removeDevice(id);
    if (!outcome.ok) setError(authError(t, outcome.error));
    await load();
  }

  return (
    <div className="settings-field">
      <span>{t('account.devices')}</span>
      {devices === null && !error && <p className="muted">{t('common.loading')}</p>}
      <ul className="account-devices">
        {devices?.map((device) => (
          <li key={device.id}>
            <span>
              <strong>{device.name}</strong>
              {device.current && <span className="muted"> · {t('account.thisDevice')}</span>}
              <br />
              <span className="muted">
                {t('account.lastSeen', {
                  when: device.lastSeen
                    ? new Date(device.lastSeen).toLocaleString()
                    : t('account.never'),
                })}
              </span>
            </span>
            {!device.current && (
              <button type="button" className="link-button" onClick={() => void remove(device.id)}>
                {t('account.signOutDevice')}
              </button>
            )}
          </li>
        ))}
      </ul>
      {error && <p className="settings-error">{error}</p>}
    </div>
  );
}
