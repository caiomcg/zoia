/**
 * Typing (ADR 0049), threads' and direct chats' ids (ADR 0047, 0048), the
 * stream's new events, and scheduled events' bookkeeping (ADR 0050).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  TYPING_EVERY_MS,
  TYPING_SHOWN_MS,
  addTyper,
  pruneTypers,
  removeTyper,
  shouldPing,
} from '../src/renderer/chat/typing.ts';
import { isDirectChatId, threadIdOf, threadParts } from '../src/shared/ipc.ts';
import type { ScheduledEvent } from '../src/shared/ipc.ts';
import { toChatEvent } from '../src/main/chat-sse.ts';
import {
  answers,
  endOf,
  joinDuration,
  minutesBetween,
  shiftLocal,
  splitDuration,
  defaultStart,
  eventState,
  isPinned,
  fromLocalInput,
  sortEvents,
  toLocalInput,
} from '../src/renderer/schedule/model.ts';

describe('typing', () => {
  test('shows someone for a few seconds after they last said so', () => {
    const typers = addTyper({}, 'ana', 'Ana', 1_000);
    assert.equal(typers.ana!.until, 1_000 + TYPING_SHOWN_MS);
    assert.equal(pruneTypers(typers, 1_000 + TYPING_SHOWN_MS - 1), typers);
    assert.deepEqual(pruneTypers(typers, 1_000 + TYPING_SHOWN_MS), {});
  });

  test('saying so again keeps them; their message takes them off', () => {
    let typers = addTyper({}, 'ana', 'Ana', 0);
    typers = addTyper(typers, 'bia', 'Bia', 0);
    typers = addTyper(typers, 'ana', 'Ana', 4_000);
    assert.deepEqual(Object.keys(pruneTypers(typers, TYPING_SHOWN_MS)), ['ana']);
    assert.deepEqual(Object.keys(removeTyper(typers, 'ana')), ['bia']);
    assert.equal(removeTyper(typers, 'nobody'), typers);
  });

  test('your own app says it at most every few seconds', () => {
    assert.equal(shouldPing(undefined, 0), true);
    assert.equal(shouldPing(0, TYPING_EVERY_MS - 1), false);
    assert.equal(shouldPing(0, TYPING_EVERY_MS), true);
  });
});

describe('chat ids', () => {
  const root = '6a1c2e80-ba1f-11f0-8de9-0242ac120002';

  test('a thread is its chat and its message', () => {
    assert.equal(threadIdOf('abcd1234', root), `abcd1234~${root}`);
    assert.deepEqual(threadParts(`abcd1234~${root}`), { chatId: 'abcd1234', rootId: root });
    assert.deepEqual(threadParts(`dm-0123456789abcdef~${root}`), {
      chatId: 'dm-0123456789abcdef',
      rootId: root,
    });
    assert.equal(threadParts('abcd1234'), null);
  });

  test('a direct chat is dm- and sixteen hex characters', () => {
    assert.equal(isDirectChatId('dm-0123456789abcdef'), true);
    assert.equal(isDirectChatId('abcd1234'), false);
    assert.equal(isDirectChatId('dm-0123'), false);
    assert.equal(isDirectChatId(`dm-0123456789abcdef~${root}`), false);
  });
});

describe('the stream', () => {
  test('reads typing, thread counts, schedule changes and an event starting', () => {
    assert.deepEqual(
      toChatEvent('typing', JSON.stringify({ chatId: 'c1', accountId: 'a1', name: 'Ana' })),
      { type: 'typing', chatId: 'c1', accountId: 'a1', name: 'Ana' },
    );
    assert.equal(toChatEvent('typing', JSON.stringify({ chatId: 'c1' })), null);
    const thread = { count: 2, lastReplyAt: '2026-11-05T10:00:00.000Z', participants: ['a1'] };
    assert.deepEqual(
      toChatEvent('thread', JSON.stringify({ chatId: 'c1', rootId: 'r1', thread })),
      { type: 'thread', chatId: 'c1', rootId: 'r1', thread },
    );
    assert.deepEqual(toChatEvent('thread', JSON.stringify({ chatId: 'c1', rootId: 'r1' })), {
      type: 'thread',
      chatId: 'c1',
      rootId: 'r1',
      thread: null,
    });
    assert.deepEqual(toChatEvent('schedule', '{}'), { type: 'schedule' });
    const event = { id: 'e1', title: 'Jogo' };
    assert.deepEqual(toChatEvent('event_starting', JSON.stringify({ event })), {
      type: 'event_starting',
      event,
    });
    assert.equal(toChatEvent('event_starting', '{}'), null);
  });
});

describe('scheduled events', () => {
  const event = (startsAt: string, rsvps: ScheduledEvent['rsvps'] = {}): ScheduledEvent => ({
    id: startsAt,
    title: 'Jogo',
    description: null,
    startsAt,
    channelId: null,
    createdBy: null,
    creatorName: null,
    rsvps,
  });

  test('answers are grouped by what was said', () => {
    const e = event('2026-11-05T21:00:00.000Z', { a: 'going', b: 'maybe', c: 'going', d: 'no' });
    assert.deepEqual(answers(e), { going: ['a', 'c'], maybe: ['b'], no: ['d'] });
  });

  test('on now until it ends, soon within the hour before, and only those are pinned', () => {
    const start = Date.parse('2026-11-05T21:00:00.000Z');
    const e = event(new Date(start).toISOString());
    const twoHours = 2 * 60 * 60_000;
    assert.equal(endOf(e), start + twoHours);
    assert.equal(eventState(e, start), 'live');
    assert.equal(eventState(e, start + twoHours - 1), 'live');
    assert.equal(eventState(e, start + twoHours), 'ended');
    assert.equal(eventState(e, start - 30 * 60_000), 'soon');
    assert.equal(eventState(e, start - 2 * 60 * 60_000), 'later');
    assert.equal(isPinned(e, start - 61 * 60_000), false);
    assert.equal(isPinned(e, start - 60 * 60_000), true);
    assert.equal(isPinned(e, start + twoHours), false);
    const lan = { ...e, durationMinutes: 3 * 24 * 60 };
    assert.equal(eventState(lan, start + 2 * 24 * 60 * 60_000), 'live');
  });

  test('an end moves with its start, across midnight too', () => {
    assert.equal(shiftLocal('2026-11-05T23:50', 15), '2026-11-06T00:05');
    assert.equal(shiftLocal('2026-11-05T21:00', -30), '2026-11-05T20:30');
    assert.equal(shiftLocal('nope', 15), null);
    assert.equal(minutesBetween('2026-11-05T21:00', '2026-11-05T23:00'), 120);
    assert.equal(minutesBetween('2026-11-05T21:00', '2026-11-07T21:00'), 2 * 24 * 60);
    assert.equal(minutesBetween('2026-11-05T21:00', ''), null);
  });

  test('a duration is shown in its largest whole unit, and read back within its limits', () => {
    assert.deepEqual(splitDuration(120), { amount: 2, unit: 'hours' });
    assert.deepEqual(splitDuration(90), { amount: 90, unit: 'minutes' });
    assert.deepEqual(splitDuration(2 * 24 * 60), { amount: 2, unit: 'days' });
    assert.equal(joinDuration(2, 'hours'), 120);
    assert.equal(joinDuration(1.5, 'hours'), 90);
    assert.equal(joinDuration(4, 'minutes'), null);
    assert.equal(joinDuration(15, 'days'), null);
    assert.equal(joinDuration(0.3, 'minutes'), null);
  });

  test('the date field round-trips in local time, and refuses anything else', () => {
    const iso = new Date(2026, 10, 5, 21, 30).toISOString();
    assert.equal(toLocalInput(iso), '2026-11-05T21:30');
    assert.equal(fromLocalInput('2026-11-05T21:30'), iso);
    assert.equal(fromLocalInput(''), null);
    assert.equal(fromLocalInput('tomorrow'), null);
  });

  test('a new event starts on the hour, at least an hour away', () => {
    const now = new Date(2026, 10, 5, 20, 10).getTime();
    assert.equal(defaultStart(now), new Date(2026, 10, 5, 22, 0).toISOString());
    const onTheHour = new Date(2026, 10, 5, 20, 0).getTime();
    assert.equal(defaultStart(onTheHour), new Date(2026, 10, 5, 21, 0).toISOString());
  });

  test('sorted soonest first', () => {
    const list = [event('2026-11-07T00:00:00.000Z'), event('2026-11-06T00:00:00.000Z')];
    assert.deepEqual(
      sortEvents(list).map((e) => e.startsAt),
      ['2026-11-06T00:00:00.000Z', '2026-11-07T00:00:00.000Z'],
    );
  });
});
