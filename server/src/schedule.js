/**
 * Scheduled events (ADR 0050): "ranked night, Friday at nine", with who is
 * going. Anyone let in may schedule one; its creator and admins change or
 * cancel it. When it starts, everyone who said they would come, or might, is
 * told on the chat's stream, once.
 *
 * Kept in SQLite beside the accounts: a handful of rows, each read whole.
 * Events long past are deleted by the same sweep that announces them.
 *
 * Validation failures come back as `{ ok: false, reason }`, as in chats.js.
 */

import { randomBytes } from 'node:crypto';

import { createTableStore } from './database.js';
import { DEFAULT_BIRTHDAY_TZ, today } from './birthdays.js';

export const TITLE_MAX = 100;
export const DESCRIPTION_MAX = 1000;

/** Upcoming events there may be at once, so nobody can fill the list. */
export const UPCOMING_MAX = 50;

/** How far ahead an event may be scheduled. */
const AHEAD_MAX_MS = 366 * 24 * 60 * 60_000;

/** A start this far in the past is still accepted: the form took a minute. */
const PAST_GRACE_MS = 5 * 60_000;

/** How long an event lasts when nobody said: a game night. */
export const DEFAULT_DURATION_MINUTES = 120;

/** The shortest and longest an event may last: five minutes to two weeks. */
export const DURATION_MIN = 5;
export const DURATION_MAX = 14 * 24 * 60;

/** When an event ends, in milliseconds since the epoch. */
export const endOf = (event) =>
  Date.parse(event.startsAt) + (event.durationMinutes ?? DEFAULT_DURATION_MINUTES) * 60_000;

/** Started longer ago than this, an event is not announced any more: the server was down. */
const ANNOUNCE_WINDOW_MS = 15 * 60_000;

/** Events are deleted this long after they ended. */
const KEEP_MS = 7 * 24 * 60 * 60_000;

export const ANSWERS = ['going', 'maybe', 'no'];

/** A birthday (ADR 0055): the sweep's to put on the calendar and take off, nobody else's. */
export const isBirthday = (event) => event?.kind === 'birthday';

/** How an event may repeat; null is once. */
export const RECURRENCES = ['daily', 'weekly', 'monthly'];

/**
 * The start after `iso` for an event that repeats so: a day or a week on, or
 * the same day next month (the month's last day when it has fewer), same time.
 * Days and weeks are fixed lengths of UTC time.
 */
export function nextStart(iso, recurrence) {
  const date = new Date(iso);
  if (recurrence === 'daily') return new Date(date.getTime() + 24 * 60 * 60_000).toISOString();
  if (recurrence === 'weekly') return new Date(date.getTime() + 7 * 24 * 60 * 60_000).toISOString();
  const day = date.getUTCDate();
  const next = new Date(date);
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const last = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, last));
  return next.toISOString();
}

/** A one-line text tidied, or null if it is not one or is too long. */
function cleanLine(value, max) {
  if (typeof value !== 'string') return null;
  const tidy = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return tidy && tidy.length <= max ? tidy : null;
}

/** A description: line breaks kept, empty allowed (as null); undefined if too long. */
function cleanDescription(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const tidy = value
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .trim();
  if (tidy.length > DESCRIPTION_MAX) return undefined;
  return tidy || null;
}

/** A start time as ISO text, or null if it is not one or not in the allowed range. */
function cleanStart(value, now) {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return null;
  if (time < now - PAST_GRACE_MS || time > now + AHEAD_MAX_MS) return null;
  return new Date(time).toISOString();
}

