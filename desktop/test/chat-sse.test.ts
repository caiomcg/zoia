/**
 * The chat stream arrives in arbitrary chunks: an event can be split across
 * two, and the server's heartbeats are comments in between.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseSse, toChatEvent } from '../src/main/chat-sse.ts';

describe('parseSse', () => {
  test('takes complete events and leaves the rest for the next chunk', () => {
    const first = parseSse(': connected\n\nevent: chats\ndata: {}\n\nevent: read\ndata: {"chat');
    assert.deepEqual(first.events, [{ event: 'chats', data: '{}' }]);
    const second = parseSse(first.rest + 'Id":"c1"}\n\n');
    assert.deepEqual(second.events, [{ event: 'read', data: '{"chatId":"c1"}' }]);
    assert.equal(second.rest, '');
  });

  test('skips heartbeats, joins multi-line data, and reads CRLF', () => {
    const { events } = parseSse(': heartbeat\r\n\r\nevent: message\r\ndata: a\r\ndata: b\r\n\r\n');
    assert.deepEqual(events, [{ event: 'message', data: 'a\nb' }]);
  });
});

describe('toChatEvent', () => {
  test('turns what the server sends into what the window receives', () => {
    const message = { id: 'm', chatId: 'c', authorId: 'a', body: 'oi', sentAt: 'now' };
    assert.deepEqual(
      toChatEvent('message', JSON.stringify({ message, author: { name: 'Ana', avatar: null } })),
      { type: 'message', message, author: { name: 'Ana', avatar: null } },
    );
    assert.deepEqual(
      toChatEvent('read', JSON.stringify({ chatId: 'c', accountId: 'a', messageId: 'm' })),
      { type: 'read', chatId: 'c', accountId: 'a', messageId: 'm', reader: null },
    );
    assert.deepEqual(toChatEvent('chats', '{}'), { type: 'chats' });
    assert.deepEqual(toChatEvent('deleted', '{"chatId":"c1","messageId":"m1"}'), {
      type: 'deleted',
      chatId: 'c1',
      messageId: 'm1',
    });
    assert.deepEqual(
      toChatEvent(
        'reaction',
        '{"chatId":"c1","messageId":"m1","emoji":"👍","accountId":"a","on":false,"reactor":{"name":"Ana","avatar":null}}',
      ),
      {
        type: 'reaction',
        chatId: 'c1',
        messageId: 'm1',
        emoji: '👍',
        accountId: 'a',
        on: false,
        reactor: { name: 'Ana', avatar: null },
      },
    );
    assert.deepEqual(toChatEvent('presence', '{"accountId":"a","status":"busy"}'), {
      type: 'presence',
      accountId: 'a',
      status: 'busy',
    });
  });

  test('ignores what it does not know, and what is not JSON', () => {
    assert.equal(toChatEvent('mystery', '{}'), null);
    assert.equal(toChatEvent('message', 'not json'), null);
    assert.equal(toChatEvent('read', '{}'), null);
    // Invisible is never sent to others; a status not known is not guessed at.
    assert.equal(toChatEvent('presence', '{"accountId":"a","status":"invisible"}'), null);
  });
});
