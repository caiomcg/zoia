import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type {
  AccountInfo,
  AdminAccount,
  AdminAction,
  AdminActionOptions,
  IssuedCode,
} from '../../shared/ipc';
import { publishAvatarVersions } from '../avatars';
import { useT } from '../i18n';
import Avatar from './Avatar';

/**
 * Settings › Accounts, for admins (ADR 0031): sign-ups waiting for approval
 * first, then everyone, each as they look in a channel and with the channel
 * they are in. Moving someone is done by dragging them onto a channel in the
 * sidebar. Which buttons show follows the server's rules — an
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
      // So each picture shows as it does in a room, fetched by one of their machines.
      publishAvatarVersions(
        outcome.value.flatMap((a) =>
          a.avatarIdentity ? [[a.avatarIdentity, a.avatar] as const] : [],
        ),
      );
    } else {
      setError(t('admin.loadFailed'));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(account: AdminAccount, action: AdminAction, options?: AdminActionOptions) {
    setBusy(account.id);
    setError(null);
    try {
      const outcome = await window.zoia.admin.act(account.id, action, options);
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
                <span className="admin-who">
                  <Avatar name={account.email} live={false} />
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
                <span className="admin-who">
                  <Avatar
                    name={account.name}
                    identity={account.avatarIdentity ?? undefined}
                    role={account.role}
                    live={false}
                  />
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
                </span>
                {canManage(account) && (
                  <span className="admin-actions compact">
                    <IconAction
                      label={t('admin.reset')}
                      disabled={busy === account.id}
                      onClick={() => void act(account, 'reset')}
                    >
                      <IconKey />
                    </IconAction>
                    {isSuper && account.status === 'active' && (
                      <IconAction
                        label={
                          account.role === 'admin' ? t('admin.removeAdmin') : t('admin.makeAdmin')
                        }
                        pressed={account.role === 'admin'}
                        disabled={busy === account.id}
                        onClick={() =>
                          void act(account, 'role', {
                            role: account.role === 'admin' ? 'user' : 'admin',
                          })
                        }
                      >
                        <IconCrown />
                      </IconAction>
                    )}
                    {account.status === 'disabled' ? (
                      <IconAction
                        label={t('admin.enable')}
                        disabled={busy === account.id}
                        onClick={() => void act(account, 'enable')}
                      >
                        <IconRestore />
                      </IconAction>
                    ) : (
                      <IconAction
                        label={t('admin.disable')}
                        danger
                        disabled={busy === account.id}
                        onClick={() => void act(account, 'disable')}
                      >
                        <IconRevoke />
                      </IconAction>
                    )}
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

/** A small square button whose words are its tooltip, so a row's actions line up. */
function IconAction({
  label,
  onClick,
  disabled,
  danger = false,
  pressed,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
  danger?: boolean;
  /** For a toggle (admin or not): shown filled while on. */
  pressed?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`admin-icon${danger ? ' danger' : ''}${pressed ? ' pressed' : ''}`}
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

const ICON = {
  viewBox: '0 0 24 24',
  width: 15,
  height: 15,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

function IconKey() {
  return (
    <svg {...ICON}>
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12l9-9M16 7l3 3M14 9l2 2" />
    </svg>
  );
}

function IconCrown() {
  return (
    <svg {...ICON}>
      <path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z" />
    </svg>
  );
}

function IconRevoke() {
  return (
    <svg {...ICON}>
      <circle cx="12" cy="12" r="9" />
      <path d="M5.6 5.6l12.8 12.8" />
    </svg>
  );
}

function IconRestore() {
  return (
    <svg {...ICON}>
      <path d="M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4" />
    </svg>
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
