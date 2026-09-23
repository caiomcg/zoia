/**
 * A dismissible message.
 *
 * Every banner used to sit there until whatever caused it happened to change,
 * so a single failed broadcast left a red bar across the app indefinitely.
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
  return (
    <p className={`banner ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <span className="banner-text">{children}</span>
      <button className="banner-close" onClick={onDismiss} title="Dismiss" aria-label="Dismiss">
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
