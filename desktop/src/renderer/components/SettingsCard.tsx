/**
 * The pieces every settings section is built from, as Settings › Voice
 * first had them: a titled card of related settings, and a switch with what
 * it does under its name.
 */

import type { ReactNode } from 'react';

export function SettingsCard({
  id,
  title,
  children,
}: {
  /** Unique in the dialog: the heading's id, which names the card. */
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="settings-card" aria-labelledby={id}>
      <h4 id={id}>{title}</h4>
      {children}
    </section>
  );
}

export function SettingsToggle({
  label,
  hint,
  badge,
  checked,
  disabled = false,
  title,
  onChange,
}: {
  label: string;
  hint?: ReactNode;
  /** A word beside the name, such as "Beta". */
  badge?: string;
  checked: boolean;
  disabled?: boolean;
  title?: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="settings-toggle" title={title}>
      <span>
        <span>
          {label}
          {badge && <span className="settings-badge">{badge}</span>}
        </span>
        {hint && <small className="muted">{hint}</small>}
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}
