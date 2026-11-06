/**
 * Which new messages call you (the bell, the system notification and the
 * mention sound): what is written to you or names you, never your own, and
 * never what you are reading as it arrives.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { chatCallFor } from '../src/renderer/chat/notice.ts';
import { threadIdOf } from '../src/shared/ipc.ts';

const DM = 'dm-0123456789abcdef';
const CHAT = 'a1b2c3d4';
const ROOT = '6f1c2e10-ba11-11ef-8000-000000000001';

const message = (chatId: string, authorId = 'ana', mentions: string[] = []) => ({
  chatId,
  authorId,
  mentions: mentions.map((id) => ({ id, name: id })),
});

/** Reading the public chat, window in front, no thread open. */
const elsewhere = { me: 'bia', openId: CHAT, openThreadId: null, visible: true };

describe('a direct message', () => {
  test('from someone else calls you while another chat is open', () => {
    assert.deepEqual(chatCallFor({ ...elsewhere, message: message(DM) }), {
      kind: 'direct',
      chatId: DM,
    });
  });

  test('calls you with its chat open but not on screen, or the window behind', () => {
    assert.deepEqual(
      chatCallFor({ ...elsewhere, openId: DM, visible: false, message: message(DM) }),
      { kind: 'direct', chatId: DM },
    );
    assert.deepEqual(
      chatCallFor({ ...elsewhere, openId: null, visible: false, message: message(DM) }),
      { kind: 'direct', chatId: DM },
    );
  });

  test('is quiet while you are reading it', () => {
    assert.equal(chatCallFor({ ...elsewhere, openId: DM, message: message(DM) }), null);
  });

  test('of your own, from any machine, never calls you', () => {
    assert.equal(chatCallFor({ ...elsewhere, message: message(DM, 'bia') }), null);
    assert.equal(chatCallFor({ ...elsewhere, visible: false, message: message(DM, 'bia') }), null);
  });

  test('is a direct message even when it also @mentions you', () => {
    assert.equal(
      chatCallFor({ ...elsewhere, message: message(DM, 'ana', ['bia']) })?.kind,
      'direct',
    );
  });

  test('says nothing before you are known', () => {
    assert.equal(chatCallFor({ ...elsewhere, me: null, message: message(DM) }), null);
  });
});

describe("a reply in a direct chat's thread", () => {
  const thread = threadIdOf(DM, ROOT);

  test('calls you, and leads to the direct chat', () => {
    assert.deepEqual(chatCallFor({ ...elsewhere, message: message(thread) }), {
      kind: 'direct',
      chatId: DM,
    });
    // The direct chat open, its thread not: the reply is not on screen.
    assert.deepEqual(chatCallFor({ ...elsewhere, openId: DM, message: message(thread) }), {
      kind: 'direct',
      chatId: DM,
    });
  });

  test('is quiet while that thread is open on screen', () => {
    const open = { ...elsewhere, openId: DM, openThreadId: thread };
    assert.equal(chatCallFor({ ...open, message: message(thread) }), null);
    assert.deepEqual(chatCallFor({ ...open, visible: false, message: message(thread) }), {
      kind: 'direct',
      chatId: DM,
    });
  });

  test('of your own never calls you', () => {
    assert.equal(chatCallFor({ ...elsewhere, message: message(thread, 'bia') }), null);
  });
});

describe('a message in a chat everyone sees', () => {
  test('calls you only when it @mentions you', () => {
    const away = { ...elsewhere, openId: 'ffff0000' };
    assert.equal(chatCallFor({ ...away, message: message(CHAT) }), null);
    assert.equal(chatCallFor({ ...away, message: message(CHAT, 'ana', ['caio']) }), null);
    assert.deepEqual(chatCallFor({ ...away, message: message(CHAT, 'ana', ['bia']) }), {
      kind: 'mention',
      chatId: CHAT,
    });
  });

  test('is quiet while you are reading it, as a direct message is', () => {
    assert.equal(chatCallFor({ ...elsewhere, message: message(CHAT, 'ana', ['bia']) }), null);
    assert.equal(
      chatCallFor({ ...elsewhere, visible: false, message: message(CHAT, 'ana', ['bia']) })?.kind,
      'mention',
    );
  });

  test('a reply in its thread that @mentions you calls you, unless that thread is on screen', () => {
    const thread = threadIdOf(CHAT, ROOT);
    const mention = message(thread, 'ana', ['bia']);
    assert.deepEqual(chatCallFor({ ...elsewhere, message: mention }), {
      kind: 'mention',
      chatId: CHAT,
    });
    assert.equal(chatCallFor({ ...elsewhere, openThreadId: thread, message: mention }), null);
    assert.equal(chatCallFor({ ...elsewhere, message: message(thread) }), null);
  });
});
