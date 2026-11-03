import type { ChatInfo } from '../../shared/ipc';
import { useT } from '../i18n';

/** A chat tab with its own close control. */
export default function ChatTab({
  chat,
  current,
  unread,
  onOpen,
  onClose,
}: {
  chat: ChatInfo;
  current: boolean;
  unread: number;
  onOpen: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const mentions = chat.mentions ?? 0;
  return (
    <div className={`main-tab chat-tab${current ? ' current' : ''}`} role="presentation">
      <button
        role="tab"
        aria-selected={current}
        className="main-tab-select"
        onClick={onOpen}
        title={chat.name}
      >
        <span className="chat-hash" aria-hidden="true">
          #
        </span>
        <span className="main-tab-name">{chat.name}</span>
        {mentions > 0 && (
          <span
            className="chat-mention-badge"
            aria-label={t('chat.mentionsUnread', { count: mentions })}
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
      <button
        className="main-tab-close"
        title={t('chat.closeTab', { chat: chat.name })}
        aria-label={t('chat.closeTab', { chat: chat.name })}
        onClick={onClose}
      >
        <svg
          viewBox="0 0 24 24"
          width="14"
          height="14"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  );
}
