import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ChatInfo } from '../../shared/ipc';
import { useT } from '../i18n';
import { useFloatingMenu } from './useFloatingMenu';

/** A zaba: a chat tab with its own close control and pin menu. */
export default function ChatTab({
  chat,
  current,
  unread,
  pinned,
  onOpen,
  onClose,
  onPin,
}: {
  chat: ChatInfo;
  current: boolean;
  unread: number;
  pinned: boolean;
  onOpen: () => void;
  onClose: () => void;
  onPin: (pinned: boolean) => void;
}) {
  const t = useT();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const mentions = chat.mentions ?? 0;
  return (
    <div
      className={`main-tab chat-tab${current ? ' current' : ''}${pinned ? ' pinned' : ''}`}
      role="presentation"
      onMouseDown={(event) => {
        // Avoid starting the browser's middle-button autoscroll.
        if (event.button === 1) event.preventDefault();
      }}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        onClose();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <button
        role="tab"
        aria-selected={current}
        className="main-tab-select"
        onClick={onOpen}
        title={chat.name}
      >
        {pinned && (
          <span
            className="chat-tab-pin"
            role="img"
            aria-label={t('chat.pinnedTab')}
            title={t('chat.pinnedTab')}
          >
            <IconPin />
          </span>
        )}
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
      {menu && (
        <PinMenu
          name={chat.name}
          pinned={pinned}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onToggle={() => onPin(!pinned)}
        />
      )}
    </div>
  );
}

function PinMenu({
  name,
  pinned,
  x,
  y,
  onClose,
  onToggle,
}: {
  name: string;
  pinned: boolean;
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
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onAuxClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        role="menuitem"
        className="person-menu-item"
        onClick={() => {
          onClose();
          onToggle();
        }}
      >
        <IconPin />
        {t(pinned ? 'chat.unpinTab' : 'chat.pinTab')}
      </button>
    </div>,
    document.body,
  );
}

function IconPin() {
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
      <path d="M16 3l5 5-4 1-4 4v4l-2 2-6-6 2-2h4l4-4 1-4zM8 16l-5 5" />
    </svg>
  );
}
