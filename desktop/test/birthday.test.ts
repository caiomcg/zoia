import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  daysIn,
  isBirthdayOn,
  isRealBirthday,
  parseBirthday,
  toCelebrate,
} from '../src/renderer/schedule/birthday.ts';
import type { ScheduledEvent } from '../src/shared/ipc.ts';

const event = (over: Partial<ScheduledEvent>): ScheduledEvent => ({
  id: 'e1',
  title: 'Ana',
  description: null,
  startsAt: '2026-11-14T03:00:00.000Z',
  durationMinutes: 1440,
  channelId: null,
  createdBy: null,
  creatorName: null,
  rsvps: {},
  kind: 'birthday',
  subjectId: 'a1',
  subjectName: 'Ana',
  ...over,
});

describe('the birthday asked for', () => {
  test('is a day the month has, February 29 included', () => {
    assert.equal(daysIn(2), 29);
    assert.equal(daysIn(4), 30);
    assert.ok(isRealBirthday({ day: 29, month: 2 }));
    assert.ok(isRealBirthday({ day: 31, month: 12 }));
    assert.ok(!isRealBirthday({ day: 31, month: 4 }));
    assert.ok(!isRealBirthday({ day: null, month: 4 }));
    assert.ok(!isRealBirthday({ day: 1, month: 13 }));
    assert.ok(!isRealBirthday(null));
  });

  test('reads the server’s MM-DD, and nothing else', () => {
    assert.deepEqual(parseBirthday('02-29'), { month: 2, day: 29 });
    assert.equal(parseBirthday('04-31'), null);
    assert.equal(parseBirthday(null), null);
    assert.equal(parseBirthday('2-9'), null);
  });
});

describe('the party', () => {
  const during = Date.parse('2026-11-14T15:00:00Z');

  test('is for a birthday on now, once per machine', () => {
    const party = event({});
    assert.deepEqual(
      toCelebrate([party], during, new Set()).map((e) => e.id),
      ['e1'],
    );
    assert.deepEqual(toCelebrate([party], during, new Set(['e1'])), []);
  });

  test('is not for an ordinary event, nor a birthday over or to come', () => {
    assert.equal(isBirthdayOn(event({ kind: null }), during), false);
    assert.equal(isBirthdayOn(event({}), Date.parse('2026-11-15T03:00:00Z')), false);
    assert.equal(isBirthdayOn(event({}), Date.parse('2026-11-14T02:59:00Z')), false);
  });
});
