import { useCallback, useEffect, useState } from 'react';
import type { AccountInfo, AdminAccount, AdminAction, IssuedCode } from '../../shared/ipc';
import { useT } from '../i18n';

/**
 * Settings › Accounts, for admins (ADR 0031): sign-ups waiting for approval
 * first, then everyone. Which buttons show follows the server's rules — an
 * admin manages users, only the super admin manages admins, and nobody
 * manages the super admin — but the server checks every one of them again;
 * hiding a button is only so nobody is offered one that will be refused.
 */
export default function AccountsSection({
  me,
  onChanged,
}: {
  me: AccountInfo;
  /** After an approval or rejection, so the waiting count updates at once. */
  onChanged: () => void;
}) {
  const t = useT();
  const [accounts, setAccounts] = useState<AdminAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ name: string; code: IssuedCode } | null>(null);

  const load = useCallback(async () => {
    const outcome = await window.zoia.admin.accounts();
    if (outcome.ok) {
      setAccounts(outcome.value);
      setError(null);
    } else {
      setError(t('admin.loadFailed'));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(account: AdminAccount, action: AdminAction, role?: 'admin' | 'user') {
    setBusy(account.id);
    setError(null);
    try {
      const outcome = await window.zoia.admin.act(account.id, action, role);
      if (!outcome.ok) {
        setError(t('admin.actionFailed', { code: outcome.error }));
        return;
      }
      const { code, expiresAt } = outcome.value;
      if (code && expiresAt) setIssued({ name: account.name, code: { code, expiresAt } });
      if (action === 'approve' || action === 'reject') onChanged();
      await load();
    } finally {
      setBusy(null);
    }
  }

  const isSuper = me.role === 'super_admin';
  const canManage = (target: AdminAccount) =>
    target.id !== me.id && target.role !== 'super_admin' && (target.role !== 'admin' || isSuper);

  const pending = accounts?.filter((a) => a.status === 'pending') ?? [];
  const others = accounts?.filter((a) => a.status !== 'pending') ?? [];

  return (
    <>
      <h3>{t('settings.nav.accounts')}</h3>
      {error && <p className="settings-error">{error}</p>}
      {accounts === null && !error && <p className="muted">{t('common.loading')}</p>}

      {issued && (
        <CodeCard name={issued.name} issued={issued.code} onDismiss={() => setIssued(null)} />
      )}

      {accounts && (
        <>
          <h4 className="settings-subheading">{t('admin.pending')}</h4>
          {pending.length === 0 && <p className="muted">{t('admin.noPending')}</p>}
          <ul className="admin-accounts">
            {pending.map((account) => (
              <li key={account.id} className="pending">
                <span>
                  <strong>{account.email}</strong>
                  <br />
                  <span className="muted">
                    {t('admin.signedUp', {
                      when: new Date(account.createdAt).toLocaleString(),
                      ip: account.signupIp ?? '?',
                    })}
                  </span>
                </span>
                <span className="admin-actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={busy === account.id}
                    onClick={() => void act(account, 'approve')}
                  >
                    {t('admin.approve')}
                  </button>
                  <button
                    type="button"
                    disabled={busy === account.id}
                    onClick={() => void act(account, 'reject')}
                  >
                    {t('admin.reject')}
                  </button>
                </span>
              </li>
            ))}
          </ul>

          <h4 className="settings-subheading">{t('admin.everyone')}</h4>
          <ul className="admin-accounts">
            {others.map((account) => (
              <li
                key={account.id}
                className={account.status === 'disabled' ? 'disabled' : undefined}
              >
                <span>
                  <strong>{account.name}</strong>
                  {account.role !== 'user' && (
                    <span className="settings-badge">{t(`account.role.${account.role}`)}</span>
                  )}
                  {account.status === 'disabled' && (
                    <span className="settings-badge">{t('admin.status.disabled')}</span>
                  )}
                  <br />
                  <span className="muted">
                    {account.email} · {t('admin.devices', { count: account.devices })}
                  </span>
                </span>
                {canManage(account) && (
                  <span className="admin-actions">
                    <button
                      type="button"
                      className="link-button"
                      disabled={busy === account.id}
                      onClick={() => void act(account, 'reset')}
                    >
                      {t('admin.reset')}
                    </button>
                    {isSuper && account.status === 'active' && (
                      <button
                        type="button"
                        className="link-button"
                        disabled={busy === account.id}
                        onClick={() =>
                          void act(account, 'role', account.role === 'admin' ? 'user' : 'admin')
                        }
                      >
                        {account.role === 'admin' ? t('admin.removeAdmin') : t('admin.makeAdmin')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="link-button"
                      disabled={busy === account.id}
                      onClick={() =>
                        void act(account, account.status === 'disabled' ? 'enable' : 'disable')
                      }
                    >
                      {account.status === 'disabled' ? t('admin.enable') : t('admin.disable')}
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

/** A code shown once, to be passed on. Never stored by the app. */
function CodeCard({
  name,
  issued,
  onDismiss,
}: {
  name: string;
  issued: IssuedCode;
  onDismiss: () => void;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(issued.code);
    setCopied(true);
  }

  return (
    <div className="admin-code" role="status">
      <strong>{t('admin.codeTitle', { name })}</strong>
      <p className="muted">
        {t('admin.codeBody', { name, when: new Date(issued.expiresAt).toLocaleString() })}
      </p>
      <code>{issued.code}</code>
      <span className="admin-actions">
        <button type="button" className="primary" onClick={() => void copy()}>
          {copied ? t('admin.copied') : t('admin.copy')}
        </button>
        <button type="button" onClick={onDismiss}>
          {t('common.close')}
        </button>
      </span>
    </div>
  );
}
