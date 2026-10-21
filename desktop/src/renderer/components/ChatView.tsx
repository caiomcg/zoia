import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ChatAuthor, ChatMessage } from '../../shared/ipc';
import type { ChatController } from '../chat/useChat';
import { useAccountAvatar } from '../chat/avatars';
import { continues, newMessagesIndex, sameDay, seenBy } from '../chat/model';
import Avatar from './Avatar';
import { useLanguage, useT } from '../i18n';

/** Must match MESSAGE_MAX in server/src/messages.js. */
const MESSAGE_MAX = 4000;

/** Within this many pixels of the bottom counts as reading the latest. */
const STICK_PX = 80;

/**
 * The open chat (ADR 0035): its messages, newest at the bottom, and a box to
 * write in. Enter sends and Shift+Enter starts a new line. Scrolling to the
 * top loads older messages; a new one scrolls into view only when you were
 * already at the bottom, so reading back is not interrupted.
 */
export default function ChatView({ chat, me }: { chat: ChatController; me: string | null }) {
  const t = useT();
  const { language } = useLanguage();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  // The scroll height before older messages were added above, to keep your place.
  const anchorRef = useRef<number | null>(null);

  const thread = chat.thread;
  const messages = thread?.messages ?? [];
  const lastId = messages.at(-1)?.id;
  const firstId = messages[0]?.id;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (anchorRef.current !== null) {
      el.scrollTop = el.scrollHeight - anchorRef.current;
      anchorRef.current = null;
    } else if (stickRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lastId, firstId, thread?.chatId]);

  // A new chat starts at its newest message.
  useLayoutEffect(() => {
    stickRef.current = true;
    setError(null);
  }, [thread?.chatId]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    if (el.scrollTop < 40 && thread?.hasMore && !thread.loadingOlder) {
      anchorRef.current = el.scrollHeight;
      void chat.loadOlder();
    }
  }

  async function submit() {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    const refused = await chat.send(body);
    setSending(false);
    if (refused) {
      setError(errorText(refused));
      return;
    }
    stickRef.current = true;
    setDraft('');
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  function errorText(code: string): string {
    if (code === 'too_many_messages') return t('chat.error.tooMany');
    if (code === 'chat_unavailable') return t('chat.unavailable');
    if (code === 'invalid_message') return t('chat.error.invalid');
    return t('chat.error.generic');
  }

  const time = new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit' });
  const day = new Intl.DateTimeFormat(language, { weekday: 'long', day: 'numeric', month: 'long' });
  const dayLabel = (iso: string) => {
    const now = new Date().toISOString();
    if (sameDay(iso, now)) return t('chat.today');
    if (sameDay(iso, new Date(Date.now() - 86_400_000).toISOString())) return t('chat.yesterday');
    return day.format(new Date(iso));
  };

  const divider = me ? newMessagesIndex(messages, chat.readWhenOpened, me) : -1;
  const last = messages.at(-1);
  // Others only: that you have seen what is on your screen goes without saying.
  const seen = last ? seenBy(last, chat.readers).filter((id) => id !== me) : [];
  const nameOf = (id: string) => chat.authors[id]?.name ?? t('chat.someone');

  return (
    <section className="chat-view" aria-label={chat.openChat?.name}>
      <header className="chat-header">
        <span className="chat-hash" aria-hidden="true">
          #
        </span>
        <h2>{chat.openChat?.name}</h2>
      </header>

      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        {!chat.available ? (
          <p className="chat-empty muted">{t('chat.unavailable')}</p>
        ) : thread?.loading ? (
          <p className="chat-empty muted">{t('common.loading')}</p>
        ) : thread?.error ? (
          <p className="chat-empty muted">{t('chat.error.load')}</p>
        ) : messages.length === 0 ? (
          <p className="chat-empty muted">{t('chat.empty')}</p>
        ) : (
          <ol className="chat-messages">
            {thread?.loadingOlder && <li className="chat-older muted">{t('common.loading')}</li>}
            {messages.map((m, i) => {
              const previous = messages[i - 1];
              const newDay = !previous || !sameDay(previous.sentAt, m.sentAt);
              return (
                <MessageRow
                  key={m.id}
                  message={m}
                  author={chat.authors[m.authorId] ?? null}
                  grouped={!newDay && i !== divider && continues(previous, m)}
                  dayLabel={newDay ? dayLabel(m.sentAt) : null}
                  newMessages={i === divider}
                  time={time.format(new Date(m.sentAt))}
                  mine={m.authorId === me}
                />
              );
            })}
          </ol>
        )}
        {seen.length > 0 && (
          <p className="chat-seen muted">
            {t('chat.seenBy', { names: seen.map(nameOf).join(', ') })}
          </p>
        )}
      </div>

      <form
        className="chat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <textarea
          value={draft}
          rows={1}
          maxLength={MESSAGE_MAX}
          disabled={!chat.available}
          placeholder={
            chat.openChat
              ? t('chat.placeholder', { chat: chat.openChat.name })
              : t('chat.unavailable')
          }
          aria-label={t('chat.placeholder', { chat: chat.openChat?.name ?? '' })}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          type="submit"
          className="chat-send"
          disabled={!chat.available || sending || !draft.trim()}
          aria-label={t('chat.send')}
          title={t('chat.send')}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor">
            <path d="M3.4 20.4l17.45-7.48a1 1 0 000-1.84L3.4 3.6a.99.99 0 00-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91z" />
          </svg>
        </button>
        {error && <p className="chat-error">{error}</p>}
      </form>
    </section>
  );
}

function MessageRow({
  message,
  author,
  grouped,
  dayLabel,
  newMessages,
  time,
  mine,
}: {
  message: ChatMessage;
  author: ChatAuthor;
  grouped: boolean;
  dayLabel: string | null;
  newMessages: boolean;
  time: string;
  mine: boolean;
}) {
  const t = useT();
  const name = author?.name ?? t('chat.someone');
  const image = useAccountAvatar(message.authorId, author?.avatar);
  return (
    <>
      {dayLabel && (
        <li className="chat-day" role="separator">
          <span>{dayLabel}</span>
        </li>
      )}
      {newMessages && (
        <li className="chat-new" role="separator">
          <span>{t('chat.newMessages')}</span>
        </li>
      )}
      <li className={`chat-message${grouped ? ' grouped' : ''}${mine ? ' mine' : ''}`}>
        {grouped ? (
          <time className="chat-time-side" dateTime={message.sentAt}>
            {time}
          </time>
        ) : (
          <Avatar name={name} live={false} image={image} />
        )}
        <div className="chat-content">
          {!grouped && (
            <div className="chat-meta">
              <span className="chat-author">{name}</span>
              <time dateTime={message.sentAt}>{time}</time>
            </div>
          )}
          <p className="chat-body">{message.body}</p>
        </div>
      </li>
    </>
  );
}
