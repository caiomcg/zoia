import { useState } from 'react';
import type { AccountRole } from '../../shared/ipc';
import type { ChatController } from '../chat/useChat';
import { ChannelNameField, IconPencil, IconTrash, shortName } from './Sidebar';
import { useT } from '../i18n';

/**
 * The text chats, under the channels in the sidebar (ADR 0035). Clicking one
 * opens it in the main area. Admins add, rename and remove chats as they do
 * channels; the super admin also sets how many there may be. The server
 * checks every one of those again.
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
  const isSuper = myRole === 'super_admin';

  const report = (pending: Promise<string | null>) =>
    void pending.then((code) => {
      if (code) onError(code);
    });

  return (
    <section className="member-group chat-group">
      {!collapsed && (
        <div className="chat-heading">
          <h2 className="member-heading">{t('chat.title')}</h2>
          {isSuper && (
            <span className="chat-limit" title={t('chat.limitTitle')}>
              <button
                className="channel-action"
                disabled={chat.max <= 1}
                onClick={() => report(chat.setLimit(chat.max - 1))}
                aria-label={t('chat.limitLess')}
                title={t('chat.limitLess')}
              >
                −
              </button>
              <span className="chat-limit-value">
                {t('chat.limitValue', { count: chat.chats.length, max: chat.max })}
              </span>
              <button
                className="channel-action"
                disabled={chat.max >= chat.ceiling}
                onClick={() => report(chat.setLimit(chat.max + 1))}
                aria-label={t('chat.limitMore')}
                title={t('chat.limitMore')}
              >
                +
              </button>
            </span>
          )}
        </div>
      )}

      {chat.chats.map((c) => {
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
                    onClick={() => {
                      if (window.confirm(t('chat.deleteConfirm', { chat: c.name }))) {
                        report(chat.remove(c.id));
                      }
                    }}
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

      {editing === 'new' ? (
        <ChannelNameField
          initial=""
          label={t('chat.name')}
          onDone={(name) => {
            setEditing(null);
            if (name) report(chat.create(name));
          }}
        />
      ) : (
        canManage &&
        !collapsed &&
        chat.chats.length < chat.max && (
          <button className="channel channel-new" onClick={() => setEditing('new')}>
            <span className="channel-name">{t('chat.new')}</span>
          </button>
        )
      )}
    </section>
  );
}
