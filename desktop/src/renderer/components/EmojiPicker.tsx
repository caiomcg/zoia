import { useEffect, useRef, type MouseEvent as ReactMouseEvent, type RefObject } from 'react';
import { EMOJI_GROUPS } from '../chat/emoji';
import { useT } from '../i18n';

/**
 * Emoji to put in a message, over the message box: the ones you used last,
 * then each kind. It stays open for picking several, and closes on Escape
 * or a click elsewhere. The last button opens the system's own picker,
 * with every other emoji and search, which types into the box.
 */
export default function EmojiPicker({
  recent,
  onPick,
  onMore,
  onClose,
  toggle,
}: {
  recent: readonly string[];
  onPick: (emoji: string) => void;
  onMore: () => void;
  onClose: () => void;
  /** The button that opens it, whose own click must not count as elsewhere. */
  toggle: RefObject<HTMLButtonElement | null>;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
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
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose, toggle]);

  // The message box keeps the focus, so the emoji goes where its caret is.
  const keepFocus = (event: ReactMouseEvent) => event.preventDefault();
  const groups = [
    ...(recent.length > 0 ? [{ id: 'recent' as const, emoji: recent }] : []),
    ...EMOJI_GROUPS,
  ];

  return (
    <div ref={ref} className="chat-emoji-picker" role="dialog" aria-label={t('chat.emoji')}>
      <div className="chat-emoji-scroll">
        {groups.map((group) => (
          <section key={group.id} className="chat-emoji-group">
            <h3>{t(`chat.emoji.${group.id}`)}</h3>
            <div className="emoji-grid">
              {group.emoji.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onMouseDown={keepFocus}
                  onClick={() => onPick(emoji)}
                  aria-label={emoji}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
      <button type="button" className="chat-emoji-more" onMouseDown={keepFocus} onClick={onMore}>
        {t('sidebar.moreEmoji')}…
      </button>
    </div>
  );
}
