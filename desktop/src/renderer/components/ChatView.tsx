import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import {
  CHAT_MEDIA_MAX_BYTES,
  chatMediaUrl,
  type ChatAttachment,
  type ChatAuthor,
  type ChatMessage,
} from '../../shared/ipc';
import type { ChatController } from '../chat/useChat';
import { useAccountAvatar } from '../chat/avatars';
import { continues, newMessagesIndex, sameDay, seenBy } from '../chat/model';
import Avatar from './Avatar';
import { useLanguage, useT } from '../i18n';

/** Must match MESSAGE_MAX in server/src/messages.js. */
const MESSAGE_MAX = 4000;

/** Within this many pixels of the bottom counts as reading the latest. */
const STICK_PX = 80;

/** What the server accepts; it checks the bytes again whatever this says. */
const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm';

/** Why a file cannot be sent, judged before it is uploaded; null when it can. */
function fileProblem(file: File): 'tooLarge' | 'unsupported' | null {
  if (!ACCEPT.split(',').includes(file.type)) return 'unsupported';
  if (file.size > CHAT_MEDIA_MAX_BYTES) return 'tooLarge';
  return null;
}

/**
 * The open chat (ADR 0036): its messages, newest at the bottom, and a box to
 * write in. Enter sends and Shift+Enter starts a new line. A photo or video
 * goes in by the clip button, by pasting or by dropping it on the chat, and is
 * sent with whatever is typed as its caption. Scrolling to the top loads
 * older messages; a new one scrolls into view only when you were already at
 * the bottom, so reading back is not interrupted.
 */
