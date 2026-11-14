import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { createPortal } from 'react-dom';
import type { ChatPerson, RoomInfo, RsvpAnswer, ScheduledEvent } from '../../shared/ipc';
import {
  answers,
  endOf,
  eventState,
  isPinned,
  answerOnJoin,
  canJoinEvent,
} from '../schedule/model';
import { useAccountAvatar } from '../chat/avatars';
import Avatar from './Avatar';
import DateTile from './DateTile';
import { useLanguage, useT } from '../i18n';

/** How far ahead the Events panel calls an event "this week". */
export const CARD_AHEAD_MS = 7 * 24 * 60 * 60_000;

/** Events the carousel cycles through at most. */
export const CAROUSEL_MAX = 5;

/** How long each event shows before the carousel moves on. */
export const CAROUSEL_EVERY_MS = 5_000;

/** How far a drag must go to move to the next event. */
const SWIPE_PX = 40;

/** Movement under this is a click, not a drag. */
const DRAG_START_PX = 5;

/** One wheel notch at most per this long, so a flick does not race through. */
const WHEEL_EVERY_MS = 350;

/** How long the popup waits before closing, so the pointer can cross into it. */
const CLOSE_DELAY_MS = 180;

/** Faces shown for who is going before the rest become "+N". */
const FACES = 5;

/** Events hidden from the carousel on this machine; a convenience, kept here only. */
const DISMISSED_KEY = 'zoia.events.dismissed';

const ANSWERS: RsvpAnswer[] = ['going', 'maybe', 'no'];

/** The time now, half a minute at a time: enough for "soon", "now" and "ended". */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * The events to pin, soonest first: from an hour before each starts until it
 * ends, up to CAROUSEL_MAX.
 */
export function pinnedEvents(events: ScheduledEvent[], now: number): ScheduledEvent[] {
  return events.filter((e) => isPinned(e, now)).slice(0, CAROUSEL_MAX);
}

/**
 * When an event starts, short and always 24-hour: "21:00" today, "Fri 21:00"
 * later in the week, else the date.
 */
