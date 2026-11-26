import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { PersonBirthday, ScheduledEvent } from '../../shared/ipc';
import {
  dayKey,
  itemsByDay,
  monthGrid,
  weekStartFor,
  type CalendarItem,
} from '../schedule/calendar';
import { answers, defaultStart, eventState } from '../schedule/model';
import { useLanguage, useT } from '../i18n';

/** Items a day's cell shows before the rest become "+N more". */
const CELL_ITEMS = 3;

const startOfDay = (at: number) => {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d;
};

const capitalize = (text: string) => text.charAt(0).toLocaleUpperCase() + text.slice(1);

/**
 * The calendar (ADR 0056): a month of events and birthdays, with the day
 * picked listed beside it. Clicking an event opens it as the Events panel
 * does; a day from today on can have one scheduled on it.
 */
export default function CalendarDialog({
  events,
  birthdays,
  me,
  now,
  onOpenEvent,
  onNew,
  onClose,
}: {
  events: ScheduledEvent[];
  /** Everyone's birthday; null from a server before the calendar, which has today's only. */
  birthdays: PersonBirthday[] | null;
  me: string | null;
  now: number;
  onOpenEvent: (event: ScheduledEvent) => void;
  /** Schedules an event starting then, or now when null. */
  onNew: (startsAt: string | null) => void;
  onClose: () => void;
}) {
  const t = useT();
  const { language } = useLanguage();
  const today = startOfDay(now);
  const [selected, setSelected] = useState<Date>(today);
  // The month on the page follows the day picked.
  const year = selected.getFullYear();
  const month = selected.getMonth();
  const weekStart = useMemo(() => weekStartFor(language), [language]);
  const days = useMemo(() => monthGrid(year, month, weekStart), [year, month, weekStart]);
  const byDay = useMemo(() => itemsByDay(days, events, birthdays), [days, events, birthdays]);
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // An event open over it, or a question over that, takes its own Escape.
    const onKey = (e: globalThis.KeyboardEvent) =>
      e.key === 'Escape' && !document.querySelector('.event-dialog, .confirm-dialog') && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // The picked day keeps the focus as the arrows move it, across months too.
  const focusPicked = useRef(false);
  useEffect(() => {
    if (!focusPicked.current) return;
    focusPicked.current = false;
    gridRef.current?.querySelector<HTMLElement>('.calendar-day.selected')?.focus();
  }, [selected]);

  const move = (byDays: number, byMonths = 0) => {
    setSelected((d) => {
      if (byMonths === 0) return new Date(d.getFullYear(), d.getMonth(), d.getDate() + byDays);
      // A month on keeps the day, or the month's last when it has fewer.
      const last = new Date(d.getFullYear(), d.getMonth() + byMonths + 1, 0).getDate();
      return new Date(d.getFullYear(), d.getMonth() + byMonths, Math.min(d.getDate(), last));
    });
  };

  function onGridKey(e: KeyboardEvent<HTMLDivElement>) {
    const steps: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [-7, 0],
      ArrowDown: [7, 0],
      PageUp: [0, -1],
      PageDown: [0, 1],
    };
    const step = steps[e.key];
    if (!step) return;
    e.preventDefault();
    focusPicked.current = true;
    move(...step);
  }

  const title = capitalize(
    new Intl.DateTimeFormat(language, { month: 'long', year: 'numeric' }).format(
      new Date(year, month, 1),
    ),
  );
  const weekdays = days.slice(0, 7).map((d) => ({
    short: new Intl.DateTimeFormat(language, { weekday: 'short' }).format(d),
    long: new Intl.DateTimeFormat(language, { weekday: 'long' }).format(d),
  }));
  const time = new Intl.DateTimeFormat(language, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const picked = byDay.get(dayKey(selected)) ?? [];
  const canSchedule = selected.getTime() >= today.getTime();

  function scheduleOnPicked() {
    if (selected.getTime() === today.getTime()) return onNew(null);
    // That day, at the hour a new event would start today.
    const at = new Date(defaultStart(now));
    const start = new Date(selected);
    start.setHours(at.getHours(), 0, 0, 0);
    onNew(start.toISOString());
  }

  const label = (item: CalendarItem) =>
    item.kind === 'birthday'
      ? t('birthday.event.title', { name: item.person.name ?? t('chat.someone') })
      : item.event.title;

  return (
    <div className="picker-backdrop" onClick={onClose}>
      <section
        className="picker calendar-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('calendar.title')}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="calendar-head">
          <h2>{title}</h2>
          <div className="calendar-nav">
            <button
              type="button"
              className="calendar-arrow"
              onClick={() => move(0, -1)}
              aria-label={t('calendar.previous')}
              title={t('calendar.previous')}
            >
              ‹
            </button>
            <button type="button" className="calendar-today" onClick={() => setSelected(today)}>
              {t('calendar.today')}
            </button>
            <button
              type="button"
              className="calendar-arrow"
              onClick={() => move(0, 1)}
              aria-label={t('calendar.next')}
              title={t('calendar.next')}
            >
              ›
            </button>
          </div>
          <button
            type="button"
            className="event-close"
            onClick={onClose}
            aria-label={t('common.close')}
            title={t('common.close')}
          >
            ×
          </button>
        </header>

        <div className="calendar-body">
          <div className="calendar-month">
            <div className="calendar-weekdays" aria-hidden="true">
              {weekdays.map((w) => (
                <span key={w.long} title={w.long}>
                  {w.short.replace('.', '')}
                </span>
              ))}
            </div>
            <div
              className="calendar-days"
              role="grid"
              aria-label={title}
              ref={gridRef}
              onKeyDown={onGridKey}
            >
              {days.map((day) => {
                const key = dayKey(day);
                const items = byDay.get(key) ?? [];
                const isSelected = key === dayKey(selected);
                const classes = [
                  'calendar-day',
                  day.getMonth() !== month && 'outside',
                  day.getTime() < today.getTime() && 'past',
                  key === dayKey(today) && 'today',
                  isSelected && 'selected',
                ]
                  .filter(Boolean)
                  .join(' ');
                return (
                  <button
                    key={key}
                    type="button"
                    role="gridcell"
                    aria-selected={isSelected}
                    tabIndex={isSelected ? 0 : -1}
                    className={classes}
                    onClick={() => setSelected(day)}
                    onDoubleClick={(e) => {
                      // Straight to the event when the day has only one.
                      const only = items.length === 1 ? items[0] : undefined;
                      if (only?.kind === 'event') {
                        e.preventDefault();
                        onOpenEvent(only.event);
                      }
                    }}
                    aria-label={new Intl.DateTimeFormat(language, {
                      weekday: 'long',
                      day: 'numeric',
                      month: 'long',
                    }).format(day)}
                  >
                    <span className="calendar-day-number">{day.getDate()}</span>
                    {items.slice(0, CELL_ITEMS).map((item, i) => (
                      <span
                        key={`${item.kind === 'event' ? item.event.id : item.person.accountId}:${item.start}:${i}`}
                        className={chipClass(item, now)}
                        title={label(item)}
                      >
                        {item.kind === 'birthday' ? (
                          <>
                            <span aria-hidden="true">🎂 </span>
                            {item.person.name}
                          </>
                        ) : (
                          <>
                            {dayKey(item.start) === key && (
                              <span className="calendar-chip-time">{time.format(item.start)} </span>
                            )}
                            {item.event.title}
                          </>
                        )}
                      </span>
                    ))}
                    {items.length > CELL_ITEMS && (
                      <span className="calendar-more">
                        {t('calendar.more', { count: items.length - CELL_ITEMS })}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <aside className="calendar-agenda" aria-live="polite">
            <h3>
              {capitalize(
                new Intl.DateTimeFormat(language, {
                  weekday: 'long',
                  day: 'numeric',
                  month: 'long',
                }).format(selected),
              )}
            </h3>
            {picked.length === 0 ? (
              <p className="muted calendar-nothing">{t('calendar.nothing')}</p>
            ) : (
              <ul className="calendar-agenda-list">
                {picked.map((item, i) =>
                  item.kind === 'birthday' ? (
                    <li
                      key={`b:${item.person.accountId}`}
                      className="calendar-agenda-item birthday"
                    >
                      <span className="calendar-agenda-icon" aria-hidden="true">
                        🎂
                      </span>
                      <span className="calendar-agenda-text">
                        <b>{label(item)}</b>
                        <span className="muted">{t('birthday.event.allDay')}</span>
                      </span>
                    </li>
                  ) : (
                    <li key={`e:${item.event.id}:${item.start}:${i}`}>
                      <AgendaEvent
                        item={item}
                        me={me}
                        now={now}
                        time={time}
                        onOpen={() => onOpenEvent(item.event)}
                      />
                    </li>
                  ),
                )}
              </ul>
            )}
            {canSchedule && (
              <button type="button" className="events-new" onClick={scheduleOnPicked}>
                + {t('calendar.scheduleOn')}
              </button>
            )}
          </aside>
        </div>
      </section>
    </div>
  );
}

/** A chip's look: birthday, an event on now, one over, or a repeat yet to come. */
function chipClass(item: CalendarItem, now: number): string {
  if (item.kind === 'birthday') return 'calendar-chip birthday';
  const state =
    item.start <= now ? (now < item.end ? 'live' : 'ended') : item.projected ? 'projected' : '';
  return `calendar-chip event ${state}`.trim();
}

function AgendaEvent({
  item,
  me,
  now,
  time,
  onOpen,
}: {
  item: Extract<CalendarItem, { kind: 'event' }>;
  me: string | null;
  now: number;
  time: Intl.DateTimeFormat;
  onOpen: () => void;
}) {
  const t = useT();
  const { event, projected } = item;
  // A server's birthday event, from before the calendar knew every birthday.
  const allDay = event.kind === 'birthday';
  const state = projected ? 'later' : eventState(event, now);
  const going = answers(event).going.length;
  const mine = me && !projected ? event.rsvps[me] : undefined;
  return (
    <button
      type="button"
      className={`calendar-agenda-item event ${state}${projected ? ' projected' : ''}`}
      onClick={onOpen}
      title={projected ? t('calendar.projected') : event.title}
    >
      <span className="calendar-agenda-time">
        {allDay
          ? t('birthday.event.allDay')
          : `${time.format(item.start)}–${time.format(item.end)}`}
      </span>
      <span className="calendar-agenda-text">
        <b>
          {event.title}
          {event.recurrence && (
            <span className="event-repeats-icon" title={t(`event.repeat.${event.recurrence}`)}>
              {' '}
              ↻
            </span>
          )}
        </b>
        {!allDay && (
          <span className="muted">
            {state === 'live'
              ? t('event.now')
              : state === 'ended'
                ? t('event.ended')
                : projected
                  ? t(`event.repeat.${event.recurrence ?? 'none'}`)
                  : going === 1
                    ? t('event.goingOne')
                    : t('event.goingCount', { count: going })}
          </span>
        )}
      </span>
      {mine && (
        <span
          className={`event-mine ${mine}`}
          title={t(`event.answer.${mine}`)}
          aria-label={t(`event.answer.${mine}`)}
        />
      )}
    </button>
  );
}
