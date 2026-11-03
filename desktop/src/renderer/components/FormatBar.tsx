import type { ReactNode, RefObject } from 'react';
import type { MessageKey } from '../../shared/i18n';
import { applyFormat, FORMAT_KEYS, type FormatAction } from '../chat/format';
import { useT } from '../i18n';

const MOD = window.zoia.app.platform === 'darwin' ? 'Cmd' : 'Ctrl';

const stroke = {
  viewBox: '0 0 24 24',
  width: 16,
  height: 16,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

/** The bar's buttons, in its order; a gap falls between the groups. */
const GROUPS: { action: FormatAction; label: MessageKey; icon: ReactNode }[][] = [
  [
    { action: 'bold', label: 'chat.format.bold', icon: <b>B</b> },
    { action: 'italic', label: 'chat.format.italic', icon: <i>I</i> },
    { action: 'underline', label: 'chat.format.underline', icon: <u>U</u> },
    { action: 'strike', label: 'chat.format.strike', icon: <s>S</s> },
  ],
  [
    {
      action: 'spoiler',
      label: 'chat.format.spoiler',
      icon: (
        <svg {...stroke}>
          <path d="M3 3l18 18M10.6 5.1A9.8 9.8 0 0112 5c5 0 9 4.5 10 7a13 13 0 01-2.9 3.9M6.2 6.2C3.9 7.6 2.5 9.8 2 12c1 2.5 5 7 10 7 1.9 0 3.6-.6 5-1.5M9.9 9.9a3 3 0 004.2 4.2" />
        </svg>
      ),
    },
    {
      action: 'code',
      label: 'chat.format.code',
      icon: (
        <svg {...stroke}>
          <path d="M8 7l-5 5 5 5M16 7l5 5-5 5" />
        </svg>
      ),
    },
    {
      action: 'codeBlock',
      label: 'chat.format.codeBlock',
      icon: (
        <svg {...stroke}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M8 10l-2 2 2 2M16 10l2 2-2 2M13 9l-2 6" />
        </svg>
      ),
    },
  ],
  [
    {
      action: 'quote',
      label: 'chat.format.quote',
      icon: (
        <svg {...stroke}>
          <path d="M4 5v14M9 8h11M9 12h11M9 16h7" />
        </svg>
      ),
    },
    {
      action: 'list',
      label: 'chat.format.list',
      icon: (
        <svg {...stroke}>
          <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />
        </svg>
      ),
    },
  ],
];

/**
 * Does `action` to the selection in `box`, or undoes it, and leaves the same
 * words selected. False when the text would grow past `max`, and nothing
 * changes.
 *
 * The change is typed into the box, as the browser's own editing is, so
 * Ctrl+Z takes it back and the box's input handler sees it. `setText` is for
 * when the browser refuses to type it.
 */
export function formatBox(
  box: HTMLTextAreaElement,
  action: FormatAction,
  setText: (text: string) => void,
  max: number,
): boolean {
  const before = box.value;
  const next = applyFormat(before, box.selectionStart, box.selectionEnd, action, max);
  if (!next) return false;
  // Only the stretch that changed is typed over.
  let head = 0;
  while (head < before.length && head < next.text.length && before[head] === next.text[head]) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < next.text.length - head &&
    before[before.length - 1 - tail] === next.text[next.text.length - 1 - tail]
  ) {
    tail += 1;
  }
  box.focus();
  box.setSelectionRange(head, before.length - tail);
  const typed = next.text.slice(head, next.text.length - tail);
  // execCommand is the one way to edit a textarea that keeps its undo history.
  const ok = typed
    ? document.execCommand('insertText', false, typed)
    : document.execCommand('delete');
  if (!ok || box.value !== next.text) setText(next.text);
  requestAnimationFrame(() => box.setSelectionRange(next.start, next.end));
  return true;
}

/**
 * The formatting bar over the message box, as Teams has: each button styles
 * the selected words or, with none selected, starts the style at the caret.
 * The buttons never take the focus from the box, so its selection stays.
 */
export default function FormatBar({
  target,
  setText,
  max,
  disabled = false,
}: {
  target: RefObject<HTMLTextAreaElement | null>;
  setText: (text: string) => void;
  max: number;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <div className="chat-format-bar" role="toolbar" aria-label={t('chat.format')}>
      {GROUPS.map((group, index) => (
        <div key={index} className="chat-format-group">
          {group.map(({ action, label, icon }) => {
            const keys = FORMAT_KEYS[action];
            const title = keys ? `${t(label)} (${MOD}+${keys})` : t(label);
            return (
              <button
                key={action}
                type="button"
                className="chat-format-button"
                disabled={disabled}
                aria-label={t(label)}
                title={title}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  const box = target.current;
                  if (box) formatBox(box, action, setText, max);
                }}
              >
                {icon}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
