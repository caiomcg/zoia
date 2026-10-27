/**
 * The chat API (ADR 0036), over real sessions and a real chat list. Messages
 * go to an in-memory stand-in for the ScyllaDB store, whose own behaviour
 * messages.test.js covers against Scylla itself: these are about who may do
 * what, what goes out on the stream, and what a client is told.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { get } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import cassandra from 'cassandra-driver';

import { createApp } from '../src/app.js';
import { createStage } from '../src/stage.js';
import { PASSWORD, signIn, testStores } from './people.js';
import { createMediaStore, MEDIA_MAX_BYTES } from '../src/chat-media.js';

const { TimeUuid } = cassandra.types;
const quiet = { info() {}, warn() {}, error() {} };

/**
 * What the routes use of the message store, kept in memory. Messages are in
 * the order sent, so a message's place in `sent` stands in for its time.
 */
function memoryMessages() {
  const sent = [];
  const markers = new Map();
  const key = (chatId, accountId) => `${chatId}/${accountId}`;
  // [{ chatId, messageId, emoji, accountId }], oldest first.
  const reactions = [];
  const place = (id) => sent.findIndex((m) => m.id === id);
  return {
    async send({ chatId, authorId, body, attachment = null, replyTo = null, mentions = [] }) {
      const id = TimeUuid.now();
      const message = {
        id: id.toString(),
        chatId,
        authorId,
        body,
        sentAt: id.getDate().toISOString(),
        attachment,
        replyTo,
        mentions,
      };
      sent.push(message);
      return message;
    },
    async get({ chatId, id }) {
      return sent.find((m) => m.chatId === chatId && m.id === id) ?? null;
    },
    async remove({ chatId, id }) {
      const at = sent.findIndex((m) => m.chatId === chatId && m.id === id);
      if (at !== -1) sent.splice(at, 1);
      for (let i = reactions.length - 1; i >= 0; i -= 1) {
        if (reactions[i].chatId === chatId && reactions[i].messageId === id) reactions.splice(i, 1);
      }
    },
    async react({ chatId, messageId, accountId, emoji, on = true }) {
      const at = reactions.findIndex(
        (r) =>
          r.chatId === chatId &&
          r.messageId === messageId &&
          r.emoji === emoji &&
          r.accountId === accountId,
      );
      if (on && at === -1) reactions.push({ chatId, messageId, emoji, accountId });
      if (!on && at !== -1) reactions.splice(at, 1);
    },
    async reactions({ chatId, ids }) {
      const out = {};
      for (const r of reactions) {
        if (r.chatId !== chatId || !ids.includes(r.messageId)) continue;
        const list = (out[r.messageId] ??= []);
        let group = list.find((g) => g.emoji === r.emoji);
        if (!group) list.push((group = { emoji: r.emoji, accountIds: [] }));
        group.accountIds.push(r.accountId);
      }
      return out;
    },
    async page({ chatId, before, limit }) {
      const end = before ? place(before) : sent.length;
      return sent
        .slice(0, end === -1 ? 0 : end)
        .filter((m) => m.chatId === chatId)
        .reverse()
        .slice(0, limit);
    },
    async markRead({ chatId, accountId, messageId }) {
      if (!/^[0-9a-f-]{36}$/.test(messageId ?? '')) return false;
      markers.set(key(chatId, accountId), messageId);
      return true;
    },
    async readMarkers(chatId) {
      const out = new Map();
      for (const [k, v] of markers) {
        const [c, a] = k.split('/');
        if (c === chatId) out.set(a, v);
      }
      return out;
    },
    async unreadCounts({ chatId, accountId }) {
      const last = markers.has(key(chatId, accountId))
        ? place(markers.get(key(chatId, accountId)))
        : -1;
      const unread = sent
        .slice(last + 1)
        .filter((m) => m.chatId === chatId && m.authorId !== accountId);
      return {
        unread: unread.length,
        mentions: unread.filter((m) => m.mentions.some((x) => x.id === accountId)).length,
      };
    },
    removed: [],
    async removeChat({ chatId }) {
      this.removed.push(chatId);
    },
  };
}

