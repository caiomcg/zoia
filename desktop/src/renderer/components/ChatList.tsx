import { useState } from 'react';
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

/**
 * The text chats, under the channels in the sidebar (ADR 0036). Clicking one
 * opens it in the main area. Admins add, rename and remove chats as they do
 * channels; how many there may be is in Settings › Server. The server checks
 * every one of those again. Folded, the list keeps the open chat and any
 * with something unread.
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
  const shown =
    collapsed || !folded
      ? chat.chats
      : chat.chats.filter((c) => (showing && c.id === chat.openId) || (c.unread ?? 0) > 0);

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
        const unread = c.unread ?? 0;
        return (
          <div key={c.id} className="channel-row">
            <button
              className={`channel chat${current ? ' current' : ''}${unread > 0 ? ' unread' : ''}`}
              onClick={() => onOpen(c.id)}
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
      {dialog}
    </section>
  );
}
