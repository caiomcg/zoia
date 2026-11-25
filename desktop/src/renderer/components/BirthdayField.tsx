import { useMemo } from 'react';
import { useLanguage, useT } from '../i18n';
import { daysIn } from '../schedule/birthday';

/** A birthday as it is being picked: either part may still be missing. */
export interface BirthdayDraft {
  day: number | null;
  month: number | null;
}

/**
 * Day and month, never a year (ADR 0055): two lists, the month by name in
 * the app's language, and no day the month lacks. Used at sign-up, in the
 * prompt after signing in, and under Settings › Profile.
 */
export default function BirthdayField({
  id,
  value,
  onChange,
  disabled,
  required,
}: {
  id: string;
  value: BirthdayDraft;
  onChange: (value: BirthdayDraft) => void;
  disabled?: boolean;
  required?: boolean;
}) {
  const t = useT();
  const { language } = useLanguage();
  const months = useMemo(() => {
    const format = new Intl.DateTimeFormat(language, { month: 'long', timeZone: 'UTC' });
    return Array.from({ length: 12 }, (_, i) => {
      const name = format.format(Date.UTC(2000, i, 1));
      return name.charAt(0).toLocaleUpperCase(language) + name.slice(1);
    });
  }, [language]);
  const days = value.month ? daysIn(value.month) : 31;

  return (
    <div className="birthday-field">
      <select
        id={id}
        aria-label={t('birthday.day')}
        value={value.day ?? ''}
        disabled={disabled}
        required={required}
        onChange={(event) =>
          onChange({ ...value, day: event.target.value ? Number(event.target.value) : null })
        }
      >
        <option value="">{t('birthday.day')}</option>
        {Array.from({ length: days }, (_, i) => (
          <option key={i + 1} value={i + 1}>
            {i + 1}
          </option>
        ))}
      </select>
      <select
        aria-label={t('birthday.month')}
        value={value.month ?? ''}
        disabled={disabled}
        required={required}
        onChange={(event) => {
          const month = event.target.value ? Number(event.target.value) : null;
          // The 31st, moved to a month without one, is that month's last day.
          const day = value.day && month ? Math.min(value.day, daysIn(month)) : value.day;
          onChange({ day, month });
        }}
      >
        <option value="">{t('birthday.month')}</option>
        {months.map((name, i) => (
          <option key={i + 1} value={i + 1}>
            {name}
          </option>
        ))}
      </select>
    </div>
  );
}
