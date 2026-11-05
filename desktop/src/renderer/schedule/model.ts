/**
 * Scheduled events' bookkeeping (ADR 0050), kept free of React so it can be
 * tested: who answered what, whether an event is on now, and the
 * datetime-local field's text, which is in the reader's own time zone.
 */

import type { RsvpAnswer, ScheduledEvent } from '../../shared/ipc';

/** How long an event lasts when it does not say. Must match the server's default. */
export const DEFAULT_DURATION_MINUTES = 120;

/** The shortest and longest an event may last. Must match server/src/schedule.js. */
export const DURATION_MIN = 5;
export const DURATION_MAX = 14 * 24 * 60;

/** When an event ends, in milliseconds since the epoch. */
export const endOf = (event: ScheduledEvent) =>
  Date.parse(event.startsAt) + (event.durationMinutes ?? DEFAULT_DURATION_MINUTES) * 60_000;

/** A duration as the form shows it: the largest whole unit it fits. */
export function splitDuration(minutes: number): { amount: number; unit: DurationUnit } {
  if (minutes % (24 * 60) === 0) return { amount: minutes / (24 * 60), unit: 'days' };
  if (minutes % 60 === 0) return { amount: minutes / 60, unit: 'hours' };
  return { amount: minutes, unit: 'minutes' };
}

export type DurationUnit = 'minutes' | 'hours' | 'days';

/** The form's amount and unit as minutes, or null if that is not a whole, allowed duration. */
export function joinDuration(amount: number, unit: DurationUnit): number | null {
  const minutes = amount * (unit === 'days' ? 24 * 60 : unit === 'hours' ? 60 : 1);
  if (!Number.isInteger(minutes) || minutes < DURATION_MIN || minutes > DURATION_MAX) return null;
  return minutes;
}

/** Within this long of its start, an event shows as soon, and is pinned in the sidebar. */
export const SOON_MS = 60 * 60_000;

/** The account ids that gave each answer, in the order the server keeps them. */
export function answers(event: ScheduledEvent): Record<RsvpAnswer, string[]> {
  const out: Record<RsvpAnswer, string[]> = { going: [], maybe: [], no: [] };
  for (const [id, answer] of Object.entries(event.rsvps)) out[answer]?.push(id);
  return out;
}

/** Whether an event has ended, is on now, starts within the hour, or later. */
export function eventState(
  event: ScheduledEvent,
  now: number,
): 'ended' | 'live' | 'soon' | 'later' {
  const start = Date.parse(event.startsAt);
  if (start <= now) return now < endOf(event) ? 'live' : 'ended';
  return start - now <= SOON_MS ? 'soon' : 'later';
}

/** Whether an event belongs in the sidebar's carousel: from an hour before it until it ends. */
export const isPinned = (event: ScheduledEvent, now: number) => {
  const state = eventState(event, now);
  return state === 'live' || state === 'soon';
};

const pad = (n: number) => String(n).padStart(2, '0');

/** An ISO time as a datetime-local field shows it, in this machine's time zone. */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A datetime-local field's text as an ISO time, or null if it is not one. */
export function fromLocalInput(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number) as [number, number, number, number, number, number];
  const date = new Date(y, mo - 1, d, h, mi);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Where a new event starts until changed: the next whole hour at least an hour away. */
export function defaultStart(now: number): string {
  const d = new Date(now + 60 * 60_000);
  d.setMinutes(0, 0, 0);
  if (d.getTime() - now < 60 * 60_000) d.setHours(d.getHours() + 1);
  return d.toISOString();
}

/** Events sorted soonest first, as the server sends them; kept stable for equal times. */
export function sortEvents(events: ScheduledEvent[]): ScheduledEvent[] {
  return [...events].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}

/** How far after the start a new event's end is put, until moved. */
export const DEFAULT_END_AFTER_MINUTES = 15;

/** A datetime-local text moved by `minutes`, in this machine's time zone; null if it is not one. */
export function shiftLocal(value: string, minutes: number): string | null {
  const iso = fromLocalInput(value);
  return iso ? toLocalInput(new Date(Date.parse(iso) + minutes * 60_000).toISOString()) : null;
}

/** Minutes from one datetime-local text to another, or null if either is not one. */
export function minutesBetween(from: string, to: string): number | null {
  const a = fromLocalInput(from);
  const b = fromLocalInput(to);
  return a && b ? Math.round((Date.parse(b) - Date.parse(a)) / 60_000) : null;
}
