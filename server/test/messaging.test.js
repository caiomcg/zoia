/**
 * Direct messages (ADR 0047), threads (ADR 0048), typing (ADR 0049) and
 * scheduled events (ADR 0050), over real sessions, as chat-routes.test.js
 * does: messages go to the in-memory stand-in for ScyllaDB.
 *
 * Above all, who may see what: a direct chat, its files and its live events
 * are its two members' and nobody else's.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { get } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';

import { createApp } from '../src/app.js';
import { createStage } from '../src/stage.js';
import { PASSWORD, signIn, testStores } from './people.js';
import { createMediaStore } from '../src/chat-media.js';
import { memoryMessages } from './memory-messages.js';
import { createEventStore, nextStart } from '../src/schedule.js';

const quiet = { info() {}, warn() {}, error() {} };

// The smallest PNG: its signature and an IHDR, which is all the type check reads.
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

let dir;
let stores;
let messages;
let app;
let clock;

function buildApp() {
  return createApp({
    config: {
      sessionSecret: 'test-session-secret-long-enough',
      trustProxy: 1,
      secureCookies: false,
      roomName: 'zoia',
      rateLimit: { windowMs: 60_000, limit: 1000 },
      chat: {},
    },
    accountStore: stores.accounts,
    deviceStore: stores.devices,
    chatStore: stores.chats,
    directChatStore: stores.directChats,
    eventStore: stores.events,
    messageStore: () => messages,
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
  dir = await mkdtemp(join(tmpdir(), 'zoia-messaging-'));
  stores = testStores(join(dir, 'zoia.db'));
  // A clock the schedule's tests move by hand.
  clock = Date.now();
  stores.events = createEventStore({ db: stores.db, logger: quiet, now: () => clock });
  messages = memoryMessages();
  app = buildApp();
});

afterEach(async () => {
  await stores.db.idle();
  stores.db.close();
  await rm(dir, { recursive: true, force: true });
});

const defaultChat = async () => (await stores.chats.list())[0];

/** Opens /api/chats/events as `who`, collecting what arrives. */
async function listen(server, who) {
  const login = await request(app)
    .post('/api/login')
    .send({ email: who.email, password: PASSWORD, deviceName: 'Stream' });
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const { port } = server.address();
  const req = get({ port, path: '/api/chats/events', headers: { Cookie: cookie } });
  const [res] = await once(req, 'response');
  const stream = { res, req, text: '' };
  res.setEncoding('utf8');
  res.on('data', (chunk) => (stream.text += chunk));
  return stream;
}

