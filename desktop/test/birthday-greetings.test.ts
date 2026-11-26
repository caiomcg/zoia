/**
 * Congratulating someone on their birthday: only the predefined greetings,
 * sent in your direct chat with them.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  BIRTHDAY_GREETINGS,
  sendBirthdayGreeting,
  type GreetingBridge,
} from '../src/renderer/schedule/greetings.ts';

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