export function createEventStore({ db, logger = console, now = () => Date.now() }) {
  const table = createTableStore({ db, table: 'events' });

  /** Checks and tidies what may be set on an event. `partial` allows fields to be absent. */
  function fieldsOf(input, { partial = false, isChannel = () => true, current = null } = {}) {
    const out = {};
    if (!partial || input.title !== undefined) {
      const title = cleanLine(input.title, TITLE_MAX);
      if (!title) return { ok: false, reason: 'invalid_title' };
      out.title = title;
    }
    if (!partial || input.startsAt !== undefined) {
      // An event already under way keeps its start: saving other changes to
      // it must not be refused for a start that is now in the past.
      const unchanged =
        current &&
        typeof input.startsAt === 'string' &&
        Date.parse(input.startsAt) === Date.parse(current.startsAt);
      const startsAt = unchanged ? current.startsAt : cleanStart(input.startsAt, now());
      if (!startsAt) return { ok: false, reason: 'invalid_time' };
      out.startsAt = startsAt;
    }
    if (!partial || input.recurrence !== undefined) {
      const recurrence = input.recurrence ?? null;
      if (recurrence !== null && !RECURRENCES.includes(recurrence)) {
        return { ok: false, reason: 'invalid_recurrence' };
      }
      out.recurrence = recurrence;
    }
    if (!partial || input.description !== undefined) {
      const description = cleanDescription(input.description);
      if (description === undefined) return { ok: false, reason: 'invalid_description' };
      out.description = description;
    }
    if (!partial || input.durationMinutes !== undefined) {
      const minutes = input.durationMinutes ?? DEFAULT_DURATION_MINUTES;
      if (!Number.isInteger(minutes) || minutes < DURATION_MIN || minutes > DURATION_MAX) {
        return { ok: false, reason: 'invalid_duration' };
      }
      out.durationMinutes = minutes;
    }
    if (!partial || input.channelId !== undefined) {
      const channelId = input.channelId || null;
      if (channelId !== null && (typeof channelId !== 'string' || !isChannel(channelId))) {
        return { ok: false, reason: 'invalid_channel' };
      }
      out.channelId = channelId;
    }
    return { ok: true, fields: out };
  }

  // Events not over yet: to come, or on now.
  const upcoming = (events, at) => events.filter((e) => endOf(e) > at);

  /**
   * Puts today's birthdays on the calendar, as all-day events in `zone`, and
   * takes off one whose person no longer has a birthday today (they changed
   * it, or left). Resolves to whether the list changed.
   */
  function syncBirthdays(events, people, zone, at) {
    const day = today(at, zone);
    const due = new Map(
      people.filter((p) => day.birthdays.includes(p.birthday)).map((p) => [p.id, p]),
    );
    let changed = false;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (!isBirthday(event) || endOf(event) <= at) continue;
      if (due.has(event.subjectId) && event.startsAt === day.startsAt) {
        due.delete(event.subjectId);
      } else {
        events.splice(i, 1);
        changed = true;
      }
    }
    for (const person of due.values()) {
      events.push({
        id: randomBytes(6).toString('hex'),
        title: person.name,
        description: null,
        startsAt: day.startsAt,
        durationMinutes: day.durationMinutes,
        recurrence: null,
        channelId: null,
        createdBy: null,
        createdAt: new Date(at).toISOString(),
        updatedAt: null,
        notifiedAt: null,
        rsvps: {},
        kind: 'birthday',
        subjectId: person.id,
      });
      logger.info(`[schedule] birthday of ${person.id} on the calendar`);
      changed = true;
    }
    return changed;
  }

  return {
    /** Events on now and still to come, soonest first. */
    async list() {
      const at = now();
      return upcoming(await table.all(), at).sort((a, b) =>
        a.startsAt < b.startsAt ? -1 : a.startsAt > b.startsAt ? 1 : 0,
      );
    },

    async find(id) {
      return typeof id === 'string' ? table.find(id) : null;
    },

    async add(input, { by, isChannel } = {}) {
      const checked = fieldsOf(input ?? {}, { isChannel });
      if (!checked.ok) return checked;
      return table.mutate((events) => {
        // Birthdays come on their own and do not count against the limit.
        if (upcoming(events, now()).filter((e) => !isBirthday(e)).length >= UPCOMING_MAX) {
          return { ok: false, reason: 'event_limit' };
        }
        const event = {
          id: randomBytes(6).toString('hex'),
          ...checked.fields,
          createdBy: by ?? null,
          createdAt: new Date(now()).toISOString(),
          updatedAt: null,
          notifiedAt: null,
          // Whoever schedules it is going, unless they say otherwise.
          rsvps: by ? { [by]: 'going' } : {},
        };
        events.push(event);
        logger.info(`[schedule] event ${event.id} added by ${by}`);
        return { ok: true, event };
      });
    },

    /** Changes what is given; a new start time is announced again when it comes. */
    async update(id, input, { by, isChannel } = {}) {
      const current = await table.find(id);
      if (!current) return { ok: false, reason: 'not_found' };
      const checked = fieldsOf(input ?? {}, { partial: true, isChannel, current });
      if (!checked.ok) return checked;
      return table.mutate((events) => {
        const event = events.find((e) => e.id === id);
        if (!event) return { ok: false, reason: 'not_found' };
        if (isBirthday(event)) return { ok: false, reason: 'forbidden' };
        if (checked.fields.startsAt && checked.fields.startsAt !== event.startsAt) {
          event.notifiedAt = null;
        }
        Object.assign(event, checked.fields, { updatedAt: new Date(now()).toISOString() });
        logger.info(`[schedule] event ${id} changed by ${by}`);
        return { ok: true, event };
      });
    },

    async remove(id, { by } = {}) {
      return table.mutate((events) => {
        const index = events.findIndex((e) => e.id === id);
        if (index === -1) return { ok: false, reason: 'not_found' };
        if (isBirthday(events[index])) return { ok: false, reason: 'forbidden' };
        const [event] = events.splice(index, 1);
        logger.info(`[schedule] event ${id} cancelled by ${by}`);
        return { ok: true, event };
      });
    },

    /** Records `accountId`'s answer; null takes it back. */
    async answer(id, accountId, answer) {
      if (answer !== null && !ANSWERS.includes(answer))
        return { ok: false, reason: 'invalid_answer' };
      return table.mutate((events) => {
        const event = events.find((e) => e.id === id);
        if (!event) return { ok: false, reason: 'not_found' };
        // Nobody RSVPs to a birthday.
        if (isBirthday(event)) return { ok: false, reason: 'forbidden' };
        const rsvps = { ...(event.rsvps ?? {}) };
        if (answer === null) delete rsvps[accountId];
        else rsvps[accountId] = answer;
        event.rsvps = rsvps;
        return { ok: true, event };
      });
    },

    /**
     * Run every few seconds. Events that have just started and were not yet
     * announced are marked as announced; a repeating event that has ended
     * moves on to its next occurrence, its answers starting over with its
     * creator going; and events long over are deleted. Given `people` (each
     * `{ id, name, birthday }`), today's birthdays are put on the calendar
     * too (ADR 0055). Resolves to `{ starting, rolled }`: those to announce,
     * and whether the list changed otherwise. Birthdays are never in
     * `starting`: the app celebrates them from the list.
     */
    async sweep({ people = null, zone = DEFAULT_BIRTHDAY_TZ } = {}) {
      const at = now();
      return table.mutate((events) => {
        const starting = [];
        let rolled = people ? syncBirthdays(events, people, zone, at) : false;
        for (const event of events) {
          if (!event.recurrence || endOf(event) > at) continue;
          // Several, if the server was down through more than one.
          while (endOf(event) <= at) event.startsAt = nextStart(event.startsAt, event.recurrence);
          event.notifiedAt = null;
          event.rsvps = event.createdBy ? { [event.createdBy]: 'going' } : {};
          rolled = true;
        }
        for (const event of events) {
          const start = Date.parse(event.startsAt);
          if (event.notifiedAt || start > at) continue;
          event.notifiedAt = new Date(at).toISOString();
          if (!isBirthday(event) && start > at - ANNOUNCE_WINDOW_MS) starting.push(event);
        }
        for (let i = events.length - 1; i >= 0; i -= 1) {
          if (endOf(events[i]) < at - KEEP_MS) events.splice(i, 1);
        }
        return { starting, rolled };
      });
    },
  };
}

/** Who is told an event is starting: whoever said they are going, or might. */
export function audienceOf(event) {
  const ids = new Set(
    Object.entries(event.rsvps ?? {})
      .filter(([, answer]) => answer === 'going' || answer === 'maybe')
      .map(([id]) => id),
  );
  return [...ids];
}