export function useShortWhen(): (iso: string) => string {
  const { language } = useLanguage();
  return (iso: string) => {
    const d = new Date(iso);
    const now = new Date();
    const time = new Intl.DateTimeFormat(language, {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(d);
    if (d.toDateString() === now.toDateString()) return time;
    if (d.getTime() - now.getTime() < 6 * 24 * 60 * 60_000) {
      return `${new Intl.DateTimeFormat(language, { weekday: 'short' }).format(d)} ${time}`;
    }
    return new Intl.DateTimeFormat(language, { day: 'numeric', month: 'short' }).format(d);
  };
}

/** From start to end, 24-hour: "Thu, Nov 5, 21:00 – 23:00", the days only where they differ. */
export function formatSpan(event: ScheduledEvent, language: string, allDay: string): string {
  // A birthday is the whole day (ADR 0055): its date, and no hours.
  if (event.kind === 'birthday') {
    const day = new Intl.DateTimeFormat(language, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    }).format(new Date(event.startsAt));
    return `${day} · ${allDay}`;
  }
  const format = new Intl.DateTimeFormat(language, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return format.formatRange(new Date(event.startsAt), new Date(endOf(event)));
}

/** Whether the system asks for less motion: then nothing moves by itself. */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  );
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return undefined;
    const change = () => setReduced(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  return reduced;
}

function readDismissed(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]');
    return Array.isArray(stored) ? stored.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * The events about to start and on now, pinned above the sidebar's lists
 * (ADR 0050), one at a time. With more than one it moves on by itself every
 * few seconds; a drag or the wheel moves it by hand. Pointing at it holds it
 * still and opens a popup beside the sidebar, which stays while the pointer
 * moves into it: answer there, join the channel, or open the event. Clicking
 * the card joins its channel. The × hides an event here for good.
 */
export function EventCarousel({
  events: all,
  me,
  channels,
  people,
  now,
  onJoin,
  onAnswer,
}: {
  events: ScheduledEvent[];
  me: string | null;
  channels: RoomInfo[];
  people: ChatPerson[];
  now: number;
  onJoin: (channelId: string) => void;
  /** Your answer; null takes it back. */
  onAnswer: (event: ScheduledEvent, answer: RsvpAnswer | null) => void;
}) {
  const t = useT();
  const [dismissed, setDismissed] = useState(readDismissed);
  const events = all.filter((e) => !dismissed.includes(e.id));
  const [index, setIndex] = useState(0);
  const [held, setHeld] = useState(false);
  // Where the carousel is on screen while held, for the popup to sit beside it.
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const ref = useRef<HTMLElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // A drag: where it began, and how far it has gone, which the card follows.
  const drag = useRef<{ x: number; id: number; moving: boolean } | null>(null);
  const [offset, setOffset] = useState(0);
  // The last drag moved, so its release is not also a click on the card.
  const dragged = useRef(false);
  const lastWheel = useRef(0);
  const reduced = useReducedMotion();
  const count = events.length;
  const shown = count === 0 ? 0 : index % count;

  const open = () => {
    clearTimeout(closeTimer.current);
    setHeld(true);
    setAnchor(ref.current?.getBoundingClientRect() ?? null);
  };
  const closeSoon = () => {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      setHeld(false);
      setAnchor(null);
    }, CLOSE_DELAY_MS);
  };
  useEffect(() => () => clearTimeout(closeTimer.current), []);

  useEffect(() => {
    if (held || reduced || count < 2) return undefined;
    const timer = setInterval(() => setIndex((i) => (i + 1) % count), CAROUSEL_EVERY_MS);
    return () => clearInterval(timer);
  }, [held, reduced, count]);

  const step = (by: number) => setIndex((i) => ((((i % count) + by) % count) + count) % count);

  function dismiss(id: string) {
    const next = [...dismissed.filter((x) => all.some((e) => e.id === x)), id];
    setDismissed(next);
    try {
      localStorage.setItem(DISMISSED_KEY, JSON.stringify(next));
    } catch {
      // Remembering is a convenience; it is hidden for now all the same.
    }
    // The pointer is still on the carousel: it stays held, so the next
    // event's × is there to dismiss it too, and the popup follows it.
    setAnchor(ref.current?.getBoundingClientRect() ?? null);
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (count < 2 || event.button !== 0) return;
    drag.current = { x: event.clientX, id: event.pointerId, moving: false };
    dragged.current = false;
  }
  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    const dx = event.clientX - current.x;
    if (!current.moving) {
      if (Math.abs(dx) < DRAG_START_PX) return;
      // Only now, so a plain click still lands on the card under it.
      current.moving = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    setOffset(dx);
  }
  function onPointerEnd(event: ReactPointerEvent<HTMLDivElement>) {
    const current = drag.current;
    drag.current = null;
    if (!current || current.id !== event.pointerId || !current.moving) return;
    dragged.current = true;
    setOffset(0);
    const dx = event.clientX - current.x;
    if (Math.abs(dx) >= SWIPE_PX) step(dx < 0 ? 1 : -1);
  }
  function onWheel(event: ReactWheelEvent<HTMLDivElement>) {
    if (count < 2) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (Math.abs(delta) < 4 || event.timeStamp - lastWheel.current < WHEEL_EVERY_MS) return;
    lastWheel.current = event.timeStamp;
    step(delta > 0 ? 1 : -1);
  }

  if (count === 0) return null;
  const current = events[shown]!;
  return (
    <section
      ref={ref}
      className={`event-carousel${held ? ' held' : ''}${count > 1 ? ' multi' : ''}`}
      aria-roledescription="carousel"
      aria-label={t('event.title')}
      onMouseEnter={open}
      onMouseLeave={closeSoon}
      onFocus={open}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) closeSoon();
      }}
    >
      <div
        className={`event-carousel-window${offset !== 0 ? ' dragging' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onWheel={onWheel}
        onClickCapture={(event) => {
          if (!dragged.current) return;
          dragged.current = false;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <div
          className="event-carousel-track"
          style={{ transform: `translateX(calc(${-shown * 100}% + ${offset}px))` }}
        >
          {events.map((event, i) => (
            <EventSlide
              key={event.id}
              event={event}
              me={me}
              channels={channels}
              now={now}
              hidden={i !== shown}
              onReveal={open}
              onDismiss={() => dismiss(event.id)}
            />
          ))}
        </div>
      </div>
      {count > 1 && (
        <div className="event-dots" role="tablist" aria-label={t('event.title')}>
          {events.map((event, i) => (
            <button
              key={event.id}
              type="button"
              role="tab"
              aria-selected={i === shown}
              aria-label={event.title}
              title={event.title}
              className={i === shown ? 'on' : undefined}
              onClick={() => setIndex(i)}
            />
          ))}
        </div>
      )}
      {held && anchor && offset === 0 && (
        <EventPopup
          event={current}
          anchor={anchor}
          me={me}
          channels={channels}
          people={people}
          now={now}
          onEnter={open}
          onLeave={closeSoon}
          onJoin={onJoin}
          onAnswer={onAnswer}
        />
      )}
    </section>
  );
}

/**
 * The pinned event's details, beside the sidebar while the carousel is
 * pointed at: when, until when, where, what it is about and who is coming,
 * with your answer and the way in. It stays while the pointer is on it.
 */
function EventPopup({
  event,
  anchor,
  me,
  channels,
  people,
  now,
  onEnter,
  onLeave,
  onJoin,
  onAnswer,
}: {
  event: ScheduledEvent;
  anchor: DOMRect;
  me: string | null;
  channels: RoomInfo[];
  people: ChatPerson[];
  now: number;
  onEnter: () => void;
  onLeave: () => void;
  onJoin: (channelId: string) => void;
  onAnswer: (event: ScheduledEvent, answer: RsvpAnswer | null) => void;
}) {
  const t = useT();
  const { language } = useLanguage();
  const state = eventState(event, now);
  const who = answers(event);
  const mine = me ? (event.rsvps[me] ?? null) : null;
  const channel = event.channelId ? channels.find((c) => c.id === event.channelId) : undefined;
  const joinable = canJoinEvent(state);
  const join = () => {
    if (!channel) return;
    const answer = answerOnJoin(mine);
    if (answer) onAnswer(event, answer);
    onJoin(channel.id);
  };
  // Left of the sidebar, its top level with the carousel, kept on screen.
  const top = Math.max(8, Math.min(anchor.top, window.innerHeight - 340));
  return createPortal(
    <div
      className="event-popup"
      role="dialog"
      aria-label={event.title}
      style={{ top, left: Math.max(8, anchor.left - 8) }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <div className="event-popup-head">
        <DateTile iso={event.startsAt} size="md" state={state} />
        <div className="event-popup-title">
          <b>{event.title}</b>
          {state === 'live' && <span className="event-card-now">{t('event.now')}</span>}
          <span>{formatSpan(event, language, t('birthday.event.allDay'))}</span>
        </div>
      </div>
      {(channel || event.creatorName || event.recurrence) && (
        <p className="event-hero-meta">
          {channel && (
            <span className="event-channel-pill">
              <span aria-hidden="true">#</span>
              {channel.name}
            </span>
          )}
          {event.recurrence && (
            <span className="event-repeats">↻ {t(`event.repeat.${event.recurrence}`)}</span>
          )}
          {event.creatorName && <span>{t('event.by', { name: event.creatorName })}</span>}
        </p>
      )}
      {event.description && <p className="event-popup-description">{event.description}</p>}
      {(['going', 'maybe', 'no'] as const).map(
        (a) =>
          who[a].length > 0 && (
            <div className={`event-attendee-row ${a}`} key={a}>
              <span className="event-attendee-label">
                {t(`event.answer.${a}`)} · {who[a].length}
              </span>
              <span className="event-card-faces">
                {who[a].slice(0, FACES).map((id) => (
                  <Face key={id} id={id} people={people} />
                ))}
                {who[a].length > FACES && (
                  <span className="event-faces-more">+{who[a].length - FACES}</span>
                )}
              </span>
            </div>
          ),
      )}
      {/* Joining counts as going (ADR 0050): while it is on, Join leads and
          says so; before, the question is all there is to do. */}
      {joinable && channel ? (
        <>
          <button type="button" className="primary event-join" onClick={join}>
            {t('event.join', { channel: channel.name })}
          </button>
          <p className="event-join-note">
            {mine === 'going' ? t('event.youreGoing') : t('event.joinMarksGoing')}
          </p>
          <div className="event-rsvp small two" role="group" aria-label={t('event.yourAnswer')}>
            {(['maybe', 'no'] as const).map((a) => (
              <button
                key={a}
                type="button"
                className={`event-answer ${a}${mine === a ? ' on' : ''}`}
                aria-pressed={mine === a}
                onClick={() => onAnswer(event, mine === a ? null : a)}
              >
                {t(`event.answer.${a}`)}
              </button>
            ))}
          </div>
        </>
      ) : (
        state !== 'ended' &&
        event.kind !== 'birthday' && (
          <>
            <span className="event-ask">{t('event.areYouGoing')}</span>
            <div className="event-rsvp small" role="group" aria-label={t('event.yourAnswer')}>
              {ANSWERS.map((a) => (
                <button
                  key={a}
                  type="button"
                  className={`event-answer ${a}${mine === a ? ' on' : ''}`}
                  aria-pressed={mine === a}
                  onClick={() => onAnswer(event, mine === a ? null : a)}
                >
                  {t(`event.answer.${a}`)}
                </button>
              ))}
            </div>
          </>
        )
      )}
    </div>,
    document.body,
  );
}

function EventSlide({
  event,
  me,
  channels,
  now,
  hidden,
  onReveal,
  onDismiss,
}: {
  event: ScheduledEvent;
  me: string | null;
  channels: RoomInfo[];
  now: number;
  /** Not the one showing: out of the tab order. */
  hidden: boolean;
  /** Shows the popup: the card never joins by itself, so people answer first. */
  onReveal: () => void;
  onDismiss: () => void;
}) {
  const t = useT();
  const when = useShortWhen();
  const state = eventState(event, now);
  const live = state === 'live';
  const going = answers(event).going;
  const mine = me ? event.rsvps[me] : undefined;
  const channel = event.channelId ? channels.find((c) => c.id === event.channelId) : undefined;
  return (
    <div className="event-slide" aria-hidden={hidden}>
      <button
        type="button"
        className={`event-card${live ? ' live' : ''}`}
        tabIndex={hidden ? -1 : 0}
        draggable={false}
        onClick={onReveal}
        aria-label={t('event.openCard', { title: event.title })}
      >
        <DateTile iso={event.startsAt} size="sm" state={state} />
        <span className="event-card-title">
          <span>{event.title}</span>
        </span>
        <span className="event-card-meta">
          {live ? (
            <>
              <span className="event-card-now">{t('event.now')}</span>{' '}
              <span className="event-when-range">
                {event.kind === 'birthday'
                  ? t('birthday.event.allDay')
                  : t('event.untilTime', { time: when(new Date(endOf(event)).toISOString()) })}
              </span>
            </>
          ) : (
            when(event.startsAt)
          )}
          {channel && ` · #${channel.name}`}
          {' · '}
          <span className="event-card-going">
            {going.length === 1
              ? t('event.goingOne')
              : t('event.goingCount', { count: going.length })}
          </span>
          {mine && ` · ${t('event.yourAnswerIs', { answer: t(`event.answer.${mine}`) })}`}
        </span>
      </button>
      <button
        type="button"
        className="event-dismiss"
        tabIndex={hidden ? -1 : 0}
        onClick={onDismiss}
        aria-label={t('event.dismiss')}
        title={t('event.dismiss')}
      >
        ×
      </button>
    </div>
  );
}

