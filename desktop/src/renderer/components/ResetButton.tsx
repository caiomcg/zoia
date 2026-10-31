/**
 * Puts a slider back to its usual value. A button of its own rather than a
 * double-click on the slider, which also fired when someone clicked the
 * slider twice to set it, and threw their choice away.
 */

export default function ResetButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="slider-reset"
      onClick={(event) => {
        // Inside a <label>, a click would otherwise also reach the slider.
        event.preventDefault();
        onClick();
      }}
      title={label}
      aria-label={label}
    >
      <svg
        viewBox="0 0 24 24"
        width="12"
        height="12"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M4 12a8 8 0 1 0 2.6-5.9" />
        <path d="M4 4v4.5h4.5" />
      </svg>
    </button>
  );
}
