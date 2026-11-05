import { useEffect, useRef, useState } from 'react';
import type { ChatInfo, ChatPerson } from '../../shared/ipc';
import type { ChatController } from '../chat/useChat';
import { useAccountAvatar } from '../chat/avatars';
import { shownUnread } from '../chat/silence';
import { useSilencedChats } from '../chat/silence-store';
import Avatar from './Avatar';
import { SectionHeading, useFolded } from './Sidebar';
import { useT } from '../i18n';

/**
 * Your direct messages (ADR 0047), under the chats in the sidebar: one row
 * per person you have written to or who has written to you, the latest
 * conversation first. The + finds someone to write to; so does clicking them
 * in the People tab. Folded, the list keeps the open one and any unread.
 */
export default function DirectList({
  chat,
  me,
  collapsed,
  showing,
  onOpen,
  onError,
  onShow,
}: {
  chat: ChatController;
  me: string | null;
  collapsed: boolean;
  /** Whether a chat is what the main area shows now, so the open one is marked. */
  showing: boolean;
  onOpen: (id: string) => void;
  onError: (code: string) => void;
  /** Brings the chat forward, once a direct chat has been opened from the + . */
  onShow: () => void;
}) {
  const t = useT();
  const [folded, toggleFolded, unfold] = useFolded('direct');
  const [picking, setPicking] = useState(false);
  const silenced = useSilencedChats();
  const shown =
    collapsed || !folded
      ? chat.direct
      : chat.direct.filter(
          (c) => (showing && c.id === chat.openId) || shownUnread(c, silenced) > 0,
        );

  async function start(person: ChatPerson) {
    setPicking(false);
    const refused = await chat.openDirect(person.id);
    if (refused) onError(refused);
    else onShow();
  }

  return (
    <section className="member-group chat-group direct-group">
      {!collapsed && (
        <SectionHeading
          title={t('chat.direct.title')}
          count={chat.direct.length}
          folded={folded}
          onToggle={toggleFolded}
          add={{
            label: t('chat.direct.new'),
            full: null,
            onClick: () => {
              unfold();
              setPicking((open) => !open);
            },
          }}
        />
      )}
      {picking && !collapsed && (
        <PersonPicker
          people={chat.people.filter((p) => p.id !== me && !p.bot)}
          onPick={(person) => void start(person)}
          onCancel={() => setPicking(false)}
        />
      )}
      {shown.map((c) => (
        <DirectRow
          key={c.id}
          chat={c}
          current={showing && c.id === chat.openId}
          unread={shownUnread(c, silenced)}
          collapsed={collapsed}
          onOpen={() => onOpen(c.id)}
        />
      ))}
      {!collapsed && !folded && chat.direct.length === 0 && !picking && (
        <p className="direct-empty muted">{t('chat.direct.empty')}</p>
      )}
    </section>
  );
}

function DirectRow({
  chat,
  current,
  unread,
  collapsed,
  onOpen,
}: {
  chat: ChatInfo;
  current: boolean;
  unread: number;
  collapsed: boolean;
  onOpen: () => void;
}) {
  const t = useT();
  const image = useAccountAvatar(chat.peer?.id ?? '', chat.peer?.avatar);
  return (
    <div className="channel-row">
      <button
        className={`channel chat direct${current ? ' current' : ''}${unread > 0 ? ' unread' : ''}`}
        onClick={onOpen}
        aria-current={current ? 'true' : undefined}
        title={collapsed ? chat.name : undefined}
      >
        <span className="direct-avatar">
          <Avatar name={chat.name} image={image} live={false} />
        </span>
        <span className="channel-name">{chat.name}</span>
        {unread > 0 && (
          <span className="chat-unread" aria-label={t('chat.unread', { count: unread })}>
            {unread >= 100 ? '99+' : unread}
          </span>
        )}
      </button>
    </div>
  );
}

/** A box to find someone by name, and the people it matches. */
function PersonPicker({
  people,
  onPick,
  onCancel,
}: {
  people: ChatPerson[];
  onPick: (person: ChatPerson) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  const needle = query.trim().toLocaleLowerCase();
  const matches = people
    .filter((p) => !needle || p.name.toLocaleLowerCase().includes(needle))
    .slice(0, 8);
  const active = Math.min(index, Math.max(matches.length - 1, 0));
  return (
    <div className="direct-picker">
      <input
        ref={inputRef}
        type="search"
        value={query}
        placeholder={t('chat.direct.find')}
        aria-label={t('chat.direct.find')}
        onChange={(event) => {
          setQuery(event.target.value);
          setIndex(0);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel();
          else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const by = event.key === 'ArrowDown' ? 1 : -1;
            if (matches.length) setIndex((active + by + matches.length) % matches.length);
          } else if (event.key === 'Enter' && matches[active]) {
            event.preventDefault();
            onPick(matches[active]);
          }
        }}
      />
      {matches.length === 0 ? (
        <p className="direct-empty muted">{t('chat.direct.nobody')}</p>
      ) : (
        <ul role="listbox" aria-label={t('chat.direct.find')}>
          {matches.map((person, i) => (
            <PickRow
              key={person.id}
              person={person}
              active={i === active}
              onPick={() => onPick(person)}
              onHover={() => setIndex(i)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function PickRow({
  person,
  active,
  onPick,
  onHover,
}: {
  person: ChatPerson;
  active: boolean;
  onPick: () => void;
  onHover: () => void;
}) {
  const image = useAccountAvatar(person.id, person.avatar);
  return (
    <li
      role="option"
      aria-selected={active}
      className={active ? 'active' : undefined}
      onMouseEnter={onHover}
      onMouseDown={(event) => {
        event.preventDefault();
        onPick();
      }}
    >
      <Avatar name={person.name} image={image} live={false} role={person.role} />
      <span>{person.name}</span>
    </li>
  );
}
