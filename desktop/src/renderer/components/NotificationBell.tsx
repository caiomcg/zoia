import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  clearInbox,
  markAllRead,
  openInboxItem,
  unreadCount,
  useInbox,
  type InboxItem,
  type NotifyKind,
} from '../notify/notify';
import { useLanguage, useT } from '../i18n';

/**
 * The bell in your bar at the bottom of the sidebar (see notify.ts): how many
 * unread notifications there are, a short pulse when one arrives, and the
 * list of them, grouped, above it. Opening the list marks them read; clicking
 * one goes where it says, or, for one that leads nowhere, shows it in full.
 */
export default function NotificationBell() {
  const t = useT();
  const items = useInbox();
  const unread = unreadCount(items);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [pulse, setPulse] = useState(false);
  const last = useRef(unread);

  // One pulse for each arrival, not for each render.
  useEffect(() => {
    if (unread > last.current) {
      setPulse(true);
      const timer = setTimeout(() => setPulse(false), 1200);
      last.current = unread;
      return () => clearTimeout(timer);
    }
    last.current = unread;
    return undefined;
  }, [unread]);

  const close = () => {
    setAnchor(null);
    markAllRead();
  };

  return (
    <>
      <button
        className={`icon-button sidebar-settings notify-bell${pulse ? ' pulse' : ''}${anchor ? ' open' : ''}`}
        onClick={(event) =>
          anchor ? close() : setAnchor(event.currentTarget.getBoundingClientRect())
        }
        aria-expanded={anchor !== null}
        aria-haspopup="dialog"
        title={
          unread > 0 ? t('notify.bellUnread', { count: unread }) : t('settings.nav.notifications')
        }
        aria-label={
          unread > 0 ? t('notify.bellUnread', { count: unread }) : t('settings.nav.notifications')
        }
      >
        <IconBell />
        {unread > 0 && <span className="notify-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {anchor && <InboxPanel items={items} anchor={anchor} onClose={close} />}
    </>
  );
}

function InboxPanel({
  items,
  anchor,
  onClose,
}: {
  items: InboxItem[];
  anchor: DOMRect;
  onClose: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  // The entry read in full, by id: one that leads nowhere (an error, a
  // warning) opens here, since the list shows only its first lines.
  const [shownId, setShownId] = useState<number | null>(null);
  const shown = items.find((item) => item.id === shownId) ?? null;

  useEffect(() => {
    const away = (event: MouseEvent) => {
      const target = event.target as Element;
      if (!ref.current?.contains(target) && !target.closest?.('.notify-bell')) onClose();
    };
    // Back to the list first, then closed.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (shown) setShownId(null);
      else onClose();
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [onClose, shown]);

  // Under the bell at the top of the window, above it lower down; its right
  // edge with the bell's, kept on screen.
  const right = Math.max(8, window.innerWidth - anchor.right);
  const style =
    anchor.top < window.innerHeight / 2
      ? { top: anchor.bottom + 6, right }
      : { bottom: window.innerHeight - anchor.top + 8, right };

  return createPortal(
    <div
      ref={ref}
      className="notify-panel"
      role="dialog"
      aria-label={t('settings.nav.notifications')}
      style={style}
    >
      {shown ? (
        <Details item={shown} onBack={() => setShownId(null)} />
      ) : (
        <>
          <header>
            <b>{t('settings.nav.notifications')}</b>
            {items.length > 0 && (
              <button type="button" className="event-quiet" onClick={clearInbox}>
                {t('notify.clear')}
              </button>
            )}
          </header>
          {items.length === 0 ? (
            <p className="notify-empty">{t('notify.empty')}</p>
          ) : (
            <ul>
              {items.map((item) => (
                <Entry
                  key={item.id}
                  item={item}
                  onOpen={() => {
                    if (!item.target) return setShownId(item.id);
                    openInboxItem(item.id);
                    onClose();
                  }}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </div>,
    document.body,
  );
}

function Entry({ item, onOpen }: { item: InboxItem; onOpen: () => void }) {
  const t = useT();
  const { language } = useLanguage();
  const ago = relative(item.at, language);
  return (
    <li>
      <button
        type="button"
        className={`notify-entry ${item.kind}${item.tone ? ` tone-${item.tone}` : ''}${item.read ? '' : ' unread'}`}
        onClick={onOpen}
      >
        <span className="notify-entry-icon" aria-hidden="true">
          <KindIcon kind={item.kind} />
        </span>
        <span className="notify-entry-text">
          <span className="notify-entry-title">
            <b>{item.title}</b>
            {item.count > 1 && (
              <span className="notify-count">{t('notify.countNew', { count: item.count })}</span>
            )}
          </span>
          {item.body && <span className="notify-entry-body">{item.body}</span>}
          <span className="notify-entry-meta">
            {ago}
            {(item.actionLabel || !item.target) && (
              <>
                {' · '}
                <em>{item.target ? item.actionLabel : t('notify.details')}</em>
              </>
            )}
          </span>
        </span>
      </button>
    </li>
  );
}

/** One entry in full: all of its text, when exactly, and a way to copy it. */
function Details({ item, onBack }: { item: InboxItem; onBack: () => void }) {
  const t = useT();
  const { language } = useLanguage();
  const [copied, setCopied] = useState(false);
  const when = new Intl.DateTimeFormat(language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(item.at);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    const text = item.body ? `${item.title}\n${item.body}` : item.title;
    navigator.clipboard.writeText(text).then(
      () => setCopied(true),
      () => {
        // Not allowed or not focused: the text can still be selected by hand.
      },
    );
  };

  return (
    <>
      <header>
        <button type="button" className="event-quiet notify-back" onClick={onBack}>
          <IconBack />
          {t('notify.back')}
        </button>
        <button type="button" className="event-quiet" onClick={copy}>
          {copied ? t('notify.copied') : t('notify.copy')}
        </button>
      </header>
      <div className={`notify-details ${item.kind}${item.tone ? ` tone-${item.tone}` : ''}`}>
        <div className="notify-details-head">
          <span className="notify-entry-icon" aria-hidden="true">
            <KindIcon kind={item.kind} />
          </span>
          <b>{item.title}</b>
        </div>
        {item.body && <p className="notify-details-body">{item.body}</p>}
        <span className="notify-entry-meta">
          {when} · {relative(item.at, language)}
          {item.count > 1 && <> · {t('notify.countNew', { count: item.count })}</>}
        </span>
      </div>
    </>
  );
}

function IconBack() {
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
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

/** "now", "3 min ago", "2 h ago", in the reader's language. */
function relative(at: number, language: string): string {
  const rtf = new Intl.RelativeTimeFormat(language, { numeric: 'auto', style: 'short' });
  const minutes = Math.round((at - Date.now()) / 60_000);
  if (Math.abs(minutes) < 60) return rtf.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return rtf.format(hours, 'hour');
  return rtf.format(Math.round(hours / 24), 'day');
}

function IconBell() {
  return (
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
      <path d="M6 16V11a6 6 0 0112 0v5l2 2H4l2-2zM10 21h4" />
    </svg>
  );
}

function KindIcon({ kind }: { kind: NotifyKind }) {
  const common = {
    viewBox: '0 0 24 24',
    width: 14,
    height: 14,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  if (kind === 'event') {
    return (
      <svg {...common}>
        <rect x="3.5" y="5" width="17" height="15" rx="2" />
        <path d="M3.5 10h17M8 3v4M16 3v4" />
      </svg>
    );
  }
  if (kind === 'alert') {
    return (
      <svg {...common}>
        <path d="M12 3l10 18H2L12 3z" />
        <path d="M12 10v5M12 18h.01" />
      </svg>
    );
  }
  if (kind === 'mention') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="4" />
        <path d="M16 8v5a3 3 0 006 0v-1a10 10 0 10-4 8" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M4 5h16a1 1 0 011 1v10a1 1 0 01-1 1H10l-5 4v-4H4a1 1 0 01-1-1V6a1 1 0 011-1z" />
    </svg>
  );
}
