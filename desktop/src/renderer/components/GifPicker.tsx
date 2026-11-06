import { useEffect, useRef, useState, type RefObject } from 'react';
import type { GifResult } from '../../shared/ipc';
import { useT } from '../i18n';

/** How long typing settles before searching. */
const SEARCH_DELAY_MS = 350;

/**
 * GIFs from KLIPY over the message box (ADR 0051): trending until you type,
 * then what you searched, more as you scroll. A click sends one. Closes on
 * Escape or a click elsewhere, as the emoji picker does.
 */
export default function GifPicker({
  onPick,
  onClose,
  toggle,
}: {
  onPick: (gif: GifResult) => void;
  onClose: () => void;
  /** The button that opens it, whose own click must not count as elsewhere. */
  toggle: RefObject<HTMLButtonElement | null>;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [gifs, setGifs] = useState<GifResult[]>([]);
  const [page, setPage] = useState(1);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!ref.current?.contains(target) && !toggle.current?.contains(target)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    searchRef.current?.focus();
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose, toggle]);

  // A new search starts over; a later page adds to what is shown.
  useEffect(() => {
    let stale = false;
    const run = async () => {
      setLoading(true);
      const result = await window.zoia.chat.gifs(query.trim(), page).catch(() => null);
      if (stale) return;
      setLoading(false);
      if (!result?.ok) {
        setFailed(true);
        return;
      }
      setFailed(false);
      setMore(result.value.more);
      setGifs((shown) => {
        if (page === 1) return result.value.gifs;
        const seen = new Set(shown.map((g) => g.id));
        return [...shown, ...result.value.gifs.filter((g) => !seen.has(g.id))];
      });
    };
    const timer = setTimeout(() => void run(), page === 1 && query ? SEARCH_DELAY_MS : 0);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [query, page]);

  const onScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const box = event.currentTarget;
    if (more && !loading && box.scrollTop + box.clientHeight > box.scrollHeight - 120) {
      setPage((p) => p + 1);
    }
  };

  return (
    <div ref={ref} className="chat-gif-picker" role="dialog" aria-label={t('chat.gif')}>
      {/* The soundboard's search field, so every search in Zoia looks alike. */}
      <div className="soundboard-search chat-gif-search">
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-3.5-3.5" />
        </svg>
        <input
          ref={searchRef}
          type="search"
          value={query}
          placeholder={t('chat.gifSearch')}
          aria-label={t('chat.gifSearch')}
          maxLength={100}
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(1);
          }}
        />
      </div>
      <div className="chat-gif-scroll" onScroll={onScroll}>
        {failed ? (
          <p className="muted chat-gif-note">{t('chat.gifFailed')}</p>
        ) : gifs.length === 0 && !loading ? (
          <p className="muted chat-gif-note">{t('chat.gifNone')}</p>
        ) : (
          <div className="chat-gif-grid">
            {gifs.map((gif) => (
              <button
                key={gif.id}
                type="button"
                className="chat-gif-item"
                onClick={() => onPick(gif)}
                title={gif.title}
                aria-label={gif.title || t('chat.gif')}
              >
                <img src={gif.preview} alt="" loading="lazy" draggable={false} />
              </button>
            ))}
          </div>
        )}
        {loading && <p className="muted chat-gif-note">{t('chat.gifLoading')}</p>}
      </div>
      <span className="chat-gif-credit">{t('chat.gifCredit')}</span>
    </div>
  );
}