export default function ChatView({ chat, me }: { chat: ChatController; me: string | null }) {
  const t = useT();
  const { language } = useLanguage();
  const [draft, setDraft] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
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

  // A new chat starts at its newest message, with nothing half-sent from the last.
  useLayoutEffect(() => {
    stickRef.current = true;
    setError(null);
    setFile(null);
  }, [thread?.chatId]);

  // The chosen file, shown before it is sent.
  useEffect(() => {
    if (!file) {
      setPreview(null);
      return undefined;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  /** A picture that loaded late grew the list: keep the newest in view. */
  function onMediaLoad() {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    if (el.scrollTop < 40 && thread?.hasMore && !thread.loadingOlder) {
      anchorRef.current = el.scrollHeight;
      void chat.loadOlder();
    }
  }

  function choose(next: File | undefined | null) {
    if (!next) return;
    const problem = fileProblem(next);
    if (problem) {
      setError(t(problem === 'tooLarge' ? 'chat.error.tooLarge' : 'chat.error.unsupported'));
      return;
    }
    setError(null);
    setFile(next);
  }

  async function submit() {
    const body = draft.trim();
    if ((!body && !file) || sending) return;
    setSending(true);
    setError(null);
    const refused = await chat.send(body, file ?? undefined);
    setSending(false);
    if (refused) {
      setError(errorText(refused));
      return;
    }
    stickRef.current = true;
    setDraft('');
    setFile(null);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = [...event.clipboardData.files][0];
    if (pasted) {
      event.preventDefault();
      choose(pasted);
    }
  }

  function onDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragging(false);
    if (chat.available) choose(event.dataTransfer.files[0]);
  }

  function errorText(code: string): string {
    if (code === 'too_many_messages') return t('chat.error.tooMany');
    if (code === 'chat_unavailable') return t('chat.unavailable');
    if (code === 'invalid_message') return t('chat.error.invalid');
    if (code === 'media_too_large') return t('chat.error.tooLarge');
    if (code === 'unsupported_media') return t('chat.error.unsupported');
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

  const divider =
    me && chat.readWhenOpened !== undefined
      ? newMessagesIndex(messages, chat.readWhenOpened, me)
      : -1;
  const last = messages.at(-1);
  // Others only: that you have seen what is on your screen goes without saying.
  const seen = last ? seenBy(last, chat.readers).filter((id) => id !== me) : [];
  const nameOf = (id: string) => chat.authors[id]?.name ?? t('chat.someone');

  return (
    <section
      className={`chat-view${dragging ? ' dragging' : ''}`}
      aria-label={chat.openChat?.name}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
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
                  onMediaLoad={onMediaLoad}
                  onView={setViewing}
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

      {dragging && (
        <div className="chat-drop" aria-hidden="true">
          {t('chat.drop')}
        </div>
      )}

      <form
        className="chat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {file && preview && (
          <div className="chat-pending">
            {file.type.startsWith('video/') ? (
              <video src={preview} muted />
            ) : (
              <img src={preview} alt="" />
            )}
            <span className="chat-pending-name">{file.name}</span>
            <button
              type="button"
              className="channel-action"
              onClick={() => setFile(null)}
              aria-label={t('chat.removeAttachment')}
              title={t('chat.removeAttachment')}
            >
              ×
            </button>
          </div>
        )}
        <div className="chat-composer-row">
          <button
            type="button"
            className="chat-attach"
            disabled={!chat.available || sending}
            onClick={() => fileInputRef.current?.click()}
            aria-label={t('chat.attach')}
            title={t('chat.attach')}
          >
            <svg
              viewBox="0 0 24 24"
              width="18"
              height="18"
              aria-hidden="true"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 11.5l-8.5 8.5a5 5 0 01-7-7L14 4.5a3.5 3.5 0 015 5l-8.5 8.5a2 2 0 01-3-3L15 7.5" />
            </svg>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT}
            hidden
            onChange={(event) => {
              choose(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
          <textarea
            value={draft}
            rows={1}
            maxLength={MESSAGE_MAX}
            disabled={!chat.available}
            placeholder={
              file
                ? t('chat.caption')
                : chat.openChat
                  ? t('chat.placeholder', { chat: chat.openChat.name })
                  : t('chat.unavailable')
            }
            aria-label={t('chat.placeholder', { chat: chat.openChat?.name ?? '' })}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          <button
            type="submit"
            className="chat-send"
            disabled={!chat.available || sending || (!draft.trim() && !file)}
            aria-label={sending ? t('chat.sending') : t('chat.send')}
            title={sending ? t('chat.sending') : t('chat.send')}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor">
              <path d="M3.4 20.4l17.45-7.48a1 1 0 000-1.84L3.4 3.6a.99.99 0 00-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91z" />
            </svg>
          </button>
        </div>
        {error && <p className="chat-error">{error}</p>}
      </form>

      {viewing && (
        <div
          className="chat-lightbox"
          role="dialog"
          aria-label={t('chat.photo')}
          onClick={() => setViewing(null)}
          onKeyDown={(event) => event.key === 'Escape' && setViewing(null)}
          tabIndex={-1}
          ref={(el) => el?.focus()}
        >
          <img src={viewing} alt="" />
        </div>
      )}
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
  onMediaLoad,
  onView,
}: {
  message: ChatMessage;
  author: ChatAuthor;
  grouped: boolean;
  dayLabel: string | null;
  newMessages: boolean;
  time: string;
  mine: boolean;
  onMediaLoad: () => void;
  onView: (url: string) => void;
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
          {message.attachment && (
            <Attachment
              chatId={message.chatId}
              attachment={message.attachment}
              onLoad={onMediaLoad}
              onView={onView}
            />
          )}
          {message.body && <p className="chat-body">{message.body}</p>}
        </div>
      </li>
    </>
  );
}

function Attachment({
  chatId,
  attachment,
  onLoad,
  onView,
}: {
  chatId: string;
  attachment: ChatAttachment;
  onLoad: () => void;
  onView: (url: string) => void;
}) {
  const t = useT();
  const src = chatMediaUrl(chatId, attachment.id);
  if (attachment.kind === 'video') {
    return (
      <video
        className="chat-media"
        src={src}
        controls
        preload="metadata"
        onLoadedMetadata={onLoad}
        aria-label={attachment.name ?? t('chat.video')}
      />
    );
  }
  return (
    <button type="button" className="chat-media-button" onClick={() => onView(src)}>
      <img
        className="chat-media"
        src={src}
        alt={attachment.name ?? t('chat.photo')}
        loading="lazy"
        onLoad={onLoad}
      />
    </button>
  );
}
