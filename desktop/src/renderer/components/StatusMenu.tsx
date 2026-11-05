import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PRESENCES, type Presence } from '../../shared/ipc';
import { StatusDot } from './Avatar';
import { useT } from '../i18n';

/**
 * Your menu, above your picture in the sidebar's footer: your status (ADR
 * 0038), then Settings, which used to be a gear of its own. Closes on a choice, a click elsewhere, Escape, or the window
 * losing focus, as the admins' menu does.
 */
export default function StatusMenu({
  anchor,
  chosen,
  onChoose,
  onSettings,
  settingsBadge = 0,
  onClose,
}: {
  /** What it opens from: it sits above it, kept inside the window. */
  anchor: DOMRect;
  /** Your status; null against a server without them, and no choice is shown. */
  chosen: Presence | null;
  onChoose: (status: Presence) => void;
  onSettings: () => void;
  /** Sign-ups waiting for an admin, beside Settings. */
  settingsBadge?: number;
  onClose: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ left: anchor.left, top: anchor.top });
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    setPlace({
      left: Math.max(4, Math.min(anchor.left, window.innerWidth - box.width - 4)),
      top: Math.max(4, anchor.top - box.height - 6),
    });
    ref.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
  }, [anchor]);
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className="member-menu status-menu"
      role="menu"
      aria-label={t('presence.choose')}
      style={place}
    >
      {chosen &&
        PRESENCES.map((status) => (
          <button
            key={status}
            type="button"
            role="menuitemradio"
            aria-checked={status === chosen}
            className={`status-menu-item${status === chosen ? ' chosen' : ''}`}
            onClick={() => {
              onClose();
              if (status !== chosen) onChoose(status);
            }}
          >
            <StatusDot status={status} />
            <span className="status-menu-text">
              <span className="status-menu-label">{t(`presence.${status}`)}</span>
              <span className="status-menu-hint">{t(`presence.${status}Hint`)}</span>
            </span>
          </button>
        ))}
      {chosen && <hr className="person-menu-divider" />}
      <button
        type="button"
        role="menuitem"
        className="status-menu-item status-menu-action"
        onClick={() => {
          onClose();
          onSettings();
        }}
      >
        <IconGear />
        <span className="status-menu-label">{t('sidebar.settings')}</span>
        {settingsBadge > 0 && (
          <span
            className="nav-count"
            aria-label={t('sidebar.settingsPending', { count: settingsBadge })}
          >
            {settingsBadge}
          </span>
        )}
      </button>
    </div>,
    document.body,
  );
}

function IconGear() {
  return (
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
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
    </svg>
  );
}