/** Someone coming, as their picture, with their name on hover. */
function Face({ id, people }: { id: string; people: ChatPerson[] }) {
  const t = useT();
  const person = people.find((p) => p.id === id);
  const name = person?.name ?? t('chat.someone');
  const image = useAccountAvatar(id, person?.avatar);
  return (
    <span className="event-face" title={name}>
      <Avatar name={name} image={image} live={false} />
    </span>
  );
}

/**
 * Every scheduled event (ADR 0050), in the sidebar while its calendar button
 * is on: a button to schedule one, then this week's and later ones.
 */
export function EventsPanel({
  events,
  me,
  now,
  onOpen,
  onNew,
}: {
  events: ScheduledEvent[];
  me: string | null;
  now: number;
  onOpen: (event: ScheduledEvent) => void;
  onNew: () => void;
}) {
  const t = useT();
  const week = events.filter((e) => Date.parse(e.startsAt) - now <= CARD_AHEAD_MS);
  const later = events.filter((e) => Date.parse(e.startsAt) - now > CARD_AHEAD_MS);
  return (
    <section className="member-group events-panel" aria-label={t('event.title')}>
      <div className="events-panel-head">
        <h2>{t('event.title')}</h2>
      </div>
      <button type="button" className="events-new" onClick={onNew}>
        + {t('event.new')}
      </button>
      {events.length === 0 ? (
        <p className="direct-empty muted">{t('event.empty')}</p>
      ) : (
        <>
          {week.length > 0 && <h3 className="member-heading">{t('event.thisWeek')}</h3>}
          {week.map((e) => (
            <EventRow key={e.id} event={e} me={me} now={now} onOpen={() => onOpen(e)} />
          ))}
          {later.length > 0 && <h3 className="member-heading">{t('event.later')}</h3>}
          {later.map((e) => (
            <EventRow key={e.id} event={e} me={me} now={now} onOpen={() => onOpen(e)} />
          ))}
        </>
      )}
    </section>
  );
}

