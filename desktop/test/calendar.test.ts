/**
 * The calendar (ADR 0056): months as whole weeks, repeating events forecast
 * as the server will step them, and birthdays on their day every year.
 * Run under TZ=America/Sao_Paulo by the npm script's environment or not:
 * every expectation is in local time, whatever the zone.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  birthdaysIn,
  dayKey,
  itemsByDay,
  monthGrid,
  nextStart,
  occurrencesIn,
} from '../src/renderer/schedule/calendar.ts';
import type { PersonBirthday, ScheduledEvent } from '../src/shared/ipc.ts';

const event = (over: Partial<ScheduledEvent>): ScheduledEvent => ({
  id: 'e1',
  title: 'Ranked night',
  description: null,
  startsAt: new Date(2026, 10, 27, 21, 0).toISOString(),
  durationMinutes: 120,
  recurrence: null,
  channelId: null,
  createdBy: 'a1',
  creatorName: 'Ana',
  rsvps: {},
  ...over,
});

const person = (birthday: string, name = 'Bia'): PersonBirthday => ({
  accountId: `id-${name}`,
  name,
  birthday,
});

const local = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();

describe('a month page', () => {
  test('is six whole weeks from the one holding the 1st, on the chosen first weekday', () => {
    // November 2026 begins on a Sunday.
    const sunday = monthGrid(2026, 10, 0);
    assert.equal(sunday.length, 42);
    assert.equal(dayKey(sunday[0]!), '2026-11-01');
    const monday = monthGrid(2026, 10, 1);
    assert.equal(dayKey(monday[0]!), '2026-10-26');
    assert.ok(monday.every((d, i) => i === 0 || d.getDay() === (monday[i - 1]!.getDay() + 1) % 7));
  });
});

describe('repeating events on the calendar', () => {
  test('step as the server does: a month on keeps the day, or the month’s last', () => {
    assert.equal(nextStart('2027-01-31T23:00:00.000Z', 'monthly'), '2027-02-28T23:00:00.000Z');
    assert.equal(nextStart('2026-11-27T00:00:00.000Z', 'weekly'), '2026-12-04T00:00:00.000Z');
    assert.equal(nextStart('2026-11-27T00:00:00.000Z', 'daily'), '2026-11-28T00:00:00.000Z');
  });

  test('a weekly event shows every week of the page; only the first is the row itself', () => {
    const found = occurrencesIn(
      [event({ recurrence: 'weekly' })],
      local(2026, 11, 1),
      local(2026, 12, 13),
    );
    assert.equal(found.length, 3);
    assert.deepEqual(
      found.map((o) => o.projected),
      [false, true, true],
    );
  });

  test('an event once shows once, and not on a page before or after it', () => {
    const once = [event({})];
    assert.equal(occurrencesIn(once, local(2026, 11, 1), local(2026, 12, 1)).length, 1);
    assert.equal(occurrencesIn(once, local(2026, 12, 1), local(2027, 1, 1)).length, 0);
  });
});

describe('birthdays on the calendar', () => {
  test('fall on their day every year, February 29 on the 28th when there is none', () => {
    const found = birthdaysIn(
      [person('02-29'), person('03-05', 'Ana')],
      local(2027, 1, 1),
      local(2029, 1, 1),
    );
    assert.deepEqual(
      found.map((b) => `${b.person.name} ${dayKey(b.start)}`),
      ['Bia 2027-02-28', 'Ana 2027-03-05', 'Bia 2028-02-29', 'Ana 2028-03-05'],
    );
  });
});

describe('a day’s items', () => {
  test('birthdays first; an event over midnight is on both days; the server’s birthday event is not doubled', () => {
    const days = monthGrid(2026, 10, 0);
    const late = event({
      id: 'late',
      startsAt: new Date(2026, 10, 27, 23, 0).toISOString(),
      durationMinutes: 180,
    });
    const party = event({
      id: 'party',
      kind: 'birthday',
      subjectId: 'id-Bia',
      startsAt: new Date(2026, 10, 27).toISOString(),
      durationMinutes: 1440,
    });
    const map = itemsByDay(days, [late, party], [person('11-27')]);
    assert.deepEqual(
      map.get('2026-11-27')!.map((i) => i.kind),
      ['birthday', 'event'],
    );
    assert.deepEqual(
      map.get('2026-11-28')!.map((i) => (i.kind === 'event' ? i.event.id : i.kind)),
      ['late'],
    );

    // A server without the birthdays list: its birthday event is all there is.
    const old = itemsByDay(days, [party], null);
    assert.equal(old.get('2026-11-27')!.length, 1);
    assert.equal(old.get('2026-11-28')!.length, 0);
  });
});
