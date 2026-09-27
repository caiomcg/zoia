/**
 * A single dot standing in for a line of status text.
 *
 * The top bar used to carry the connection state, the encoder and the stream
 * numbers as words, which crowded out the one control anyone actually reaches
 * for. The numbers are still there on hover, as a small statistics card —
 * something you consult when a broadcast looks wrong, not something to read
 * constantly.
 */
export type StatusTone = 'ok' | 'warn' | 'bad' | 'idle';

export interface StatusStat {
  label: string;
  value: string;
}

export default function StatusLight({
  tone,
  label,
  stats = [],
}: {
  tone: StatusTone;
  /** The card's heading, and what screen readers hear. */
  label: string;
  stats?: StatusStat[];
}) {
  const spoken = [label, ...stats.map((s) => `${s.label} ${s.value}`)].join(', ');
  return (
    <span className={`status-light ${tone}`} tabIndex={0} role="status" aria-label={spoken}>
      <span className="status-dot" aria-hidden="true" />
      <span className="status-card" aria-hidden="true">
        <strong>{label}</strong>
        {stats.length > 0 && (
          <dl>
            {stats.map((s) => (
              <div key={s.label}>
                <dt>{s.label}</dt>
                <dd>{s.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </span>
    </span>
  );
}