function EventRow({
  event,
  me,
  now,
  onOpen,
}: {
  event: ScheduledEvent;
  me: string | null;
  now: number;
  onOpen: () => void;
}) {
  const t = useT();
  const when = useShortWhen();
  const state = eventState(event, now);
  const going = answers(event).going.length;
  const mine = me ? event.rsvps[me] : undefined;
  return (
    <div className="channel-row">
      <button className={`channel event-row ${state}`} onClick={onOpen} title={event.title}>
        <DateTile iso={event.startsAt} size="sm" state={state} />
        <span className="event-text">
          <span className="channel-name">
            {event.title}
            {event.recurrence && (
              <span className="event-repeats-icon" title={t(`event.repeat.${event.recurrence}`)}>
                {' '}
                ↻
              </span>
            )}
          </span>
          <span className="event-when muted">
            {state === 'live'
              ? t('event.now')
              : state === 'ended'
                ? t('event.ended')
                : when(event.startsAt)}
            {' · '}
            {event.kind === 'birthday'
              ? t('birthday.event.allDay')
              : going === 1
                ? t('event.goingOne')
                : t('event.goingCount', { count: going })}
          </span>
        </span>
        {mine && (
          <span
            className={`event-mine ${mine}`}
            title={t(`event.answer.${mine}`)}
            aria-label={t(`event.answer.${mine}`)}
          />
        )}
      </button>
    </div>
  );
}

/** A calendar page. */
export function IconCalendar() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </svg>
  );
}