let dir;
let stores;
let messages;
let available;
let app;

function buildApp(chat = {}) {
  return createApp({
    config: {
      sessionSecret: 'test-session-secret-long-enough',
      trustProxy: 1,
      secureCookies: false,
      roomName: 'zoia',
      rateLimit: { windowMs: 60_000, limit: 1000 },
      chat,
    },
    accountStore: stores.accounts,
    deviceStore: stores.devices,
    chatStore: stores.chats,
    messageStore: () => (available ? messages : null),
    chatMediaStore: createMediaStore({ dir: join(dir, 'chat-media') }),
    stage: createStage({
      rooms: { listParticipants: async () => [], updateParticipant: async () => {} },
      roomName: 'zoia',
      logger: quiet,
    }),
    logger: quiet,
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zoia-chat-'));
  stores = testStores(join(dir, 'zoia.db'));
  messages = memoryMessages();
  available = true;
  app = buildApp();
});

afterEach(async () => {
  await stores.db.idle();
  stores.db.close();
  await rm(dir, { recursive: true, force: true });
});

const defaultChat = async () => (await stores.chats.list())[0];

describe('the list', () => {
  test('everyone approved sees the default chat, the limit and their unread', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    const res = await ana.agent.get('/api/chats').expect(200);
    assert.equal(res.body.chats.length, 1);
    assert.equal(res.body.chats[0].isDefault, true);
    assert.equal(res.body.chats[0].unread, 0);
    assert.equal(res.body.max, 10);
    assert.equal(res.body.available, true);
  });

  test('without a session, or still pending, there is no chat', async () => {
    await request(app).get('/api/chats').expect(401);
    await stores.accounts.signup({ email: 'p@example.com', password: PASSWORD });
    const agent = request.agent(app);
    await agent
      .post('/api/login')
      .send({ email: 'p@example.com', password: PASSWORD, deviceName: 'PC' })
      .expect(200);
    await agent.get('/api/chats').expect(403);
  });

  test('says so when ScyllaDB is not there, and the list still shows', async () => {
    available = false;
    const ana = await signIn(app, stores.accounts, 'Ana');
    const res = await ana.agent.get('/api/chats').expect(200);
    assert.equal(res.body.available, false);
    assert.equal(res.body.chats[0].unread, null);
    const chat = await defaultChat();
    const sent = await ana.agent.post(`/api/chats/${chat.id}/messages`).send({ body: 'oi' });
    assert.equal(sent.status, 503);
    assert.equal(sent.body.error, 'chat_unavailable');
  });
});

describe('who may change the list', () => {
  test('admins and the super admin change the limit; users cannot', async () => {
    const user = await signIn(app, stores.accounts, 'Ana');
    const admin = await signIn(app, stores.accounts, 'Bia', { role: 'admin' });
    const boss = await signIn(app, stores.accounts, 'Caio', { role: 'super_admin' });

    await user.agent.put('/api/chats/limit').send({ max: 3 }).expect(403);
    await admin.agent.put('/api/chats/limit').send({ max: 0 }).expect(400);
    assert.equal((await admin.agent.put('/api/chats/limit').send({ max: 3 })).body.max, 3);
    assert.equal((await boss.agent.put('/api/chats/limit').send({ max: 4 })).body.max, 4);
    assert.equal((await user.agent.get('/api/chats')).body.max, 4);
  });

  test('admins add, rename and remove chats within the limit; users cannot', async () => {
    const user = await signIn(app, stores.accounts, 'Ana');
    const admin = await signIn(app, stores.accounts, 'Bia', { role: 'admin' });

    await user.agent.post('/api/chats').send({ name: 'Jogos' }).expect(403);
    // Lowered to the default chat alone, so the list is full.
    await stores.chats.setMax(1);
    const full = await admin.agent.post('/api/chats').send({ name: 'Jogos' }).expect(409);
    assert.equal(full.body.error, 'chat_limit');

    await stores.chats.setMax(2);
    const { body } = await admin.agent.post('/api/chats').send({ name: 'Jogos' }).expect(201);
    await user.agent.patch(`/api/chats/${body.chat.id}`).send({ name: 'X' }).expect(403);
    await admin.agent.patch(`/api/chats/${body.chat.id}`).send({ name: 'Games' }).expect(200);
    await user.agent.delete(`/api/chats/${body.chat.id}`).expect(403);
    await admin.agent.delete(`/api/chats/${body.chat.id}`).expect(200);
    assert.deepEqual(messages.removed, [body.chat.id]);

    const chat = await defaultChat();
    const kept = await admin.agent.delete(`/api/chats/${chat.id}`).expect(409);
    assert.equal(kept.body.error, 'default_chat');
  });
});

