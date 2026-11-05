import { useEffect, useRef, useState, type FormEvent } from 'react';
import type {
  ChatPerson,
  Recurrence,
  RoomInfo,
  RsvpAnswer,
  ScheduledEvent,
  ScheduledEventInput,
} from '../../shared/ipc';
import type { ScheduleController } from '../schedule/useSchedule';
import {
  answers,
  eventState,
  DEFAULT_END_AFTER_MINUTES,
  DURATION_MAX,
  DURATION_MIN,
  endOf,
  fromLocalInput,
  minutesBetween,
  shiftLocal,
  toLocalInput,
} from '../schedule/model';
import DateTile from './DateTile';
import { formatSpan } from './EventList';
import { useAccountAvatar } from '../chat/avatars';
import Avatar from './Avatar';
import TimeField from './TimeField';
import { useConfirm } from './ConfirmDialog';
import { useLanguage, useT } from '../i18n';

/** Must match TITLE_MAX and DESCRIPTION_MAX in server/src/schedule.js. */
const TITLE_MAX = 100;
const DESCRIPTION_MAX = 1000;

const ANSWERS: RsvpAnswer[] = ['going', 'maybe', 'no'];

/** Faces shown for who is coming before the rest become "+N". */
const FACES = 8;

/**
 * A scheduled event (ADR 0050): what it is, when, where, and who is coming,
 * with your own answer; or, scheduling one or changing it, a form. Whoever
 * scheduled it and admins may change or cancel it; the server checks again.
 */
