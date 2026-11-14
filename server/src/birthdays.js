/**
 * Birthdays (ADR 0055): a day and a month, never a year, and the all-day
 * event the schedule's sweep puts on the calendar when one comes round.
 *
 * "The day" is a day in one time zone for the whole server (BIRTHDAY_TZ),
 * so everyone sees the same birthday start at the same midnight.
 */

/** Where days are counted unless BIRTHDAY_TZ says otherwise. */
export const DEFAULT_BIRTHDAY_TZ = 'America/Sao_Paulo';

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const pad = (n) => String(n).padStart(2, '0');

/**
 * A birthday as it is stored, `MM-DD`, or null when `value` is not one.
 * Accepts the stored form or `{ day, month }`. February 29 is a birthday.
 */
export function parseBirthday(value) {
  let month;
  let day;
  if (typeof value === 'string') {
    const match = /^(\d{2})-(\d{2})$/.exec(value);
    if (!match) return null;
    month = Number(match[1]);
    day = Number(match[2]);
  } else if (value && typeof value === 'object') {
    ({ month, day } = value);
  } else {
    return null;
  }
  if (!Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > DAYS_IN_MONTH[month - 1]) return null;
  return `${pad(month)}-${pad(day)}`;
}

/** Whether `zone` is a time zone this runtime knows. */
export function isTimeZone(zone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The calendar date it is at `at` (ms) in `zone`. */
export function dateIn(at, zone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    })
      .formatToParts(at)
      .map((p) => [p.type, Number(p.value)]),
  );
  return { year: parts.year, month: parts.month, day: parts.day };
}

/** How far `zone` is ahead of UTC at `at`, in ms. */
function offsetAt(at, zone) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
      .formatToParts(at)
      .map((part) => [part.type, Number(part.value)]),
  );
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** The moment (ms) a calendar date begins in `zone`. */
export function midnightIn({ year, month, day }, zone) {
  const guess = Date.UTC(year, month - 1, day);
  const first = guess - offsetAt(guess, zone);
  // Once more, in case the guess and the answer sit either side of a change
  // of clocks.
  return guess - offsetAt(first, zone);
}

const isLeap = (year) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/** The birthday, `MM-DD`, kept on `date`: February 29 falls on the 28th in other years. */
export function birthdayOn({ year, month, day }) {
  if (month === 2 && day === 28 && !isLeap(year)) return ['02-28', '02-29'];
  return [`${pad(month)}-${pad(day)}`];
}

/**
 * Today in `zone` at `at`: when it starts, how many minutes it lasts (a day
 * with a change of clocks has 23 or 25 hours) and whose birthdays fall on it.
 */
export function today(at, zone) {
  const date = dateIn(at, zone);
  const start = midnightIn(date, zone);
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + 1));
  const end = midnightIn(
    { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() },
    zone,
  );
  return {
    startsAt: new Date(start).toISOString(),
    durationMinutes: Math.round((end - start) / 60_000),
    birthdays: birthdayOn(date),
  };
}
