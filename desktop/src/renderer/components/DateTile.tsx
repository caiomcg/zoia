import { useLanguage } from '../i18n';

/**
 * An event's day as a calendar page (ADR 0050): the month on a coloured band,
 * the day under it. One look at every size, so the carousel, the popup, the
 * Events panel and the event itself all show the same thing. Green while the
 * event is on, grey once it has ended.
 */
export default function DateTile({
  iso,
  size = 'sm',
  state = 'later',
}: {
  iso: string;
  size?: 'sm' | 'md' | 'lg';
  state?: 'ended' | 'live' | 'soon' | 'later';
}) {
  const { language } = useLanguage();
  const date = new Date(iso);
  return (
    <span className={`date-tile ${size} ${state}`} aria-hidden="true">
      <span className="date-tile-month">
        {new Intl.DateTimeFormat(language, { month: 'short' }).format(date)}
      </span>
      <span className="date-tile-day">{date.getDate()}</span>
    </span>
  );
}
