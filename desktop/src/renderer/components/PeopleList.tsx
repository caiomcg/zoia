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
import { SectionHeading, useFolded } from './Sidebar';
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
  onMessage,
  unreadFrom = {},
}: {
  /** Everyone let in; the chat's list of who can be @mentioned. */
  people: ChatPerson[];
  presence: PresenceController;
  /** Your account id, whose dot is your own. */
  me: string | null;
  /** Yours: an admin can right-click someone to manage their account. */
  myRole?: AccountRole;
  collapsed: boolean;
  /** Opens a direct chat with someone (ADR 0047); absent without direct messages. */
  onMessage?: (person: ChatPerson) => void;
  /** Unread direct messages from each person, by account id. */
  unreadFrom?: Record<string, number>;
}) {
  const t = useT();
  const [menu, setMenu] = useState<{ person: ChatPerson; x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const isAdmin = myRole === 'admin' || myRole === 'super_admin';
  const listed = byPresence(people, presence.people);
  const isThere = (p: (typeof listed)[number]) => p.status !== 'offline' || p.id === me;
  // Under the conversations in the Chats tab: who is there, open; everyone
  // else folded until asked for.
  const [onlineFolded, toggleOnline] = useFolded('online');
  const [offlineFolded, toggleOffline] = useFolded('offline', true);
  const groups = [
    {
      key: 'online',
      title: t('presence.online'),
      people: listed.filter(isThere),
      folded: onlineFolded,
      toggle: toggleOnline,
    },
    {
      key: 'offline',
      title: t('presence.offline'),
      people: collapsed ? [] : listed.filter((p) => !isThere(p)),
      folded: offlineFolded,
      toggle: toggleOffline,
    },
  ];

  return (
    <section className="member-group people-group">
      {groups.map(
        (group) =>
          group.people.length > 0 && (
            <div className="people-block" key={group.key}>
              {!collapsed && (
                <SectionHeading
                  title={group.title}
                  count={group.people.length}
                  folded={group.folded}
                  onToggle={group.toggle}
                />
              )}
              {(collapsed || !group.folded
                ? group.people
                : group.people.filter((p) => (unreadFrom[p.id] ?? 0) > 0)
              ).map((p) => (
                <Person
                  key={p.id}
                  person={p}
                  status={p.id === me ? (presence.own ?? p.status) : p.status}
                  isMe={p.id === me}
                  unread={unreadFrom[p.id] ?? 0}
                  // Never yourself: your own account is in Settings, and a
                  // bot is not someone to write to.
                  onContextMenu={
                    p.id !== me && (isAdmin || (onMessage && !p.bot))
                      ? (event) => {
                          event.preventDefault();
                          setMenu({ person: p, x: event.clientX, y: event.clientY });
                        }
                      : undefined
                  }
                  onClick={onMessage && p.id !== me && !p.bot ? () => onMessage(p) : undefined}
                />
              ))}
            </div>
          ),
      )}
      {menu && (
        <PersonMenu
          {...menu}
          myRole={myRole ?? 'user'}
          admin={isAdmin}
          onMessage={onMessage && !menu.person.bot ? () => onMessage(menu.person) : undefined}
          onClose={closeMenu}
          key={menu.person.id}
        />
      )}
    </section>
  );
}

function Person({
  person,
  status,
  isMe,
  onContextMenu,
  onClick,
  unread = 0,
}: {
  person: ChatPerson & { status: ShownPresence };
  status: Dot;
  isMe: boolean;
  onContextMenu?: (event: MouseEvent) => void;
  /** Opens a direct chat with them. */
  onClick?: () => void;
  /** Their direct messages to you not yet read. */
  unread?: number;
}) {
  const t = useT();
  const image = useAccountAvatar(person.id, person.avatar);
  const offline = status === 'offline' || status === 'invisible';
  return (
    <div
      className={`member person${offline ? ' offline' : ''}${onClick ? ' clickable' : ''}`}
      title={`${person.name} · ${t(`presence.${status}`)}${onClick ? `\n${t('chat.direct.hint')}` : ''}`}
      onContextMenu={onContextMenu}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      <Avatar
        name={person.name}
        image={image}
        live={false}
        status={status}
        role={person.role}
        bot={person.bot}
      />
      <span className="member-name">{person.name}</span>
      {isMe && <span className="you-tag">{t('common.youTag')}</span>}
      {unread > 0 && (
        <span
          className="chat-unread person-unread"
          aria-label={t('chat.direct.unreadFrom', { count: unread })}
          title={t('chat.direct.unreadFrom', { count: unread })}
        >
          {unread >= 100 ? '99+' : unread}
        </span>
      )}
    </div>
  );
}

/**
 * What a right-click on someone offers: a direct message (ADR 0047), to
 * anyone; and to an admin, what may be done to their account, the same as
 * Settings › Accounts, by the same rules (an admin manages users, only the
 * super admin manages admins, nobody the super admin). The server checks
 * each again; hiding one is only so nobody is offered what will be refused.
 */
function PersonMenu({
  person,
  x,
  y,
  myRole,
  admin,
  onMessage,
  onClose,
}: {
  person: ChatPerson;
  x: number;
  y: number;
  myRole: AccountRole;
  /** Whether to offer the account's management at all. */
  admin: boolean;
  onMessage?: () => void;
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
    if (!admin) return undefined;
    let live = true;
    void window.zoia.admin.accounts().then((outcome) => {
      if (!live) return;
      if (!outcome.ok) setError(t('admin.loadFailed'));
      else setAccount(outcome.value.find((a) => a.id === person.id) ?? 'missing');
    });
    return () => {
      live = false;
    };
  }, [person.id, t, admin]);

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

      {onMessage && (
        <button
          type="button"
          role="menuitem"
          className="person-menu-item"
          onClick={() => {
            onClose();
            onMessage();
          }}
        >
          {t('chat.direct.send')}
        </button>
      )}
      {!admin ? null : issued ? (
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