describe('messages', () => {
  test('a message is stored under its author, who has read it', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    const chat = await defaultChat();
    const res = await ana.agent
      .post(`/api/chats/${chat.id}/messages`)
      .send({ body: '  oi gente  ' })
      .expect(201);
    assert.equal(res.body.message.body, 'oi gente');
    assert.equal(res.body.message.authorId, ana.account.id);
    assert.deepEqual(res.body.author, { name: 'Ana', avatar: null });

    const page = await ana.agent.get(`/api/chats/${chat.id}/messages`).expect(200);
    assert.equal(page.body.messages.length, 1);
    assert.equal(page.body.readers[ana.account.id], res.body.message.id);
    assert.equal(page.body.authors[ana.account.id].name, 'Ana');
    assert.equal(page.body.hasMore, false);
  });

  test('a reply carries a snapshot of what it answers, in the same chat only', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    const bia = await signIn(app, stores.accounts, 'Bia');
    const chat = await defaultChat();
    const send = (who, body) => who.agent.post(`/api/chats/${chat.id}/messages`).send(body);

    const original = (await send(ana, { body: `long ${'x'.repeat(300)}` }).expect(201)).body;
    const reply = (await send(bia, { body: 'sim', replyTo: original.message.id }).expect(201)).body;
    const { replyTo } = reply.message;
    assert.equal(replyTo.id, original.message.id);
    assert.equal(replyTo.authorId, ana.account.id);
    assert.equal(replyTo.authorName, 'Ana');
    assert.equal(replyTo.body.length, 200);
    assert.ok(replyTo.body.endsWith('…'));

    // Not a message, or one that is not in this chat: nothing to answer.
    const refused = await send(bia, { body: 'x', replyTo: 'nope' }).expect(400);
    assert.equal(refused.body.error, 'invalid_reply');
    await send(bia, { body: 'x', replyTo: '6b0f6b0e-0000-1000-8000-000000000000' }).expect(400);
  });

  test('a mention names someone let in, and only as written in the message', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    const bia = await signIn(app, stores.accounts, 'Bia Souza');
    const caio = await signIn(app, stores.accounts, 'Caio');
    const chat = await defaultChat();

    const res = await ana.agent
      .post(`/api/chats/${chat.id}/messages`)
      .send({
        body: 'oi @Bia Souza, tudo bem?',
        // Caio is not in the text; the others are not accounts at all.
        mentions: [bia.account.id, caio.account.id, 'nope', 42, bia.account.id],
      })
      .expect(201);
    assert.deepEqual(res.body.message.mentions, [{ id: bia.account.id, name: 'Bia Souza' }]);
  });

  test('everyone let in can be mentioned, by name and picture, never email', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    await signIn(app, stores.accounts, 'Bia');
    await stores.accounts.signup({ email: 'waiting@example.com', password: PASSWORD });

    const { people } = (await ana.agent.get('/api/chats/people').expect(200)).body;
    assert.deepEqual(
      people.map((p) => p.name),
      ['Ana', 'Bia'],
    );
    assert.deepEqual(Object.keys(people[0]).sort(), ['avatar', 'id', 'name']);
    await request(app).get('/api/chats/people').expect(401);
  });

  test("you delete your own messages; an admin deletes anyone's; nobody else can", async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    const bia = await signIn(app, stores.accounts, 'Bia');
    const boss = await signIn(app, stores.accounts, 'Chefe', { role: 'admin' });
    const chat = await defaultChat();
    const send = async (who, body) =>
      (await who.agent.post(`/api/chats/${chat.id}/messages`).send({ body }).expect(201)).body
        .message;
    const drop = (who, m) => who.agent.delete(`/api/chats/${chat.id}/messages/${m.id}`);

    const mine = await send(ana, 'oi');
    const hers = await send(bia, 'olá');
    await drop(ana, hers).expect(403);
    await drop(ana, mine).expect(200);
    await drop(ana, mine).expect(404);
    await drop(boss, hers).expect(200);
    await request(app).delete(`/api/chats/${chat.id}/messages/${hers.id}`).expect(401);

    const page = await ana.agent.get(`/api/chats/${chat.id}/messages`).expect(200);
    assert.deepEqual(page.body.messages, []);
  });

  test('a reply to a deleted message keeps nothing of what it said', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    const bia = await signIn(app, stores.accounts, 'Bia');
    const chat = await defaultChat();
    const original = (
      await ana.agent.post(`/api/chats/${chat.id}/messages`).send({ body: 'segredo' }).expect(201)
    ).body.message;
    await bia.agent
      .post(`/api/chats/${chat.id}/messages`)
      .send({ body: 'hein?', replyTo: original.id })
      .expect(201);
    await ana.agent.delete(`/api/chats/${chat.id}/messages/${original.id}`).expect(200);

    const [reply] = (await bia.agent.get(`/api/chats/${chat.id}/messages`).expect(200)).body
      .messages;
    assert.deepEqual(reply.replyTo, {
      id: original.id,
      authorId: ana.account.id,
      deleted: true,
    });
  });

  test('anyone reacts to any message, and takes only their own reaction off', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    const bia = await signIn(app, stores.accounts, 'Bia');
    const chat = await defaultChat();
    const message = (
      await ana.agent.post(`/api/chats/${chat.id}/messages`).send({ body: 'oi' }).expect(201)
    ).body.message;
    const path = (emoji) =>
      `/api/chats/${chat.id}/messages/${message.id}/reactions/${encodeURIComponent(emoji)}`;

    await bia.agent.put(path('👍')).expect(200);
    await bia.agent.put(path('👍')).expect(200);
    await ana.agent.put(path('👍')).expect(200);
    await ana.agent.put(path('❤️')).expect(200);
    await ana.agent.delete(path('❤️')).expect(200);
    // Bia's 👍 is hers: Ana taking hers off leaves it.
    await ana.agent.delete(path('👍')).expect(200);
    await request(app).put(path('😂')).expect(401);

    const page = (await ana.agent.get(`/api/chats/${chat.id}/messages`).expect(200)).body;
    assert.deepEqual(page.messages[0].reactions, [{ emoji: '👍', accountIds: [bia.account.id] }]);
    assert.equal(page.authors[bia.account.id].name, 'Bia');
  });

  test('a reaction must be one emoji, to a message that is there', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    const chat = await defaultChat();
    const message = (
      await ana.agent.post(`/api/chats/${chat.id}/messages`).send({ body: 'oi' }).expect(201)
    ).body.message;
    const put = (emoji, id = message.id) =>
      ana.agent.put(`/api/chats/${chat.id}/messages/${id}/reactions/${encodeURIComponent(emoji)}`);

    for (const bad of ['a', 'ok', '👍👍', '<b>', '1', '👍 ']) {
      const res = await put(bad).expect(400);
      assert.equal(res.body.error, 'invalid_reaction');
    }
    await put('👍🏽').expect(200);
    await put('🇧🇷').expect(200);
    await put('👍', TimeUuid.now().toString()).expect(404);
    await ana.agent.delete(`/api/chats/${chat.id}/messages/${message.id}`).expect(200);
    await put('👍').expect(404);
  });

  test('a message takes only so many different emoji', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    const bia = await signIn(app, stores.accounts, 'Bia');
    const chat = await defaultChat();
    const message = (
      await ana.agent.post(`/api/chats/${chat.id}/messages`).send({ body: 'oi' }).expect(201)
    ).body.message;
    const put = (who, emoji) =>
      who.agent.put(
        `/api/chats/${chat.id}/messages/${message.id}/reactions/${encodeURIComponent(emoji)}`,
      );
    // Twenty different animals, from 🐀 on.
    const emoji = Array.from({ length: 20 }, (_, i) => String.fromCodePoint(0x1f400 + i));
    for (const e of emoji) await put(ana, e).expect(200);
    const res = await put(ana, '👍').expect(409);
    assert.equal(res.body.error, 'too_many_reactions');
    // One already there is always open to more people.
    await put(bia, emoji[0]).expect(200);
  });

  test('an empty or oversized message is refused, as is an unknown chat', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    const chat = await defaultChat();
    await ana.agent.post(`/api/chats/${chat.id}/messages`).send({ body: '  ' }).expect(400);
    await ana.agent
      .post(`/api/chats/${chat.id}/messages`)
      .send({ body: 'x'.repeat(4001) })
      .expect(400);
    await ana.agent.post('/api/chats/nope0000/messages').send({ body: 'oi' }).expect(404);
  });

  test('pages say whether there is more, and a bad cursor is refused', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    const chat = await defaultChat();
    for (const body of ['a', 'b', 'c']) {
      await ana.agent.post(`/api/chats/${chat.id}/messages`).send({ body });
    }
    const first = await ana.agent.get(`/api/chats/${chat.id}/messages?limit=2`).expect(200);
    assert.deepEqual(
      first.body.messages.map((m) => m.body),
      ['c', 'b'],
    );
    assert.equal(first.body.hasMore, true);
    const second = await ana.agent
      .get(`/api/chats/${chat.id}/messages?limit=2&before=${first.body.messages[1].id}`)
      .expect(200);
    assert.deepEqual(
      second.body.messages.map((m) => m.body),
      ['a'],
    );
    assert.equal(second.body.hasMore, false);
    await ana.agent.get(`/api/chats/${chat.id}/messages?before=nope`).expect(400);
  });

  test('the unread that @mention you are counted apart, until read', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    const bia = await signIn(app, stores.accounts, 'Bia');
    const chat = await defaultChat();
    const say = (body, mentions = []) =>
      bia.agent.post(`/api/chats/${chat.id}/messages`).send({ body, mentions }).expect(201);
    await say('oi @Ana', [ana.account.id]);
    await say('tudo bem?');
    const { body } = await say('@Ana olha', [ana.account.id]);

    const [mine] = (await ana.agent.get('/api/chats')).body.chats;
    assert.deepEqual([mine.unread, mine.mentions], [3, 2]);
    const [hers] = (await bia.agent.get('/api/chats')).body.chats;
    assert.deepEqual([hers.unread, hers.mentions], [0, 0]);

    await ana.agent.post(`/api/chats/${chat.id}/read`).send({ messageId: body.message.id });
    const [after] = (await ana.agent.get('/api/chats')).body.chats;
    assert.deepEqual([after.unread, after.mentions], [0, 0]);
  });

  test('unread counts what others wrote, until it is marked read', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    const bia = await signIn(app, stores.accounts, 'Bia');
    const chat = await defaultChat();
    await bia.agent.post(`/api/chats/${chat.id}/messages`).send({ body: 'um' });
    const { body } = await bia.agent.post(`/api/chats/${chat.id}/messages`).send({ body: 'dois' });

    assert.equal((await ana.agent.get('/api/chats')).body.chats[0].unread, 2);
    assert.equal((await bia.agent.get('/api/chats')).body.chats[0].unread, 0);
    await ana.agent
      .post(`/api/chats/${chat.id}/read`)
      .send({ messageId: body.message.id })
      .expect(200);
    assert.equal((await ana.agent.get('/api/chats')).body.chats[0].unread, 0);
    await ana.agent.post(`/api/chats/${chat.id}/read`).send({ messageId: 'x' }).expect(400);
  });

  test('sending is rate limited per person', async () => {
    app = buildApp({ sendLimit: { windowMs: 60_000, limit: 2 } });
    const ana = await signIn(app, stores.accounts, 'Ana');
    const bia = await signIn(app, stores.accounts, 'Bia');
    const chat = await defaultChat();
    const send = (who) => who.agent.post(`/api/chats/${chat.id}/messages`).send({ body: 'oi' });
    await send(ana).expect(201);
    await send(ana).expect(201);
    await send(ana).expect(429);
    await send(bia).expect(201);
  });
});