async function until(check, ms = 2000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Every event of `name` a stream has received, as their data. */
const frames = (stream, name) =>
  stream.text
    .split('\n\n')
    .filter((f) => f.startsWith(`event: ${name}\n`))
    .map((f) => JSON.parse(f.split('\ndata: ')[1]));

/** Lets a stream catch up on anything already sent. */
const settle = () => new Promise((r) => setTimeout(r, 50));

describe('direct messages', () => {
  async function open(from, to) {
    const res = await from.agent
      .post('/api/chats/direct')
      .send({ accountId: to.account.id })
      .expect(200);
    return res.body.chat;
  }

  test('two people get one chat between them, whoever opens it', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    const bia = await signIn(app, stores.accounts, 'Bia');
    const first = await open(ana, bia);
    assert.match(first.id, /^dm-[0-9a-f]{16}$/);
    assert.deepEqual(first.peer, { id: bia.account.id, name: 'Bia', avatar: null });
    const back = await open(bia, ana);
    assert.equal(back.id, first.id);
    assert.equal(back.peer.name, 'Ana');
  });

  test('never with yourself, a stranger, someone pending or a bot', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    const refuse = (accountId) =>
      ana.agent.post('/api/chats/direct').send({ accountId }).expect(400);
    await refuse(ana.account.id);
    await refuse('nobody');
    await refuse(42);
    const { account } = await stores.accounts.signup({
      email: 'p@example.com',
      password: PASSWORD,
    });
    await refuse(account.id);
  });

  test('shows in the list to whoever opened it, and to the other once written in', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    const bia = await signIn(app, stores.accounts, 'Bia');
    const dm = await open(ana, bia);
    assert.deepEqual(
      (await ana.agent.get('/api/chats')).body.direct.map((d) => d.id),
      [dm.id],
    );
    assert.deepEqual((await bia.agent.get('/api/chats')).body.direct, []);

    await ana.agent.post(`/api/chats/${dm.id}/messages`).send({ body: 'oi' }).expect(201);
    const [seen] = (await bia.agent.get('/api/chats')).body.direct;
    assert.equal(seen.id, dm.id);
    assert.equal(seen.peer.name, 'Ana');
    assert.equal(seen.unread, 1);
    assert.ok(seen.lastMessageAt);
  });

  test('nobody else can read, write, react, see its files or even find it; admins neither', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    const bia = await signIn(app, stores.accounts, 'Bia');
    const boss = await signIn(app, stores.accounts, 'Caio', { role: 'super_admin' });
    const dm = await open(ana, bia);
    const { message } = (
      await ana.agent.post(`/api/chats/${dm.id}/messages`).send({ body: 'segredo' }).expect(201)
    ).body;
    const photo = (
      await ana.agent
        .post(`/api/chats/${dm.id}/media?name=a.png`)
        .set('Content-Type', 'application/octet-stream')
        .send(PNG)
        .expect(201)
    ).body.message.attachment;

    await bia.agent.get(`/api/chats/${dm.id}/messages`).expect(200);
    await bia.agent.get(`/api/chats/${dm.id}/media/${photo.id}`).expect(200);

    const out = boss.agent;
    await out.get(`/api/chats/${dm.id}/messages`).expect(404);
    await out.post(`/api/chats/${dm.id}/messages`).send({ body: 'x' }).expect(404);
    await out.delete(`/api/chats/${dm.id}/messages/${message.id}`).expect(404);
    await out.patch(`/api/chats/${dm.id}/messages/${message.id}`).send({ body: 'x' }).expect(404);
    await out
      .put(`/api/chats/${dm.id}/messages/${message.id}/reactions/${encodeURIComponent('👍')}`)
      .expect(404);
    await out.get(`/api/chats/${dm.id}/media/${photo.id}`).expect(404);
    await out.post(`/api/chats/${dm.id}/read`).send({ messageId: message.id }).expect(404);
    await out.post(`/api/chats/${dm.id}/typing`).expect(404);
    await out.get(`/api/chats/${dm.id}~${message.id}/messages`).expect(404);
    // An admin's chat routes do not reach it either.
    await out.patch(`/api/chats/${dm.id}`).send({ name: 'x' }).expect(404);
    await out.delete(`/api/chats/${dm.id}`).expect(404);
    assert.deepEqual((await out.get('/api/chats')).body.direct, []);
  });

  test('its live events go to its two members and nobody else', async () => {
    const server = app.listen(0);
    try {
      const ana = await signIn(app, stores.accounts, 'Ana');
      const bia = await signIn(app, stores.accounts, 'Bia');
      const caio = await signIn(app, stores.accounts, 'Caio', { role: 'admin' });
      const toBia = await listen(server, bia);
      const toCaio = await listen(server, caio);
      const dm = await open(ana, bia);
      const { message } = (
        await ana.agent.post(`/api/chats/${dm.id}/messages`).send({ body: 'segredo' })
      ).body;
      await ana.agent.post(`/api/chats/${dm.id}/typing`).expect(204);
      await ana.agent
        .put(`/api/chats/${dm.id}/messages/${message.id}/reactions/${encodeURIComponent('👍')}`)
        .expect(200);
      await until(() => toBia.text.includes('event: reaction'));
      // Something everyone hears, to know Caio's stream has caught up.
      const chat = await defaultChat();
      await ana.agent.post(`/api/chats/${chat.id}/messages`).send({ body: 'oi' });
      await until(() => frames(toCaio, 'message').length > 0);

      assert.equal(frames(toBia, 'message')[0].message.body, 'segredo');
      assert.equal(frames(toBia, 'typing')[0].chatId, dm.id);
      assert.ok(!toCaio.text.includes('segredo'));
      assert.ok(!toCaio.text.includes(dm.id));
      toBia.req.destroy();
      toCaio.req.destroy();
    } finally {
      server.close();
    }
  });

  test('only its two members can be @mentioned in it', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    const bia = await signIn(app, stores.accounts, 'Bia');
    const caio = await signIn(app, stores.accounts, 'Caio');
    const dm = await open(ana, bia);
    const { message } = (
      await ana.agent
        .post(`/api/chats/${dm.id}/messages`)
        .send({ body: '@Bia e @Caio', mentions: [bia.account.id, caio.account.id] })
        .expect(201)
    ).body;
    assert.deepEqual(
      message.mentions.map((m) => m.name),
      ['Bia'],
    );
  });
});

