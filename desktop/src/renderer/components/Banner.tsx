import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { LEAVE_MS } from '../presence';
/**
 * A dismissible message.
 *
 * Every banner used to sit there until whatever caused it happened to change,
 * so a single failed broadcast left a red bar across the app indefinitely.
 * Dismissing it fades it out first, then tells the parent to drop it. A
 * notice that only says what happened can go by itself after `autoDismissMs`.
 */
export default function Banner({
  tone = 'error',
  children,
  onDismiss,
  autoDismissMs,
}: {
  tone?: 'error' | 'warn';
  children: React.ReactNode;
  onDismiss: () => void;
  /** Goes by itself after this long; absent, it stays until dismissed. */
  autoDismissMs?: number;
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

  // Restarted when the message changes: a new one gets its full time.
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;
  useEffect(() => {
    if (!autoDismissMs) return undefined;
    const auto = setTimeout(() => dismissRef.current(), autoDismissMs);
    return () => clearTimeout(auto);
  }, [autoDismissMs, children]);

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