describe('photos and videos', () => {
  const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64, 1),
  ]);
  const upload = (who, chatId, bytes, query = '') =>
    who.agent
      .post(`/api/chats/${chatId}/media${query}`)
      .set('content-type', 'application/octet-stream')
      .send(bytes);

  test('a photo is a message, with its caption, and comes back as it was sent', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    const bia = await signIn(app, stores.accounts, 'Bia');
    const chat = await defaultChat();
    const res = await upload(ana, chat.id, PNG, '?name=praia.png&caption=Olha%20s%C3%B3').expect(
      201,
    );
    const { message } = res.body;
    assert.equal(message.body, 'Olha só');
    assert.equal(message.attachment.type, 'image/png');
    assert.equal(message.attachment.kind, 'image');
    assert.equal(message.attachment.size, PNG.length);
    assert.equal(message.attachment.name, 'praia.png');

    const file = await bia.agent
      .get(`/api/chats/${chat.id}/media/${message.attachment.id}`)
      .buffer(true)
      .parse((r, done) => {
        const parts = [];
        r.on('data', (c) => parts.push(c));
        r.on('end', () => done(null, Buffer.concat(parts)));
      })
      .expect(200);
    assert.equal(file.headers['content-type'], 'image/png');
    assert.equal(file.headers['x-content-type-options'], 'nosniff');
    assert.ok(Buffer.from(file.body).equals(PNG));

    // Deleting the message deletes the file with it.
    await ana.agent.delete(`/api/chats/${chat.id}/messages/${message.id}`).expect(200);
    await bia.agent.get(`/api/chats/${chat.id}/media/${message.attachment.id}`).expect(404);
  });

  test('a video can be fetched in ranges, for scrubbing', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    const chat = await defaultChat();
    const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(100, 2)]);
    const { body } = await upload(ana, chat.id, webm).expect(201);
    const part = await ana.agent
      .get(`/api/chats/${chat.id}/media/${body.message.attachment.id}`)
      .set('Range', 'bytes=0-9')
      .expect(206);
    assert.equal(part.headers['content-type'], 'video/webm');
    assert.equal(part.headers['content-range'], `bytes 0-9/${webm.length}`);
  });

  test('anything but an accepted image or video is refused, whatever it claims', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    const chat = await defaultChat();
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    const res = await upload(ana, chat.id, html, '?name=photo.png').expect(415);
    assert.equal(res.body.error, 'unsupported_media');
    await upload(ana, chat.id, Buffer.alloc(0)).expect(415);
    assert.equal((await ana.agent.get(`/api/chats/${chat.id}/messages`)).body.messages.length, 0);
  });

  test('more than 10 MB is refused as too large', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    const chat = await defaultChat();
    const big = Buffer.concat([PNG, Buffer.alloc(MEDIA_MAX_BYTES)]);
    const res = await upload(ana, chat.id, big).expect(413);
    assert.equal(res.body.error, 'media_too_large');
  });

  test('a file is only found under its own chat, and never by a path', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    await stores.chats.setMax(2);
    const chat = await defaultChat();
    const other = (await stores.chats.add({ name: 'Outro' })).chat;
    const { body } = await upload(ana, chat.id, PNG).expect(201);
    const id = body.message.attachment.id;
    await ana.agent.get(`/api/chats/${other.id}/media/${id}`).expect(404);
    await ana.agent.get(`/api/chats/${chat.id}/media/..%2F..%2Fzoia.db`).expect(404);
    await request(app).get(`/api/chats/${chat.id}/media/${id}`).expect(401);
  });
});

