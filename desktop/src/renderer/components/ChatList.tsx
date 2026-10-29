import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AccountRole } from '../../shared/ipc';
import type { ChatController } from '../chat/useChat';
import {
  ChannelNameField,
  IconPencil,
  IconTrash,
  SectionHeading,
  shortName,
  useFolded,
} from './Sidebar';
import { useT } from '../i18n';
import { useConfirm } from './ConfirmDialog';
import { useFloatingMenu } from './useFloatingMenu';
import { shownUnread } from '../chat/silence';
import { setChatSilenced, useSilencedChats } from '../chat/silence-store';

/**
 * The text chats, under the channels in the sidebar (ADR 0036). Clicking one
 * opens it in the main area. Admins add, rename and remove chats as they do
 * channels; how many there may be is in Settings › Server. The server checks
 * every one of those again. Folded, the list keeps the open chat and any
 * with something unread.
 *
 * Right-clicking a chat silences it on this machine, or unsilences it: its
 * count is only of the messages that @mention you, and nothing in it plays a
 * sound (see chat/silence.ts). A silenced chat is dimmed, with a crossed-out bell.
 */
export default function ChatList({
  chat,
  collapsed,
  showing,
  onOpen,
  myRole,
  onError,
}: {
  chat: ChatController;
  collapsed: boolean;
  /** Whether a chat is what the main area shows now, so the open one is marked. */
  showing: boolean;
  onOpen: (id: string) => void;
  myRole?: AccountRole;
  /** A refusal from the server, as its code. */
  onError: (code: string) => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState<string | null>(null);
  const canManage = myRole === 'admin' || myRole === 'super_admin';
  const { confirm, dialog } = useConfirm();
  const [folded, toggleFolded, unfold] = useFolded('chats');
  const silenced = useSilencedChats();
  const [menu, setMenu] = useState<{ id: string; name: string; x: number; y: number } | null>(null);
  const shown =
    collapsed || !folded
      ? chat.chats
      : chat.chats.filter((c) => (showing && c.id === chat.openId) || shownUnread(c, silenced) > 0);

  const report = (pending: Promise<string | null>) =>
    void pending.then((code) => {
      if (code) onError(code);
    });

  return (
    <section className="member-group chat-group">
      {!collapsed && (
        <SectionHeading
          title={t('chat.title')}
          count={chat.chats.length}
          folded={folded}
          onToggle={toggleFolded}
          add={
            canManage
              ? {
                  label: t('chat.new'),
                  full: chat.chats.length >= chat.max ? t('chat.full') : null,
                  onClick: () => {
                    unfold();
                    setEditing('new');
                  },
                }
              : undefined
          }
        />
      )}

      {shown.map((c) => {
        const current = showing && c.id === chat.openId;
        if (editing === c.id) {
          return (
            <ChannelNameField
              key={c.id}
              initial={c.name}
              label={t('chat.name')}
              onDone={(name) => {
                setEditing(null);
                if (name && name !== c.name) report(chat.rename(c.id, name));
              }}
            />
          );
        }
        const quiet = silenced.has(c.id);
        const unread = shownUnread(c, silenced);
        const mentions = c.mentions ?? 0;
        return (
          <div key={c.id} className="channel-row">
            <button
              className={`channel chat${current ? ' current' : ''}${unread > 0 ? ' unread' : ''}${mentions > 0 ? ' mentioned' : ''}${quiet ? ' silenced' : ''}`}
              onClick={() => onOpen(c.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ id: c.id, name: c.name, x: event.clientX, y: event.clientY });
              }}
              aria-current={current ? 'true' : undefined}
              title={collapsed ? c.name : undefined}
            >
              <span className="channel-short" aria-hidden="true">
                {shortName(c.name)}
              </span>
              <span className="chat-hash" aria-hidden="true">
                #
              </span>
              <span className="channel-name">{c.name}</span>
              {quiet && (
                <span
                  className="chat-silenced"
                  role="img"
                  aria-label={t('chat.silenced')}
                  title={t('chat.silenced')}
                >
                  <IconBell crossed />
                </span>
              )}
              {mentions > 0 && (
                <span
                  className="chat-mention-badge"
                  aria-label={t('chat.mentionsUnread', { count: mentions })}
                  title={t('chat.mentionsUnread', { count: mentions })}
                >
                  @
                </span>
              )}
              {unread > 0 && (
                <span className="chat-unread" aria-label={t('chat.unread', { count: unread })}>
                  {unread >= 100 ? '99+' : unread}
                </span>
              )}
            </button>
            {canManage && !collapsed && (
              <span className="channel-actions">
                <button
                  className="channel-action"
                  onClick={() => setEditing(c.id)}
                  title={t('chat.rename', { chat: c.name })}
                  aria-label={t('chat.rename', { chat: c.name })}
                >
                  <IconPencil />
                </button>
                {!c.isDefault && (
                  <button
                    className="channel-action"
                    onClick={() =>
                      void confirm(
                        t('chat.deleteConfirm', { chat: c.name }),
                        t('chat.delete', { chat: c.name }),
                      ).then((yes) => {
                        if (yes) report(chat.remove(c.id));
                      })
                    }
                    title={t('chat.delete', { chat: c.name })}
                    aria-label={t('chat.delete', { chat: c.name })}
                  >
                    <IconTrash />
                  </button>
                )}
              </span>
            )}
          </div>
        );
      })}

      {editing === 'new' && (
        <ChannelNameField
          initial=""
          label={t('chat.name')}
          onDone={(name) => {
            setEditing(null);
            if (name) report(chat.create(name));
          }}
        />
      )}
      {menu && (
        <ChatMenu
          name={menu.name}
          silenced={silenced.has(menu.id)}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onToggle={() => setChatSilenced(menu.id, !silenced.has(menu.id))}
        />
      )}
      {dialog}
    </section>
  );
}

/** What a right-click on a chat offers: silencing it here, or undoing that. */
function ChatMenu({
  name,
  silenced,
  x,
  y,
  onClose,
  onToggle,
}: {
  name: string;
  silenced: boolean;
  x: number;
  y: number;
  onClose: () => void;
  onToggle: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const place = useFloatingMenu(ref, x, y, onClose);
  return createPortal(
    <div
      ref={ref}
      className="member-menu person-menu chat-menu"
      role="menu"
      aria-label={name}
      style={place}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="member-menu-head">
        <span className="chat-hash" aria-hidden="true">
          #
        </span>
        <span className="member-menu-name">{name}</span>
      </div>
      <button
        type="button"
        role="menuitem"
        className="person-menu-item"
        onClick={() => {
          onClose();
          onToggle();
        }}
      >
        <IconBell crossed={!silenced} />
        {silenced ? t('chat.unsilence') : t('chat.silence')}
      </button>
    </div>,
    document.body,
  );
}

/** A bell, crossed out for silenced. */
function IconBell({ crossed = false }: { crossed?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 16V11a6 6 0 0112 0v5l2 2H4l2-2zM10 21h4" />
      {crossed && <path d="M3 3l18 18" />}
    </svg>
  );
}
