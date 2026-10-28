import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import type {
  AccountRole,
  AdminAccount,
  AdminAction,
  AdminActionOptions,
  ChatPerson,
  IssuedCode,
  ShownPresence,
} from '../../shared/ipc';
import { useFloatingMenu } from './useFloatingMenu';
import { useAccountAvatar } from '../chat/avatars';
import { byPresence, type Dot } from '../chat/status';
import type { PresenceController } from '../chat/usePresence';
import Avatar from './Avatar';
import { useT } from '../i18n';

/**
 * Everyone on the server, in the sidebar's People tab (ADR 0038): those
 * there first, with their status, then everyone offline, dimmed, each under
 * a heading with how many. The collapsed sidebar does not show it.
 */
export default function PeopleList({
  people,
  presence,
  me,
  myRole,
  collapsed,
}: {
  /** Everyone let in; the chat's list of who can be @mentioned. */
  people: ChatPerson[];
  presence: PresenceController;
  /** Your account id, whose dot is your own. */
  me: string | null;
  /** Yours: an admin can right-click someone to manage their account. */
  myRole?: AccountRole;
  collapsed: boolean;
}) {
  const t = useT();
  const [menu, setMenu] = useState<{ person: ChatPerson; x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const isAdmin = myRole === 'admin' || myRole === 'super_admin';
  const listed = byPresence(people, presence.people);
  const isThere = (p: (typeof listed)[number]) => p.status !== 'offline' || p.id === me;
  const groups = [
    { key: 'online', title: t('presence.online'), people: listed.filter(isThere) },
    {
      key: 'offline',
      title: t('presence.offline'),
      people: collapsed ? [] : listed.filter((p) => !isThere(p)),
    },
  ];

  return (
    <section className="member-group people-group">
      {groups.map(
        (group) =>
          group.people.length > 0 && (
            <div className="people-block" key={group.key}>
              {!collapsed && (
                <h2 className="member-heading">
                  {group.title} — {group.people.length}
                </h2>
              )}
              {group.people.map((p) => (
                <Person
                  key={p.id}
                  person={p}
                  status={p.id === me ? (presence.own ?? p.status) : p.status}
                  isMe={p.id === me}
                  // Never yourself: your own account is in Settings.
                  onContextMenu={
                    isAdmin && p.id !== me
                      ? (event) => {
                          event.preventDefault();
                          setMenu({ person: p, x: event.clientX, y: event.clientY });
                        }
                      : undefined
                  }
                />
              ))}
            </div>
          ),
      )}
      {menu && myRole && (
        <PersonMenu {...menu} myRole={myRole} onClose={closeMenu} key={menu.person.id} />
      )}
    </section>
  );
}

function Person({
  person,
  status,
  isMe,
  onContextMenu,
}: {
  person: ChatPerson & { status: ShownPresence };
  status: Dot;
  isMe: boolean;
  onContextMenu?: (event: MouseEvent) => void;
}) {
  const t = useT();
  const image = useAccountAvatar(person.id, person.avatar);
  const offline = status === 'offline' || status === 'invisible';
  return (
    <div
      className={`member person${offline ? ' offline' : ''}`}
      title={`${person.name} · ${t(`presence.${status}`)}${onContextMenu ? `\n${t('admin.manageHint')}` : ''}`}
      onContextMenu={onContextMenu}
    >
      <Avatar name={person.name} image={image} live={false} status={status} />
      <span className="member-name">{person.name}</span>
      {isMe && <span className="you-tag">{t('common.youTag')}</span>}
    </div>
  );
}

/**
 * What an admin may do to someone's account, at the pointer: the same as
 * Settings › Accounts, by the same rules (an admin manages users, only the
 * super admin manages admins, nobody the super admin). The server checks
 * each again; hiding one is only so nobody is offered what will be refused.
 */
function PersonMenu({
  person,
  x,
  y,
  myRole,
  onClose,
}: {
  person: ChatPerson;
  x: number;
  y: number;
  myRole: AccountRole;
  onClose: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const image = useAccountAvatar(person.id, person.avatar);
  // The account as the admin list has it: role and status are not in the chat's.
  const [account, setAccount] = useState<AdminAccount | null | 'missing'>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssuedCode | null>(null);
  const [copied, setCopied] = useState(false);
  // What decides the menu's height, as a string: it re-measures when it grows.
  const shape = `${account === null ? 'loading' : account === 'missing' ? 'missing' : account.role + account.status}:${issued ? 'code' : ''}:${error ?? ''}`;
  const place = useFloatingMenu(ref, x, y, onClose, shape);

  useEffect(() => {
    let live = true;
    void window.zoia.admin.accounts().then((outcome) => {
      if (!live) return;
      if (!outcome.ok) setError(t('admin.loadFailed'));
      else setAccount(outcome.value.find((a) => a.id === person.id) ?? 'missing');
    });
    return () => {
      live = false;
    };
  }, [person.id, t]);

  async function act(action: AdminAction, options?: AdminActionOptions) {
    if (!account || account === 'missing') return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await window.zoia.admin.act(account.id, action, options);
      if (!outcome.ok) {
        setError(t('admin.actionFailed', { code: outcome.error }));
        return;
      }
      const { code, expiresAt, account: updated } = outcome.value;
      if (updated) setAccount(updated);
      // A reset code is shown here, once, to be handed on; the menu stays.
      if (code && expiresAt) setIssued({ code, expiresAt });
      else onClose();
    } finally {
      setBusy(false);
    }
  }

  const loaded = account && account !== 'missing' ? account : null;
  const isSuper = myRole === 'super_admin';
  const manageable =
    loaded !== null && loaded.role !== 'super_admin' && (loaded.role !== 'admin' || isSuper);

  return createPortal(
    <div
      ref={ref}
      className="member-menu person-menu"
      role="menu"
      aria-label={person.name}
      style={place}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="member-menu-head">
        <Avatar name={person.name} image={image} live={false} role={loaded?.role} />
        <span className="member-menu-who">
          <span className="member-menu-name">{person.name}</span>
          {loaded && (
            <span className="member-menu-role">
              {t(`account.role.${loaded.role}`)}
              {loaded.status === 'disabled' && ` · ${t('admin.status.disabled')}`}
            </span>
          )}
        </span>
      </div>

      {issued ? (
        <div className="person-menu-code" role="status">
          <span className="muted">
            {t('admin.codeBody', {
              name: person.name,
              when: new Date(issued.expiresAt).toLocaleString(),
            })}
          </span>
          <code>{issued.code}</code>
          <button
            type="button"
            className="primary"
            onClick={() =>
              void navigator.clipboard.writeText(issued.code).then(() => setCopied(true))
            }
          >
            {copied ? t('admin.copied') : t('admin.copy')}
          </button>
        </div>
      ) : account === null && !error ? (
        <p className="person-menu-note muted">{t('common.loading')}</p>
      ) : !manageable ? (
        !error && <p className="person-menu-note muted">{t('admin.cannotManage')}</p>
      ) : (
        loaded && (
          <>
            <button
              type="button"
              role="menuitem"
              className="person-menu-item"
              disabled={busy}
              onClick={() => void act('reset')}
            >
              {t('admin.reset')}
            </button>
            {isSuper && loaded.status === 'active' && (
              <button
                type="button"
                role="menuitem"
                className="person-menu-item"
                disabled={busy}
                onClick={() =>
                  void act('role', { role: loaded.role === 'admin' ? 'user' : 'admin' })
                }
              >
                {loaded.role === 'admin' ? t('admin.removeAdmin') : t('admin.makeAdmin')}
              </button>
            )}
            {loaded.status === 'disabled' ? (
              <button
                type="button"
                role="menuitem"
                className="person-menu-item"
                disabled={busy}
                onClick={() => void act('enable')}
              >
                {t('admin.enable')}
              </button>
            ) : (
              <button
                type="button"
                role="menuitem"
                className="member-menu-item"
                disabled={busy}
                onClick={() => void act('disable')}
              >
                {t('admin.disable')}
              </button>
            )}
          </>
        )
      )}
      {error && <p className="person-menu-note settings-error">{error}</p>}
    </div>,
    document.body,
  );
}
