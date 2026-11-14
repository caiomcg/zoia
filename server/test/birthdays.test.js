/**
 * Birthdays (ADR 0055): given at sign-up or later, day and month only, and
 * put on the calendar as an all-day event nobody can change.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseBirthday, today } from '../src/birthdays.js';

const ZONE = 'America/Sao_Paulo';

describe('the birthday itself', () => {
  test('is a day and a month that exist, February 29 included', () => {
    assert.equal(parseBirthday({ day: 29, month: 2 }), '02-29');
    assert.equal(parseBirthday({ day: 5, month: 11 }), '11-05');
    assert.equal(parseBirthday('11-05'), '11-05');
    for (const bad of [
      { day: 31, month: 4 },
      { day: 0, month: 1 },
      { day: 1, month: 13 },
      { day: '1', month: 1 },
      '2026-11-05',
      '1-5',
      null,
      42,
    ]) {
      assert.equal(parseBirthday(bad), null, JSON.stringify(bad));
    }
  });

  test('a day runs midnight to midnight in its zone, however long it is', () => {
    assert.deepEqual(today(Date.parse('2026-11-14T13:00:00Z'), ZONE), {
      startsAt: '2026-11-14T03:00:00.000Z',
      durationMinutes: 1440,
      birthdays: ['11-14'],
    });
    // Clocks go forward in Lisbon on 29 March 2026: a day of 23 hours.
    assert.equal(today(Date.parse('2026-03-29T12:00:00Z'), 'Europe/Lisbon').durationMinutes, 1380);
  });

  test('February 29 is kept on the 28th when the year has none', () => {
    assert.deepEqual(today(Date.parse('2027-02-28T15:00:00Z'), ZONE).birthdays, ['02-28', '02-29']);
    assert.deepEqual(today(Date.parse('2028-02-28T15:00:00Z'), ZONE).birthdays, ['02-28']);
  });
});
