import { useEffect, useRef, useState } from 'react';

/** Times offered in the list, every quarter hour of the day, 24-hour. */
const SLOTS = Array.from({ length: 96 }, (_, i) => {
  const h = String(Math.floor(i / 4)).padStart(2, '0');
  const m = String((i % 4) * 15).padStart(2, '0');
  return `${h}:${m}`;
});

/** "21:30", "9:5", "2130" or "930" as "HH:MM", or null if it is not a time. */
export function parseTime(text: string): string | null {
  const trimmed = text.trim();
  const match = /^(\d{1,2})(?::?(\d{2}))?$/.exec(trimmed) ?? /^(\d{1,2}):(\d{1,2})$/.exec(trimmed);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2] ?? 0);
  if (h > 23 || m > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * A time of day, always 24-hour, in Zoia's own look rather than the system
 * picker: type it ("21:30", "2130"), or pick from a list of quarter hours
 * that opens scrolled to the time shown. Arrow keys move through the list.
 */
export default function TimeField({
  id,
  value,
  label,
  onChange,
}: {
  id: string;
  /** "HH:MM". */
  value: string;
  label: string;
  onChange: (value: string) => void;
}) {
  const [text, setText] = useState(value);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => setText(value), [value]);

  // The slot at or just before the time shown, to scroll to and highlight.
  const near = Math.max(
    0,
    SLOTS.findLastIndex((slot) => slot <= value),
  );

  useEffect(() => {
    if (!open) return undefined;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${near}"]`)
      ?.scrollIntoView({ block: 'center' });
    const away = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open, near]);

  function commit(next: string) {
    const parsed = parseTime(next);
    if (parsed) onChange(parsed);
    setText(parsed ?? value);
  }

  return (
    <div className="time-field" ref={wrapRef}>
      <input
        id={id}
        className="settings-select"
        value={text}
        inputMode="numeric"
        autoComplete="off"
        aria-label={label}
        aria-expanded={open}
        aria-controls={`${id}-list`}
        role="combobox"
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => commit(text)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit(text);
            setOpen(false);
          } else if (event.key === 'Escape' && open) {
            // Closes the list, not the dialog around it.
            event.stopPropagation();
            event.nativeEvent.stopImmediatePropagation();
            setOpen(false);
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const by = event.key === 'ArrowDown' ? 1 : -1;
            const exact = SLOTS.indexOf(value);
            const from = exact === -1 ? near + (by > 0 ? 0 : 1) : exact;
            const next = SLOTS[(from + by + SLOTS.length) % SLOTS.length]!;
            onChange(next);
            setOpen(true);
          }
        }}
      />
      <svg
        className="time-field-icon"
        viewBox="0 0 24 24"
        width="16"
        height="16"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7.5V12l3 2" />
      </svg>
      {open && (
        <ul className="time-field-list" id={`${id}-list`} role="listbox" ref={listRef}>
          {SLOTS.map((slot, i) => (
            <li
              key={slot}
              data-index={i}
              role="option"
              aria-selected={slot === value}
              className={slot === value ? 'on' : i === near ? 'near' : undefined}
              // Before the box's blur, which would commit what was typed first.
              onMouseDown={(event) => {
                event.preventDefault();
                onChange(slot);
                setOpen(false);
              }}
            >
              {slot}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
