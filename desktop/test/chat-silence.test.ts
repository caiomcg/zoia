/**
 * Silencing a chat takes away its sound and nothing else, and what is
 * remembered survives a bad or foreign value in storage.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  chatMessageCues,
  parseSilencedChats,
  shownUnread,
  serializeSilencedChats,
  withChatSilenced,
} from '../src/renderer/chat/silence.ts';

describe('parseSilencedChats', () => {
  test('nothing stored is nothing silenced', () => {
    assert.deepEqual([...parseSilencedChats(null)], []);
    assert.deepEqual([...parseSilencedChats('')], []);
  });

  test('reads back what was stored', () => {
    assert.deepEqual([...parseSilencedChats('["a","b"]')].sort(), ['a', 'b']);
  });

  test('a corrupt or foreign value is nothing silenced', () => {
    for (const raw of ['{', '"a"', '{"a":true}', '42', 'null']) {
      assert.deepEqual([...parseSilencedChats(raw)], [], raw);
    }
  });

  test('keeps the ids that make sense and drops the rest', () => {
    assert.deepEqual([...parseSilencedChats('["a", 3, null, "", "b", "a"]')].sort(), ['a', 'b']);
  });

  test('round-trips through what is stored', () => {
    const set = new Set(['z', 'a']);
    assert.equal(serializeSilencedChats(set), '["a","z"]');
    assert.deepEqual(parseSilencedChats(serializeSilencedChats(set)), set);
  });
});

describe('withChatSilenced', () => {
  test('silences and unsilences, leaving the given set alone', () => {
    const none: ReadonlySet<string> = new Set();
    const one = withChatSilenced(none, 'a', true);
    assert.deepEqual([...one], ['a']);
    assert.equal(none.size, 0);
    const back = withChatSilenced(one, 'a', false);
    assert.deepEqual([...back], []);
    assert.deepEqual([...one], ['a']);
  });

  test('no change is the same set, so nothing re-renders', () => {
    const one: ReadonlySet<string> = new Set(['a']);
    assert.equal(withChatSilenced(one, 'a', true), one);
    assert.equal(withChatSilenced(one, 'b', false), one);
  });
});

describe('chatMessageCues', () => {
  test('a mention rings in a chat that is not silenced', () => {
    assert.deepEqual(chatMessageCues(true, false), ['mention']);
  });

  test('a mention in a silenced chat is silent', () => {
    assert.deepEqual(chatMessageCues(true, true), []);
  });

  test('a plain message plays nothing either way', () => {
    assert.deepEqual(chatMessageCues(false, false), []);
    assert.deepEqual(chatMessageCues(false, true), []);
  });
});

describe('shownUnread', () => {
  const silenced = new Set(['quiet']);

  test('a chat that is not silenced shows all its unread', () => {
    assert.equal(shownUnread({ id: 'loud', unread: 7, mentions: 2 }, silenced), 7);
  });

  test('a silenced chat shows only the messages that mention you', () => {
    assert.equal(shownUnread({ id: 'quiet', unread: 7, mentions: 2 }, silenced), 2);
    assert.equal(shownUnread({ id: 'quiet', unread: 7, mentions: 0 }, silenced), 0);
  });

  test('a count not yet known is none', () => {
    assert.equal(shownUnread({ id: 'loud', unread: null }, silenced), 0);
    assert.equal(shownUnread({ id: 'quiet', unread: 3 }, silenced), 0);
  });
});
