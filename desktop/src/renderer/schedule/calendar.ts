/**
 * The calendar (ADR 0056): a month as weeks of local days, with the events
 * and birthdays that fall on each. Kept free of React so it can be tested.
 *
 * A repeating event is one row on the server, its next occurrence only
 * (ADR 0050). The calendar shows the ones after it too, stepped as the
 * server will step them, so a weekly game night shows on every Friday.
 * Those are a forecast: answers belong to the next occurrence alone.
 */

import type { PersonBirthday, Recurrence, ScheduledEvent } from '../../shared/ipc';
import { endOf } from './model.ts';

const DAY_MS = 24 * 60 * 60_000;

/** How many occurrences of one repeating event are projected at most: a daily one over a year. */
const PROJECT_MAX = 400;

/** One thing on the calendar: an event's occurrence, or someone's birthday. */
export type CalendarItem =
  | {
      kind: 'event';
      event: ScheduledEvent;
      /** This occurrence's start and end, ms since the epoch. */
      start: number;
      end: number;
      /** A later occurrence of a repeating event, not the row itself. */
      projected: boolean;
    }
  | {
      kind: 'birthday';
      person: PersonBirthday;
      /** Local midnight of the day it falls on. */
      start: number;
    };

const pad = (n: number) => String(n).padStart(2, '0');

/** A local day as `YYYY-MM-DD`, the key the calendar groups by. */
export function dayKey(at: number | Date): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The days a month's page shows, local midnights: whole weeks from the one
 * holding the 1st, starting on `weekStart` (0 Sunday … 6 Saturday), always
 * six of them so the page does not change height from month to month.
 */
export function monthGrid(year: number, month: number, weekStart = 0): Date[] {
  const first = new Date(year, month, 1);
  const back = (first.getDay() - weekStart + 7) % 7;
  // By calendar day, not by adding 24 hours: a day with a change of clocks
  // is 23 or 25 hours long.
  return Array.from({ length: 42 }, (_, i) => new Date(year, month, 1 - back + i));
}

/**
 * The start after `iso` for an event that repeats so. Must match nextStart in
 * server/src/schedule.js: days and weeks are fixed lengths of UTC time; a
 * month is the same UTC day next month, its last day when it has fewer.
 */
export function nextStart(iso: string, recurrence: Recurrence): string {
  const date = new Date(iso);
  if (recurrence === 'daily') return new Date(date.getTime() + DAY_MS).toISOString();
  if (recurrence === 'weekly') return new Date(date.getTime() + 7 * DAY_MS).toISOString();
  const day = date.getUTCDate();
  const next = new Date(date);
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const last = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, last));
  return next.toISOString();
}

/**
 * Every occurrence of the events that overlaps `[from, to)`: the event as it
 * is, and, for one that repeats, the occurrences after it.
 */
export function occurrencesIn(
  events: readonly ScheduledEvent[],
  from: number,
  to: number,
): Extract<CalendarItem, { kind: 'event' }>[] {
  const out: Extract<CalendarItem, { kind: 'event' }>[] = [];
  for (const event of events) {
    const length = endOf(event) - Date.parse(event.startsAt);
    let iso = event.startsAt;
    for (let i = 0; i < PROJECT_MAX; i++) {
      const start = Date.parse(iso);
      if (start >= to) break;
      if (start + length > from) {
        out.push({ kind: 'event', event, start, end: start + length, projected: i > 0 });
      }
      if (!event.recurrence) break;
      iso = nextStart(iso, event.recurrence);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

const isLeap = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/**
 * The birthdays that fall in `[from, to)`, on the local day of their date.
 * February 29 falls on the 28th in a year without one, as on the server.
 */
export function birthdaysIn(
  people: readonly PersonBirthday[],
  from: number,
  to: number,
): Extract<CalendarItem, { kind: 'birthday' }>[] {
  const first = new Date(from).getFullYear();
  const last = new Date(to).getFullYear();
  const out: Extract<CalendarItem, { kind: 'birthday' }>[] = [];
  for (const person of people) {
    const match = /^(\d{2})-(\d{2})$/.exec(person.birthday);
    if (!match) continue;
    const month = Number(match[1]);
    const date = Number(match[2]);
    for (let year = first; year <= last; year++) {
      const day = month === 2 && date === 29 && !isLeap(year) ? 28 : date;
      const start = new Date(year, month - 1, day).getTime();
      if (start >= from && start < to) out.push({ kind: 'birthday', person, start });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * What each local day of `days` holds, birthdays first, then events by start.
 * An event over several days is on each. The server's birthday events are
 * left out when the birthdays themselves are known: they are the same day.
 */
export function itemsByDay(
  days: readonly Date[],
  events: readonly ScheduledEvent[],
  birthdays: readonly PersonBirthday[] | null,
): Map<string, CalendarItem[]> {
  const byDay = new Map<string, CalendarItem[]>(days.map((d) => [dayKey(d), []]));
  if (days.length === 0) return byDay;
  const from = days[0]!.getTime();
  const lastDay = days[days.length - 1]!;
  const to = new Date(lastDay.getFullYear(), lastDay.getMonth(), lastDay.getDate() + 1).getTime();
  const shown = birthdays ? events.filter((e) => e.kind !== 'birthday') : events;

  for (const item of birthdaysIn(birthdays ?? [], from, to)) {
    byDay.get(dayKey(item.start))?.push(item);
  }
  for (const item of occurrencesIn(shown, from, to)) {
    // Each local day it touches; an end at midnight does not touch the next.
    const cursor = new Date(Math.max(item.start, from));
    cursor.setHours(0, 0, 0, 0);
    while (cursor.getTime() < Math.min(item.end, to)) {
      byDay.get(dayKey(cursor))?.push(item);
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  return byDay;
}

/** The first day of the week where `language` is spoken (0 Sunday … 6 Saturday). */
export function weekStartFor(language: string): number {
  try {
    const locale = new Intl.Locale(language) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const info = locale.getWeekInfo?.() ?? locale.weekInfo;
    // Intl counts Monday as 1 and Sunday as 7.
    if (info) return info.firstDay % 7;
  } catch {
    // An engine without week info: Sunday, as Brazil and the US have it.
  }
  return 0;
}