describe('threads', () => {
  async function rootMessage(who, body = 'pergunta') {
    const chat = await defaultChat();
    const { message } = (
      await who.agent.post(`/api/chats/${chat.id}/messages`).send({ body }).expect(201)
    ).body;
    return { chat, message, threadId: `${chat.id}~${message.id}` };
  }

  test('replies go to the thread, not the chat, and the message shows how many', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    const bia = await signIn(app, stores.accounts, 'Bia');
    const { chat, message, threadId } = await rootMessage(ana);

    await bia.agent.post(`/api/chats/${threadId}/messages`).send({ body: 'resposta' }).expect(201);
    await ana.agent.post(`/api/chats/${threadId}/messages`).send({ body: 'valeu' }).expect(201);

    const page = (await ana.agent.get(`/api/chats/${chat.id}/messages`)).body;
    assert.deepEqual(
      page.messages.map((m) => m.body),
      ['pergunta'],
    );
    assert.equal(page.messages[0].thread.count, 2);
    assert.deepEqual(page.messages[0].thread.participants, [ana.account.id, bia.account.id]);
    assert.equal(page.authors[bia.account.id].name, 'Bia');

    const thread = (await bia.agent.get(`/api/chats/${threadId}/messages`)).body;
    assert.deepEqual(
      thread.messages.map((m) => m.body),
      ['valeu', 'resposta'],
    );
    assert.equal(thread.root.id, message.id);
    assert.equal(thread.root.body, 'pergunta');
    assert.equal(thread.messages[0].thread, undefined);
  });

  test('a thread on a message that is not there, or a thread of a thread, is not found', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    const chat = await defaultChat();
    const { threadId } = await rootMessage(ana);
    const reply = (
      await ana.agent.post(`/api/chats/${threadId}/messages`).send({ body: 'r' }).expect(201)
    ).body.message;
    await ana.agent
      .get(`/api/chats/${chat.id}~00000000-0000-1000-8000-000000000000/messages`)
      .expect(404);
    await ana.agent.get(`/api/chats/${chat.id}~nope/messages`).expect(404);
    await ana.agent.get(`/api/chats/${threadId}~${reply.id}/messages`).expect(404);
    await ana.agent.get(`/api/chats/ffffffff~${reply.id}/messages`).expect(404);
  });

  test('a reply is counted on the stream for the chat, and a thread in a direct chat stays in it', async () => {
    const server = app.listen(0);
    try {
      const ana = await signIn(app, stores.accounts, 'Ana');
      const bia = await signIn(app, stores.accounts, 'Bia');
      const caio = await signIn(app, stores.accounts, 'Caio');
      const toCaio = await listen(server, caio);
      const { chat, message, threadId } = await rootMessage(ana);
      await bia.agent.post(`/api/chats/${threadId}/messages`).send({ body: 'r' }).expect(201);
      await until(() => frames(toCaio, 'thread').length > 0);
      const [event] = frames(toCaio, 'thread');
      assert.equal(event.chatId, chat.id);
      assert.equal(event.rootId, message.id);
      assert.equal(event.thread.count, 1);

      const dm = (
        await ana.agent.post('/api/chats/direct').send({ accountId: bia.account.id }).expect(200)
      ).body.chat;
      const root = (await ana.agent.post(`/api/chats/${dm.id}/messages`).send({ body: 'privado' }))
        .body.message;
      const privateThread = `${dm.id}~${root.id}`;
      await bia.agent
        .post(`/api/chats/${privateThread}/messages`)
        .send({ body: 'só nós' })
        .expect(201);
      await caio.agent.get(`/api/chats/${privateThread}/messages`).expect(404);
      await settle();
      assert.ok(!toCaio.text.includes('só nós'));
      assert.ok(!toCaio.text.includes(dm.id));
      toCaio.req.destroy();
    } finally {
      server.close();
    }
  });

  test('deleting the message takes its thread with it; deleting a reply recounts', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    const { chat, message, threadId } = await rootMessage(ana);
    const reply = (await ana.agent.post(`/api/chats/${threadId}/messages`).send({ body: 'r1' }))
      .body.message;
    await ana.agent.post(`/api/chats/${threadId}/messages`).send({ body: 'r2' }).expect(201);
    await ana.agent.delete(`/api/chats/${threadId}/messages/${reply.id}`).expect(200);
    const page = (await ana.agent.get(`/api/chats/${chat.id}/messages`)).body;
    assert.equal(page.messages[0].thread.count, 1);

    await ana.agent.delete(`/api/chats/${chat.id}/messages/${message.id}`).expect(200);
    await until(() => messages.removedThreads.length > 0);
    assert.deepEqual(messages.removedThreads, [threadId]);
  });

  test('a photo in a thread is kept with its chat and served through the thread', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    const { chat, threadId } = await rootMessage(ana);
    const sent = (
      await ana.agent
        .post(`/api/chats/${threadId}/media?name=a.png`)
        .set('Content-Type', 'application/octet-stream')
        .send(PNG)
        .expect(201)
    ).body.message;
    assert.equal(sent.chatId, threadId);
    await ana.agent.get(`/api/chats/${threadId}/media/${sent.attachment.id}`).expect(200);
    await ana.agent.get(`/api/chats/${chat.id}/media/${sent.attachment.id}`).expect(200);
  });
});