describe('the live stream', () => {
  /** Opens /api/chats/events as `who`, collecting what arrives. */
  async function listen(server, who) {
    const login = await request(app)
      .post('/api/login')
      .send({ email: who.email, password: PASSWORD, deviceName: 'Stream' });
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const { port } = server.address();
    const req = get({ port, path: '/api/chats/events', headers: { Cookie: cookie } });
    const [res] = await once(req, 'response');
    const stream = { res, req, text: '', deviceId: login.body.deviceId, ended: false };
    res.setEncoding('utf8');
    res.on('data', (chunk) => (stream.text += chunk));
    res.on('end', () => (stream.ended = true));
    return stream;
  }

  async function until(check, ms = 2000) {
    const start = Date.now();
    while (!check()) {
      if (Date.now() - start > ms) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  test('pushes messages, read markers and list changes as they happen', async () => {
    const server = app.listen(0);
    try {
      const ana = await signIn(app, stores.accounts, 'Ana');
      const bia = await signIn(app, stores.accounts, 'Bia', { role: 'admin' });
      const stream = await listen(server, ana);
      assert.match(stream.res.headers['content-type'], /^text\/event-stream/);

      const chat = await defaultChat();
      await bia.agent.post(`/api/chats/${chat.id}/messages`).send({ body: 'olá' });
      await until(() => stream.text.includes('event: read'));
      const frame = stream.text.split('\n\n').find((f) => f.startsWith('event: message'));
      const data = JSON.parse(frame.split('\ndata: ')[1]);
      assert.equal(data.message.body, 'olá');
      assert.equal(data.author.name, 'Bia');

      await bia.agent
        .put(
          `/api/chats/${chat.id}/messages/${data.message.id}/reactions/${encodeURIComponent('🎉')}`,
        )
        .expect(200);
      await until(() => stream.text.includes('event: reaction'));
      const reaction = stream.text.split('\n\n').find((f) => f.startsWith('event: reaction'));
      assert.deepEqual(JSON.parse(reaction.split('\ndata: ')[1]), {
        chatId: chat.id,
        messageId: data.message.id,
        emoji: '🎉',
        accountId: bia.account.id,
        on: true,
        reactor: { name: 'Bia', avatar: null },
      });

      await bia.agent.patch(`/api/chats/${chat.id}`).send({ name: 'Papo' });
      await until(() => stream.text.includes('event: chats'));
      stream.req.destroy();
    } finally {
      server.close();
    }
  });

  test('ends when its machine is signed out', async () => {
    app = buildApp({ heartbeatMs: 20 });
    const server = app.listen(0);
    try {
      const ana = await signIn(app, stores.accounts, 'Ana');
      const stream = await listen(server, ana);
      await until(() => stream.text.includes('heartbeat'));
      await stores.devices.revoke(stream.deviceId);
      await until(() => stream.ended);
    } finally {
      server.close();
    }
  });
});

describe('pictures of authors', () => {
  test('an account with no picture has none, and a bad id is not looked up', async () => {
    app = createApp({
      config: {
        sessionSecret: 'test-session-secret-long-enough',
        trustProxy: 1,
        secureCookies: false,
        roomName: 'zoia',
      },
      accountStore: stores.accounts,
      deviceStore: stores.devices,
      avatarStore: { read: async () => null },
      stage: createStage({ rooms: { listParticipants: async () => [] }, roomName: 'zoia' }),
      logger: quiet,
    });
    const ana = await signIn(app, stores.accounts, 'Ana');
    await ana.agent.get(`/api/avatar/account/${ana.account.id}`).expect(404);
    await ana.agent.get('/api/avatar/account/..%2F..%2Fetc').expect(404);
  });
});
