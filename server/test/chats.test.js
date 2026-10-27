/**
 * The chat list (ADR 0036): a default chat that always exists, others up to a
 * limit that starts at ten and that admins raise or lower.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase } from '../src/database.js';
import { createChatStore, CHAT_CEILING, DEFAULT_MAX_CHATS, cleanChatName } from '../src/chats.js';

const quiet = { info() {}, warn() {}, error() {} };

let dir;
let db;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zoia-chats-'));
  db = openDatabase(join(dir, 'zoia.db'));
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

const open = (options = {}) => createChatStore({ db, logger: quiet, ...options });

describe('the default chat', () => {
  test('exists from the start, under the configured name', async () => {
    const chats = open({ defaultName: 'Conversa' });
    const list = await chats.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'Conversa');
    assert.equal(list[0].isDefault, true);
  });

  test('is created once, however many times the store is opened', async () => {
    await open().ready;
    await open().ready;
    assert.equal((await open().list()).length, 1);
  });

  test('can be renamed but not removed', async () => {
    const chats = open();
    const [chat] = await chats.list();
    assert.equal((await chats.rename(chat.id, 'Papo', { by: 'admin1' })).chat.name, 'Papo');
    assert.deepEqual(await chats.remove(chat.id), { ok: false, reason: 'default_chat' });
  });

  test('the database refuses a second one, even past the store', async () => {
    await open().ready;
    assert.throws(
      () =>
        db.sqlite
          .prepare(
            `INSERT INTO chats (id, name, is_default, created_at) VALUES ('ffffffff', 'X', 1, 'now')`,
          )
          .run(),
      /UNIQUE/,
    );
  });
});

describe('the limit', () => {
  test('starts at ten, the default included, and refuses an eleventh', async () => {
    const chats = open();
    assert.equal(await chats.max(), DEFAULT_MAX_CHATS);
    assert.equal(DEFAULT_MAX_CHATS, 10);
    for (let i = 1; i < DEFAULT_MAX_CHATS; i += 1) {
      assert.equal((await chats.add({ name: `Chat ${i}`, by: 'a' })).ok, true);
    }
    assert.deepEqual(await chats.add({ name: 'Jogos', by: 'a' }), {
      ok: false,
      reason: 'chat_limit',
    });
  });

  test('raised, allows that many chats in all, the default included', async () => {
    const chats = open();
    assert.deepEqual(await chats.setMax(3, { by: 'super' }), { ok: true, max: 3 });
    assert.equal((await chats.add({ name: 'Jogos', by: 'a' })).ok, true);
    assert.equal((await chats.add({ name: 'Filmes', by: 'a' })).ok, true);
    assert.equal((await chats.add({ name: 'Música', by: 'a' })).reason, 'chat_limit');
    assert.deepEqual(
      (await chats.list()).map((c) => c.name),
      ['Geral', 'Jogos', 'Filmes'],
    );
  });

  test('survives the store being reopened', async () => {
    await open().setMax(4);
    assert.equal(await open().max(), 4);
  });

  test('lowered below how many exist removes none', async () => {
    const chats = open();
    await chats.setMax(3);
    await chats.add({ name: 'Jogos' });
    await chats.add({ name: 'Filmes' });
    await chats.setMax(1);
    assert.equal((await chats.list()).length, 3);
    assert.equal((await chats.add({ name: 'Música' })).reason, 'chat_limit');
  });

  test('refuses anything but a whole number from one to the ceiling', async () => {
    const chats = open();
    for (const value of [0, -1, 1.5, CHAT_CEILING + 1, '3', null]) {
      assert.deepEqual(await chats.setMax(value), { ok: false, reason: 'invalid_limit' });
    }
    assert.equal((await chats.setMax(CHAT_CEILING)).ok, true);
  });

  test('a value written past the store is read within bounds', async () => {
    const chats = open();
    await chats.ready;
    const write = db.sqlite.prepare(
      `INSERT INTO settings (key, value) VALUES ('chats.max', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    );
    write.run('1000');
    assert.equal(await chats.max(), CHAT_CEILING);
    write.run('nonsense');
    assert.equal(await chats.max(), DEFAULT_MAX_CHATS);
  });
});

describe('adding, renaming and removing', () => {
  test('names are tidied and validated like channel names', async () => {
    const chats = open();
    await chats.setMax(2);
    assert.equal((await chats.add({ name: '   ' })).reason, 'invalid_name');
    assert.equal((await chats.add({ name: 'x'.repeat(33) })).reason, 'invalid_name');
    assert.equal((await chats.add({ name: '  Bate   papo ' })).chat.name, 'Bate papo');
    assert.equal(cleanChatName('a\u0007b'), null);
  });

  test('a removed chat frees its place and is returned for its messages', async () => {
    const chats = open();
    await chats.setMax(2);
    const { chat } = await chats.add({ name: 'Jogos', by: 'a' });
    const removed = await chats.remove(chat.id, { by: 'a' });
    assert.equal(removed.ok, true);
    assert.equal(removed.chat.id, chat.id);
    assert.equal(removed.chat.createdAt, chat.createdAt);
    assert.equal(await chats.find(chat.id), null);
    assert.equal((await chats.add({ name: 'Filmes' })).ok, true);
  });

  test('a chat that does not exist is reported, not created', async () => {
    const chats = open();
    assert.deepEqual(await chats.rename('nope0000', 'X'), { ok: false, reason: 'not_found' });
    assert.deepEqual(await chats.remove('nope0000'), { ok: false, reason: 'not_found' });
    assert.equal(await chats.find(42), null);
  });
});
