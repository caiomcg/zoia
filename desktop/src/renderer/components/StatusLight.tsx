/**
 * A single dot standing in for a line of status text.
 *
 * The top bar used to carry the connection state, the encoder and the stream
 * numbers as words, which crowded out the one control anyone actually reaches
 * for. The detail is still there on hover, where it belongs — something you
 * consult when a broadcast looks wrong, not something to read constantly.
 */
export type StatusTone = 'ok' | 'warn' | 'bad' | 'idle';

export default function StatusLight({
  tone,
  label,
  detail,
  text,
}: {
  tone: StatusTone;
  /** Read out to screen readers, and the first line of the tooltip. */
  label: string;
  detail?: string | null;
  /** A short reading shown beside the dot, such as the ping. */
  text?: string | null;
}) {
  const title = detail ? `${label}\n${detail}` : label;
  return (
    <span className={`status-light ${tone}`} title={title} role="status" aria-label={title}>
      <span className="status-dot" aria-hidden="true" />
      {text && <span className="status-text">{text}</span>}
    </span>
  );
}
