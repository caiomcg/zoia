import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { LEAVE_MS } from '../presence';
/**
 * A dismissible message.
 *
 * Every banner used to sit there until whatever caused it happened to change,
 * so a single failed broadcast left a red bar across the app indefinitely.
 * Dismissing it fades it out first, then tells the parent to drop it.
 */
export default function Banner({
  tone = 'error',
  children,
  onDismiss,
}: {
  tone?: 'error' | 'warn';
  children: React.ReactNode;
  onDismiss: () => void;
}) {
  const t = useT();
  const [leaving, setLeaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function dismiss() {
    if (leaving) return;
    setLeaving(true);
    timer.current = setTimeout(onDismiss, LEAVE_MS);
  }

  return (
    <p
      className={`banner ${tone}${leaving ? ' leaving' : ''}`}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      <span className="banner-text">{children}</span>
      <button
        className="banner-close"
        onClick={dismiss}
        title={t('common.dismiss')}
        aria-label={t('common.dismiss')}
      >
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
          <path
            d="M6 6l12 12M18 6L6 18"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      </button>
    </p>
  );
}
