/**
 * Congratulating someone on their birthday: only the predefined greetings,
 * sent in your direct chat with them, and the bell remembering it was done.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  BIRTHDAY_GREETINGS,
  sendBirthdayGreeting,
  type GreetingBridge,
} from '../src/renderer/schedule/greetings.ts';
import { addToInbox, parseInbox, type InboxItem } from '../src/renderer/notify/notify.ts';

function fakeBridge(fail?: { direct?: string; send?: string }) {
  const calls: string[] = [];
  const bridge: GreetingBridge = {
    async direct(accountId) {
      calls.push(`direct ${accountId}`);
      return fail?.direct ? { ok: false, error: fail.direct } : { ok: true, value: { id: 'dm-1' } };
    },
    async send(chatId, body) {
      calls.push(`send ${chatId} ${body}`);
      return fail?.send ? { ok: false, error: fail.send } : { ok: true };
    },
  };
  return { bridge, calls };
}

describe('birthday greetings', () => {
  test('are the three predefined ones', () => {
    assert.deepEqual(BIRTHDAY_GREETINGS, [
      'Parabéns, chuchuzinho!',
      'Feliz aniversário, meu docinho!',
      'Felicidades, fofura!',
    ]);
  });

  test('go to the person in your direct chat with them', async () => {
    const { bridge, calls } = fakeBridge();
    assert.equal(await sendBirthdayGreeting('acc-7', 'Felicidades, fofura!', bridge), null);
    assert.deepEqual(calls, ['direct acc-7', 'send dm-1 Felicidades, fofura!']);
  });

  test('nothing but a predefined greeting is sent', async () => {
    const { bridge, calls } = fakeBridge();
    assert.equal(await sendBirthdayGreeting('acc-7', 'oi', bridge), 'invalid_greeting');
    assert.deepEqual(calls, []);
  });

  test('a refusal is told, and nothing sent when the chat cannot be opened', async () => {
    const closed = fakeBridge({ direct: 'not_found' });
    assert.equal(
      await sendBirthdayGreeting('acc-7', BIRTHDAY_GREETINGS[0], closed.bridge),
      'not_found',
    );
    assert.deepEqual(closed.calls, ['direct acc-7']);
    const refused = fakeBridge({ send: 'rate_limited' });
    assert.equal(
      await sendBirthdayGreeting('acc-7', BIRTHDAY_GREETINGS[0], refused.bridge),
      'rate_limited',
    );
  });
});

describe('a birthday under the bell', () => {
  const now = Date.now();
  const item = {
    id: 1,
    kind: 'birthday' as const,
    group: 'birthday:e1',
    title: 'It’s Ana’s birthday!',
    body: '',
    at: now,
    greet: { accountId: 'acc-7', name: 'Ana' },
  };

  test('keeps whose it is, and whether they were congratulated, across a restart', () => {
    const list: InboxItem[] = [{ ...addToInbox([], item)[0], greeted: true }];
    const [back] = parseInbox(JSON.stringify(list), now);
    assert.deepEqual(back.greet, { accountId: 'acc-7', name: 'Ana' });
    assert.equal(back.greeted, true);
  });

  test('an entry with a malformed greetee is dropped', () => {
    const raw = JSON.stringify([{ ...item, count: 1, read: false, greet: { accountId: 7 } }]);
    assert.deepEqual(parseInbox(raw, now), []);
  });
});