export default function EventDialog({
  schedule,
  event,
  editing: startEditing = false,
  newChannelId = null,
  channels,
  people,
  me,
  isAdmin,
  onJoin,
  onClose,
}: {
  schedule: ScheduleController;
  /** The event shown, or null to schedule a new one. */
  event: ScheduledEvent | null;
  editing?: boolean;
  /** A new event's channel to start with: one right-clicked to schedule there. */
  newChannelId?: string | null;
  channels: RoomInfo[];
  people: ChatPerson[];
  me: string | null;
  isAdmin: boolean;
  /** Joins the event's channel. */
  onJoin: (channelId: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(startEditing || event === null);
  // The event as it is now: an answer or a change from elsewhere shows at once.
  const live = event ? (schedule.events.find((e) => e.id === event.id) ?? event) : null;

  useEffect(() => {
    // A question open over it (cancelling the event) takes its own Escape.
    const onKey = (e: KeyboardEvent) =>
      e.key === 'Escape' && !document.querySelector('.confirm-dialog') && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="picker-backdrop" onClick={onClose}>
      <section
        className="picker event-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={live?.title ?? t('event.new')}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="event-close"
          onClick={onClose}
          aria-label={t('common.close')}
          title={t('common.close')}
        >
          ×
        </button>
        {editing ? (
          <EventForm
            schedule={schedule}
            event={live}
            initialChannelId={newChannelId}
            channels={channels.filter((c) => !c.away)}
            onDone={() => (live ? setEditing(false) : onClose())}
            onCancel={() => (live ? setEditing(false) : onClose())}
          />
        ) : (
          live && (
            <EventDetails
              schedule={schedule}
              event={live}
              channels={channels}
              people={people}
              me={me}
              canChange={isAdmin || (me !== null && live.createdBy === me)}
              onEdit={() => setEditing(true)}
              onJoin={onJoin}
              onClose={onClose}
            />
          )
        )}
      </section>
    </div>
  );
}

function errorText(t: ReturnType<typeof useT>, code: string): string {
  switch (code) {
    case 'invalid_title':
      return t('event.error.title');
    case 'invalid_time':
      return t('event.error.time');
    case 'invalid_channel':
      return t('event.error.channel');
    case 'event_limit':
      return t('event.error.limit');
    case 'forbidden':
      return t('event.error.forbidden');
    default:
      return t('event.error.generic');
  }
}

function EventForm({
  schedule,
  event,
  initialChannelId,
  channels,
  onDone,
  onCancel,
}: {
  schedule: ScheduleController;
  event: ScheduledEvent | null;
  initialChannelId: string | null;
  channels: RoomInfo[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  // A new event starts now, to the minute; one being changed, when it does.
  const initial = toLocalInput(event?.startsAt ?? new Date().toISOString());
  const [title, setTitle] = useState(event?.title ?? '');
  const [date, setDate] = useState(initial.slice(0, 10));
  const [time, setTime] = useState(initial.slice(11));
  // Every event happens somewhere: a new one starts in the channel you are
  // in, or the default one; an old one without a channel must be given one.
  const [channelId, setChannelId] = useState(
    event?.channelId ??
      initialChannelId ??
      (event ? '' : ((channels.find((c) => c.isDefault) ?? channels[0])?.id ?? '')),
  );
  const [description, setDescription] = useState(event?.description ?? '');
  const [recurrence, setRecurrence] = useState<Recurrence | ''>(event?.recurrence ?? '');
  // When it ends, picked like the start: a new event ends fifteen minutes in,
  // the same day, and the end moves with the start, keeping its length.
  const [end, setEnd] = useState(
    () =>
      (event
        ? toLocalInput(new Date(endOf(event)).toISOString())
        : shiftLocal(initial, DEFAULT_END_AFTER_MINUTES)) ?? initial,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => titleRef.current?.focus(), []);
  const chosen = `${date}T${time}`;

  /** An end at least five minutes after `start`: one closer, or before it, is pushed there. */
  const atLeastMinimum = (start: string, next: string) => {
    const span = minutesBetween(start, next);
    return span !== null && span >= DURATION_MIN ? next : (shiftLocal(start, DURATION_MIN) ?? next);
  };

  /** Moves the start, and the end with it by as much. */
  function moveStart(next: string) {
    const span = minutesBetween(chosen, end);
    setDate(next.slice(0, 10));
    setTime(next.slice(11));
    if (span !== null) setEnd(atLeastMinimum(next, shiftLocal(next, span) ?? end));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const startsAt = fromLocalInput(chosen);
    if (!title.trim()) return setError(t('event.error.title'));
    if (!startsAt) return setError(t('event.error.time'));
    if (!channelId) return setError(t('event.error.pickChannel'));
    const ends = atLeastMinimum(chosen, end);
    if (ends !== end) setEnd(ends);
    const durationMinutes = minutesBetween(chosen, ends);
    if (durationMinutes === null || durationMinutes > DURATION_MAX) {
      return setError(t('event.error.endAfterStart'));
    }
    const input: ScheduledEventInput = {
      title: title.trim(),
      // An unchanged start is not sent: one already past would be refused.
      ...(event && Date.parse(event.startsAt) === Date.parse(startsAt) ? {} : { startsAt }),
      durationMinutes,
      recurrence: recurrence || null,
      channelId: channelId || null,
      description: description.trim() || null,
    };
    setBusy(true);
    setError(null);
    const refused = event ? await schedule.update(event.id, input) : await schedule.create(input);
    setBusy(false);
    if (refused) setError(errorText(t, refused));
    else onDone();
  }

  return (
    <form className="event-form" onSubmit={(e) => void submit(e)}>
      <h2>{event ? t('event.edit') : t('event.new')}</h2>

      <label className="settings-field">
        <span>{t('event.field.title')}</span>
        <input
          id="event-title"
          ref={titleRef}
          value={title}
          maxLength={TITLE_MAX}
          placeholder={t('event.field.titleHint')}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>

      <div className="settings-field">
        <span>{t('event.field.starts')}</span>
        <div className="event-when-row">
          <input
            id="event-date"
            type="date"
            className="settings-select"
            value={date}
            aria-label={t('event.field.date')}
            onChange={(e) => e.target.value && moveStart(`${e.target.value}T${time}`)}
          />
          <TimeField
            id="event-time"
            value={time}
            label={t('event.field.time')}
            onChange={(next) => moveStart(`${date}T${next}`)}
          />
        </div>
      </div>

      <div className="settings-field">
        <span>{t('event.field.ends')}</span>
        <div className="event-when-row">
          <input
            id="event-end-date"
            type="date"
            className="settings-select"
            value={end.slice(0, 10)}
            min={date}
            aria-label={t('event.field.ends')}
            onChange={(e) =>
              e.target.value && setEnd(atLeastMinimum(chosen, `${e.target.value}T${end.slice(11)}`))
            }
          />
          <TimeField
            id="event-end-time"
            value={end.slice(11)}
            label={t('event.field.ends')}
            onChange={(next) => setEnd(atLeastMinimum(chosen, `${end.slice(0, 10)}T${next}`))}
          />
        </div>
      </div>

      <label className="settings-field">
        <span>{t('event.field.repeat')}</span>
        <select
          id="event-repeat"
          className="settings-select"
          value={recurrence}
          onChange={(e) => setRecurrence(e.target.value as Recurrence | '')}
        >
          <option value="">{t('event.repeat.none')}</option>
          {(['daily', 'weekly', 'monthly'] as const).map((r) => (
            <option key={r} value={r}>
              {t(`event.repeat.${r}`)}
            </option>
          ))}
        </select>
      </label>

      <label className="settings-field">
        <span>{t('event.field.channel')}</span>
        <select
          id="event-channel"
          className="settings-select"
          value={channelId}
          onChange={(e) => setChannelId(e.target.value)}
        >
          {!channelId && <option value="">{t('event.error.pickChannel')}</option>}
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>

      <label className="settings-field">
        <span>
          {t('event.field.description')}{' '}
          <span className="event-optional">{t('event.field.optional')}</span>
        </span>
        <textarea
          id="event-description"
          className="settings-select"
          value={description}
          rows={3}
          maxLength={DESCRIPTION_MAX}
          placeholder={t('event.field.descriptionHint')}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>

      {error && <p className="settings-error">{error}</p>}
      <div className="event-footer">
        <span className="event-spacer" />
        <button type="button" className="event-quiet" onClick={onCancel} disabled={busy}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="primary" disabled={busy}>
          {event ? t('event.save') : t('event.create')}
        </button>
      </div>
    </form>
  );
}

/** "in 2 hours", "in 3 days", "started 20 minutes ago", in the reader's language. */
function relativeTo(iso: string, language: string): string {
  const diff = Date.parse(iso) - Date.now();
  const rtf = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  const minutes = Math.round(diff / 60_000);
  if (Math.abs(minutes) < 60) return rtf.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return rtf.format(hours, 'hour');
  return rtf.format(Math.round(hours / 24), 'day');
}

function EventDetails({
  schedule,
  event,
  channels,
  people,
  me,
  canChange,
  onEdit,
  onJoin,
  onClose,
}: {
  schedule: ScheduleController;
  event: ScheduledEvent;
  channels: RoomInfo[];
  people: ChatPerson[];
  me: string | null;
  canChange: boolean;
  onEdit: () => void;
  onJoin: (channelId: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const { language } = useLanguage();
  const { confirm, dialog } = useConfirm();
  const [error, setError] = useState<string | null>(null);
  const mine = me ? (event.rsvps[me] ?? null) : null;
  const who = answers(event);
  const channel = event.channelId ? channels.find((c) => c.id === event.channelId) : undefined;
  const state = eventState(event, Date.now());
  const live = state === 'live';

  async function answer(next: RsvpAnswer) {
    setError(null);
    const refused = await schedule.rsvp(event.id, mine === next ? null : next);
    if (refused) setError(errorText(t, refused));
  }

  async function cancel() {
    if (!(await confirm(t('event.cancelConfirm', { title: event.title }), t('event.cancel'))))
      return;
    const refused = await schedule.remove(event.id);
    if (refused) setError(errorText(t, refused));
    else onClose();
  }

  return (
    <div className="event-details">
      <div className="event-hero">
        <DateTile iso={event.startsAt} size="lg" state={state} />
        <div className="event-hero-text">
          <h2>{event.title}</h2>
          <p className="event-hero-when">
            {formatSpan(event, language)}
            <span className={`event-relative${live ? ' live' : ''}`}>
              {live ? t('event.now') : relativeTo(event.startsAt, language)}
            </span>
          </p>
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
        </div>
      </div>

      {event.description && <p className="event-description">{event.description}</p>}

      <div className="event-rsvp" role="group" aria-label={t('event.yourAnswer')}>
        {ANSWERS.map((a) => (
          <button
            key={a}
            type="button"
            className={`event-answer ${a}${mine === a ? ' on' : ''}`}
            aria-pressed={mine === a}
            onClick={() => void answer(a)}
          >
            {t(`event.answer.${a}`)}
          </button>
        ))}
      </div>

      <div className="event-attendees">
        {(['going', 'maybe'] as const).map(
          (a) =>
            who[a].length > 0 && (
              <div className="event-attendee-row" key={a}>
                <span className="event-attendee-label">
                  {t(`event.answer.${a}`)} · {who[a].length}
                </span>
                <span className="event-faces">
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
        {who.going.length === 0 && who.maybe.length === 0 && (
          <p className="event-nobody">{t('event.nobodyYet')}</p>
        )}
      </div>

      {error && <p className="settings-error">{error}</p>}
      <div className="event-footer">
        {canChange && (
          <>
            <button type="button" className="event-quiet danger-text" onClick={() => void cancel()}>
              {t('event.cancel')}
            </button>
            <button type="button" className="event-quiet" onClick={onEdit}>
              {t('event.edit')}
            </button>
          </>
        )}
        {channel && (
          <button
            type="button"
            className="primary"
            onClick={() => {
              onJoin(channel.id);
              onClose();
            }}
          >
            {t('event.join', { channel: channel.name })}
          </button>
        )}
      </div>
      {dialog}
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
