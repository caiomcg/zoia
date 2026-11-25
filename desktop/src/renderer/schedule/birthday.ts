/**
 * Birthdays (ADR 0055), as the window handles them: the day and month a
 * person gives, and which birthdays on the calendar are still to be
 * celebrated on this machine. Pure, so it is tested without a window.
 */

import type { Birthday, ScheduledEvent } from '../../shared/ipc';
import { endOf } from './model.ts';

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** How many days `month` (1–12) can have: February has 29, as a birthday may be on it. */
export const daysIn = (month: number) => DAYS_IN_MONTH[month - 1] ?? 31;

/** Whether this is a day that exists in some year. */
export function isRealBirthday(
  value: { day?: number | null; month?: number | null } | null | undefined,
): value is Birthday {
  if (!value) return false;
  const { day, month } = value;
  return (
    Number.isInteger(day) &&
    Number.isInteger(month) &&
    month! >= 1 &&
    month! <= 12 &&
    day! >= 1 &&
    day! <= daysIn(month!)
  );
}

/** The server's `MM-DD` as a day and month, or null. */
export function parseBirthday(stored: string | null | undefined): Birthday | null {
  const match = /^(\d{2})-(\d{2})$/.exec(stored ?? '');
  if (!match) return null;
  const birthday = { month: Number(match[1]), day: Number(match[2]) };
  return isRealBirthday(birthday) ? birthday : null;
}

/** Whether a birthday is on the calendar now, in the window's clock. */
export function isBirthdayOn(event: ScheduledEvent, at: number): boolean {
  return event.kind === 'birthday' && Date.parse(event.startsAt) <= at && endOf(event) > at;
}

/** Birthdays on now that this machine has not celebrated yet. */
export function toCelebrate(
  events: readonly ScheduledEvent[],
  at: number,
  celebrated: ReadonlySet<string>,
): ScheduledEvent[] {
  return events.filter((e) => isBirthdayOn(e, at) && !celebrated.has(e.id));
}

const CELEBRATED_KEY = 'zoia.birthdays.celebrated';
/** Birthday events remembered as celebrated: a day's worth, and then some. */
const CELEBRATED_MAX = 50;

/** The birthday events this machine has celebrated, from storage. */
export function readCelebrated(): Set<string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(CELEBRATED_KEY) ?? '[]');
    return new Set(Array.isArray(stored) ? stored.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

/** Remembers a birthday as celebrated, so the party is once per birthday per machine. */
export function markCelebrated(id: string): void {
  try {
    const ids = [...readCelebrated()].filter((x) => x !== id);
    ids.push(id);
    localStorage.setItem(CELEBRATED_KEY, JSON.stringify(ids.slice(-CELEBRATED_MAX)));
  } catch {
    // Storage off: the party comes again at the next launch that day, which is fine.
  }
}
