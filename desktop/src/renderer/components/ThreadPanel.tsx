import type { ChatMessage } from '../../shared/ipc';
import type { ThreadController } from '../chat/useThread';
import { useAccountAvatar } from '../chat/avatars';
import Avatar from './Avatar';
import ChatView, { IconThread } from './ChatView';
import MessageText from './MessageText';
import { useLanguage, useT } from '../i18n';

/**
 * A message's thread (ADR 0048), in a panel beside its chat: the message it
 * answers at the top, then its replies and a box to write one, as in any chat.
 * Escape or the close button puts it away. A thread whose message was deleted
 * goes with it, and the panel says so.
 */
export default function ThreadPanel({
  thread,
  chatName,
  direct,
  me,
  canModerate,
  visible,
  onClose,
}: {
  thread: ThreadController;
  /** The chat it is in, as its header names it. */
  chatName: string;
  /** In a direct chat, named with @ rather than #. */
  direct: boolean;
  me: string | null;
  canModerate: boolean;
  visible: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const header = (
    <header className="chat-header thread-header">
      <IconThread />
      <h2>{t('chat.thread.title')}</h2>
      <span className="thread-where muted">
        {direct ? '@' : '#'}
        {chatName}
      </span>
      <button
        type="button"
        className="channel-action thread-close"
        onClick={onClose}
        aria-label={t('chat.thread.close')}
        title={t('chat.thread.close')}
      >
        ×
      </button>
    </header>
  );

  if (thread.rootGone) {
    return (
      <div className="thread-panel" onKeyDown={(event) => event.key === 'Escape' && onClose()}>
        <section className="chat-view thread-view">
          {header}
          <p className="chat-empty muted">{t('chat.thread.gone')}</p>
        </section>
      </div>
    );
  }

  return (
    <div className="thread-panel" onKeyDown={(event) => event.key === 'Escape' && onClose()}>
      <ChatView
        chat={thread}
        me={me}
        canModerate={canModerate}
        visible={visible}
        variant="thread"
        header={
          <>
            {header}
            {thread.root && (
              <RootMessage
                message={thread.root}
                author={thread.authors[thread.root.authorId]}
                me={me}
              />
            )}
          </>
        }
        placeholder={t('chat.thread.placeholder')}
      />
    </div>
  );
}

/** The message a thread answers, as it reads now. */
function RootMessage({
  message,
  author,
  me,
}: {
  message: ChatMessage;
  author: { name: string; avatar: string | null; bot?: boolean } | null | undefined;
  me: string | null;
}) {
  const t = useT();
  const { language } = useLanguage();
  const name = author?.name ?? t('chat.someone');
  const image = useAccountAvatar(message.authorId, author?.avatar);
  const when = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <div className="thread-root">
      <Avatar name={name} live={false} image={image} bot={author?.bot} />
      <div className="chat-content">
        <div className="chat-meta">
          <span className="chat-author">{name}</span>
          <time dateTime={message.sentAt}>{when.format(new Date(message.sentAt))}</time>
        </div>
        {message.body ? (
          <MessageText body={message.body} mentions={message.mentions} me={me} />
        ) : (
          <div className="chat-body muted">
            {message.attachment?.kind === 'video' ? t('chat.video') : t('chat.photo')}
          </div>
        )}
      </div>
    </div>
  );
}