describe('typing', () => {
  test('is told to everyone in a chat, by name, and stored nowhere', async () => {
    const server = app.listen(0);
    try {
      const ana = await signIn(app, stores.accounts, 'Ana');
      const bia = await signIn(app, stores.accounts, 'Bia');
      const toBia = await listen(server, bia);
      const chat = await defaultChat();
      await ana.agent.post(`/api/chats/${chat.id}/typing`).expect(204);
      await until(() => frames(toBia, 'typing').length > 0);
      assert.deepEqual(frames(toBia, 'typing')[0], {
        chatId: chat.id,
        accountId: ana.account.id,
        name: 'Ana',
      });
      await ana.agent.post('/api/chats/ffffffff/typing').expect(404);
      await request(app).post(`/api/chats/${chat.id}/typing`).expect(401);
      toBia.req.destroy();
    } finally {
      server.close();
    }
  });
});

describe('scheduled events', () => {
  const inHours = (h) => new Date(clock + h * 3_600_000).toISOString();

  test('anyone schedules one, and is going to it', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    const { event } = (
      await ana.agent
        .post('/api/schedule')
        .send({ title: '  Ranked   night ', startsAt: inHours(2), channelId: 'zoia' })
        .expect(201)
    ).body;
    assert.equal(event.title, 'Ranked night');
    assert.equal(event.channelId, 'zoia');
    assert.equal(event.creatorName, 'Ana');
    assert.deepEqual(event.rsvps, { [ana.account.id]: 'going' });
    const list = (await ana.agent.get('/api/schedule')).body.events;
    assert.deepEqual(
      list.map((e) => e.id),
      [event.id],
    );
  });

  test('refuses a bad title, time, channel or answer', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    const post = (body) => ana.agent.post('/api/schedule').send(body);
    assert.equal((await post({ title: '', startsAt: inHours(1) })).body.error, 'invalid_title');
    assert.equal(
      (await post({ title: 'x'.repeat(101), startsAt: inHours(1) })).body.error,
      'invalid_title',
    );
    assert.equal((await post({ title: 'x', startsAt: 'soon' })).body.error, 'invalid_time');
    assert.equal((await post({ title: 'x', startsAt: inHours(-1) })).body.error, 'invalid_time');
    assert.equal(
      (await post({ title: 'x', startsAt: inHours(24 * 400) })).body.error,
      'invalid_time',
    );
    assert.equal(
      (await post({ title: 'x', startsAt: inHours(1), channelId: 'nope' })).body.error,
      'invalid_channel',
    );
    const { event } = (await post({ title: 'x', startsAt: inHours(1) }).expect(201)).body;
    const answer = await ana.agent
      .put(`/api/schedule/${event.id}/rsvp`)
      .send({ answer: 'perhaps' })
      .expect(400);
    assert.equal(answer.body.error, 'invalid_answer');
  });

  test('only its creator and admins change or cancel it; anyone answers', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    const bia = await signIn(app, stores.accounts, 'Bia');
    const boss = await signIn(app, stores.accounts, 'Caio', { role: 'admin' });
    const { event } = (
      await ana.agent.post('/api/schedule').send({ title: 'Jogo', startsAt: inHours(3) })
    ).body;

    await bia.agent.patch(`/api/schedule/${event.id}`).send({ title: 'Meu' }).expect(403);
    await bia.agent.delete(`/api/schedule/${event.id}`).expect(403);
    const answered = (
      await bia.agent.put(`/api/schedule/${event.id}/rsvp`).send({ answer: 'maybe' }).expect(200)
    ).body.event;
    assert.equal(answered.rsvps[bia.account.id], 'maybe');
    const back = (
      await bia.agent.put(`/api/schedule/${event.id}/rsvp`).send({ answer: null }).expect(200)
    ).body.event;
    assert.equal(back.rsvps[bia.account.id], undefined);

    const renamed = (
      await ana.agent.patch(`/api/schedule/${event.id}`).send({ title: 'Jogão' }).expect(200)
    ).body.event;
    assert.equal(renamed.title, 'Jogão');
    await boss.agent.delete(`/api/schedule/${event.id}`).expect(200);
    assert.deepEqual((await ana.agent.get('/api/schedule')).body.events, []);
  });

  test('announces a start once, to whoever is going or might, and forgets old events', async () => {
    const server = app.listen(0);
    try {
      const ana = await signIn(app, stores.accounts, 'Ana');
      const bia = await signIn(app, stores.accounts, 'Bia');
      const caio = await signIn(app, stores.accounts, 'Caio');
      const toBia = await listen(server, bia);
      const toCaio = await listen(server, caio);
      const { event } = (
        await ana.agent.post('/api/schedule').send({ title: 'Jogo', startsAt: inHours(1) })
      ).body;
      await bia.agent.put(`/api/schedule/${event.id}/rsvp`).send({ answer: 'maybe' });
      await caio.agent.put(`/api/schedule/${event.id}/rsvp`).send({ answer: 'no' });

      assert.deepEqual(await app.locals.scheduleSweep(), []);
      clock += 61 * 60_000;
      const started = await app.locals.scheduleSweep();
      assert.deepEqual(
        started.map((e) => e.id),
        [event.id],
      );
      assert.deepEqual(await app.locals.scheduleSweep(), []);

      await until(() => frames(toBia, 'event_starting').length > 0);
      assert.equal(frames(toBia, 'event_starting')[0].event.title, 'Jogo');
      await settle();
      assert.equal(frames(toCaio, 'event_starting').length, 0);

      // Still on the list a while after it started; gone a week later.
      assert.equal((await ana.agent.get('/api/schedule')).body.events.length, 1);
      clock += 8 * 24 * 3_600_000;
      await app.locals.scheduleSweep();
      assert.equal(await stores.events.find(event.id), null);
      toBia.req.destroy();
      toCaio.req.destroy();
    } finally {
      server.close();
    }
  });

  test('a new start time is announced again when it comes', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    const { event } = (
      await ana.agent.post('/api/schedule').send({ title: 'Jogo', startsAt: inHours(0.5) })
    ).body;
    clock += 31 * 60_000;
    assert.equal((await app.locals.scheduleSweep()).length, 1);
    await ana.agent
      .patch(`/api/schedule/${event.id}`)
      .send({ startsAt: new Date(clock + 3_600_000).toISOString() })
      .expect(200);
    clock += 61 * 60_000;
    assert.equal((await app.locals.scheduleSweep()).length, 1);
  });

  test('a start missed while the server was down is not announced late', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    await ana.agent.post('/api/schedule').send({ title: 'Jogo', startsAt: inHours(1) });
    clock += 2 * 3_600_000;
    assert.deepEqual(await app.locals.scheduleSweep(), []);
  });

  test('lasts two hours unless told, from five minutes to two weeks, and leaves the list as it ends', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    const plain = (
      await ana.agent.post('/api/schedule').send({ title: 'Jogo', startsAt: inHours(1) })
    ).body.event;
    assert.equal(plain.durationMinutes, 120);
    const post = (durationMinutes) =>
      ana.agent.post('/api/schedule').send({ title: 'x', startsAt: inHours(1), durationMinutes });
    assert.equal((await post(4)).body.error, 'invalid_duration');
    assert.equal((await post(14 * 24 * 60 + 1)).body.error, 'invalid_duration');
    assert.equal((await post(1.5)).body.error, 'invalid_duration');
    const lan = (
      await ana.agent
        .post('/api/schedule')
        .send({ title: 'LAN', startsAt: inHours(1), durationMinutes: 3 * 24 * 60 })
        .expect(201)
    ).body.event;
    assert.equal(lan.durationMinutes, 3 * 24 * 60);

    // Four hours on, the plain one has ended; the LAN party goes on for days.
    clock += 4 * 3_600_000;
    const ids = (await ana.agent.get('/api/schedule')).body.events.map((e) => e.id);
    assert.deepEqual(ids, [lan.id]);
    await ana.agent.patch(`/api/schedule/${lan.id}`).send({ durationMinutes: 30 }).expect(200);
    assert.deepEqual((await ana.agent.get('/api/schedule')).body.events, []);
  });

  test('an event under way can still be changed, its start left as it was', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    const { event } = (
      await ana.agent.post('/api/schedule').send({ title: 'Jogo', startsAt: inHours(0.5) })
    ).body;
    clock += 60 * 60_000;
    const changed = (
      await ana.agent
        .patch(`/api/schedule/${event.id}`)
        .send({ title: 'Jogão', startsAt: event.startsAt, durationMinutes: 240 })
        .expect(200)
    ).body.event;
    assert.equal(changed.title, 'Jogão');
    assert.equal(changed.durationMinutes, 240);
    // Moving it into the past is still refused.
    const moved = await ana.agent
      .patch(`/api/schedule/${event.id}`)
      .send({ startsAt: inHours(-2) })
      .expect(400);
    assert.equal(moved.body.error, 'invalid_time');
  });

  test('a weekly event moves on a week when it ends, its answers starting over', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    const bia = await signIn(app, stores.accounts, 'Bia');
    const { event } = (
      await ana.agent
        .post('/api/schedule')
        .send({ title: 'Ranked', startsAt: inHours(1), recurrence: 'weekly' })
        .expect(201)
    ).body;
    assert.equal(event.recurrence, 'weekly');
    await bia.agent.put(`/api/schedule/${event.id}/rsvp`).send({ answer: 'going' });
    const bad = await ana.agent
      .post('/api/schedule')
      .send({ title: 'x', startsAt: inHours(1), recurrence: 'yearly' })
      .expect(400);
    assert.equal(bad.body.error, 'invalid_recurrence');

    clock += 4 * 3_600_000;
    await app.locals.scheduleSweep();
    const [next] = (await ana.agent.get('/api/schedule')).body.events;
    assert.equal(next.id, event.id);
    assert.equal(Date.parse(next.startsAt) - Date.parse(event.startsAt), 7 * 24 * 3_600_000);
    assert.deepEqual(next.rsvps, { [ana.account.id]: 'going' });
  });

  test('needs a session', async () => {
    await request(app).get('/api/schedule').expect(401);
    await request(app)
      .post('/api/schedule')
      .send({ title: 'x', startsAt: inHours(1) })
      .expect(401);
  });
});

describe('repeating', () => {
  test('a day, a week, or the same day next month, the last day when shorter', () => {
    assert.equal(nextStart('2026-11-05T21:00:00.000Z', 'daily'), '2026-11-06T21:00:00.000Z');
    assert.equal(nextStart('2026-11-05T21:00:00.000Z', 'weekly'), '2026-11-12T21:00:00.000Z');
    assert.equal(nextStart('2026-11-05T21:00:00.000Z', 'monthly'), '2026-12-05T21:00:00.000Z');
    assert.equal(nextStart('2026-01-31T21:00:00.000Z', 'monthly'), '2026-02-28T21:00:00.000Z');
    assert.equal(nextStart('2026-12-15T10:00:00.000Z', 'monthly'), '2027-01-15T10:00:00.000Z');
  });
});
