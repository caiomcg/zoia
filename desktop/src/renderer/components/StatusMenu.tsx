import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PRESENCES, type Presence } from '../../shared/ipc';
import { StatusDot } from './Avatar';
import { useT } from '../i18n';

/**
 * Choosing your status (ADR 0038), above your picture in the sidebar's
 * footer. Closes on a choice, a click elsewhere, Escape, or the window
 * losing focus, as the admins' menu does.
 */
export default function StatusMenu({
  anchor,
  chosen,
  onChoose,
  onClose,
}: {
  /** What it opens from: it sits above it, kept inside the window. */
  anchor: DOMRect;
  chosen: Presence;
  onChoose: (status: Presence) => void;
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
      {PRESENCES.map((status) => (
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
    </div>,
    document.body,
  );
}
