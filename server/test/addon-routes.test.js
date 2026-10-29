/**
 * The addon API (ADR 0041), over a real database and a real app. What matters
 * most is what an addon cannot do: anything without its permission, anything
 * once disabled, anything to an admin, and seeing an email.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { get } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { TrackSource } from 'livekit-server-sdk';

import { createApp } from '../src/app.js';
import { createStage } from '../src/stage.js';
import { createTokenIssuer, decodeTokenPayload } from '../src/token.js';
import { validateManifest, PERMISSIONS } from '../src/addons.js';
import { signIn, testStores } from './people.js';
import { memoryMessages } from './memory-messages.js';

const quiet = { info() {}, warn() {}, error() {} };
const DIGEST = 'b'.repeat(64);

let dir;
let stores;
let messages;
let rooms;
let app;

function buildApp() {
  rooms = {
    participants: [],
    sent: [],
    listParticipants: async () => rooms.participants,
    updateParticipant: async () => {},
    removeParticipant: async (_room, identity) => {
      rooms.participants = rooms.participants.filter((p) => p.identity !== identity);
    },
    sendData: async (...args) => rooms.sent.push(args),
  };
  return createApp({
    config: {
      sessionSecret: 'test-session-secret-long-enough',
      trustProxy: 1,
      secureCookies: false,
      roomName: 'zoia',
      serverName: 'Casa',
      rateLimit: { windowMs: 60_000, limit: 1000 },
      addons: { heartbeatMs: 50, limit: { windowMs: 60_000, limit: 1000 } },
    },
    accountStore: stores.accounts,
    deviceStore: stores.devices,
    chatStore: stores.chats,
    addonStore: stores.addons,
    messageStore: () => messages,
    stage: createStage({ rooms, roomName: 'zoia', logger: quiet }),
    tokenIssuer: createTokenIssuer({
      apiKey: 'devkey',
      apiSecret: 'a-secret-long-enough-for-hmac-signing',
      wsUrl: 'wss://sfu.example.com',
      roomName: 'zoia',
      roomService: { createRoom: async () => {} },
      logger: quiet,
    }),
    logger: quiet,
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zoia-addon-routes-'));
  stores = testStores(join(dir, 'zoia.db'));
  await stores.chats.ready;
  messages = memoryMessages();
  app = buildApp();
});

afterEach(async () => {
  await stores.db.idle();
  stores.db.close();
  await rm(dir, { recursive: true, force: true });
});

/**
 * An enabled addon granted `permissions`, bound to the default chat, with a
 * `play` command. Returns the addon and a request with its token.
 */
async function addon(permissions = Object.keys(PERMISSIONS), { enabled = true } = {}) {
  const { manifest } = validateManifest({
    id: 'tester',
    name: 'Tester',
    version: '1.0.0',
    image: `ghcr.io/someone/tester@sha256:${DIGEST}`,
    permissions,
    commands: permissions.includes('commands') ? [{ name: 'play', description: 'Plays' }] : [],
    settings: [{ key: 'key', type: 'secret', label: 'Key' }],
  });
  const { addon: installed, token } = await stores.addons.install({
    repo: 'someone/tester',
    manifest,
    by: 'test',
  });
  await stores.addons.setEnabled(installed.id, enabled);
  const chat = (await stores.chats.list())[0];
  await stores.addons.setBindings(installed.id, [chat.id]);
  const as = (method, path) =>
    request(app)[method](`/api/addon/v1${path}`).set('Authorization', `Bearer ${token}`);
  return { addon: installed, token, chat, as };
}

describe('who an addon is', () => {
  test('no token, a wrong one, or one of a disabled addon is refused', async () => {
    const { as, addon: a, token } = await addon();
    await request(app).get('/api/addon/v1/me').expect(401);
    await request(app)
      .get('/api/addon/v1/me')
      .set('Authorization', `Bearer ${token.slice(0, -1)}x`)
      .expect(401);
    await as('get', '/me').expect(200);
    await stores.addons.setEnabled(a.id, false);
    const res = await as('get', '/me').expect(403);
    assert.equal(res.body.error, 'addon_disabled');
  });

  test('uninstalled, its token is nothing at once', async () => {
    const { as, addon: a } = await addon();
    await stores.addons.remove(a.id);
    await as('get', '/me').expect(401);
  });

  test('it reads its own settings, secrets included, and its commands', async () => {
    const { as, addon: a } = await addon();
    await stores.addons.setSettings(a.id, { key: 's3cret' });
    await stores.addons.setCommandNames(a.id, { play: 'p' });
    const { body } = await as('get', '/me').expect(200);
    assert.equal(body.settings.key, 's3cret');
    assert.deepEqual(body.commands, { play: 'p' });
    assert.equal(body.chats.length, 1);
  });
});

describe('permissions', () => {
  test('every route is refused without its permission', async () => {
    const { as } = await addon([]);
    const chat = (await stores.chats.list())[0];
    for (const [method, path, permission] of [
      ['get', '/server', 'server.read'],
      ['get', '/channels', 'channels.read'],
      ['get', '/users', 'users.read'],
      ['post', '/users/x/disable', 'users.manage'],
      ['post', '/users/x/enable', 'users.manage'],
      ['post', '/users/x/move', 'users.manage'],
      ['post', '/bots', 'bots.create'],
      ['post', `/chats/${chat.id}/messages`, 'chat.write'],
      ['post', '/voice/token', 'voice.publish'],
    ]) {
      const res = await as(method, path).send({});
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.equal(res.body.permission, permission, `${method} ${path}`);
    }
  });

  test('a camera needs video.publish besides voice', async () => {
    const { as } = await addon(['bots.create', 'voice.publish']);
    const { body } = await as('post', '/bots').send({ name: 'Cam' }).expect(201);
    const res = await as('post', '/voice/token')
      .send({ bot: body.bot.id, channel: 'zoia', video: true })
      .expect(403);
    assert.equal(res.body.permission, 'video.publish');
  });
});

describe('people', () => {
  test('are listed without their email', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    const { as } = await addon();
    const { body } = await as('get', '/users').expect(200);
    const person = body.users.find((u) => u.id === ana.account.id);
    assert.equal(person.name, 'Ana');
    assert.equal(JSON.stringify(body).includes('@'), false, 'no email anywhere');
  });

  test('an addon may disable a user, never an admin, and never another addon’s bot', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    const bia = await signIn(app, stores.accounts, 'Bia', { role: 'admin' });
    const su = await signIn(app, stores.accounts, 'Su', { role: 'super_admin' });
    const { as } = await addon();

    await as('post', `/users/${bia.account.id}/disable`).expect(403);
    await as('post', `/users/${su.account.id}/disable`).expect(403);
    const { body } = await as('post', `/users/${ana.account.id}/disable`).expect(200);
    assert.equal(body.user.status, 'disabled');
    await ana.agent.get('/api/session').expect(401);

    const other = await stores.addons.install({
      repo: 'someone/other',
      manifest: validateManifest({
        id: 'other',
        name: 'Other',
        version: '1.0.0',
        image: `ghcr.io/someone/other@sha256:${DIGEST}`,
      }).manifest,
    });
    const { account: foreign } = await stores.accounts.createBot({
      addonId: other.addon.id,
      name: 'Foreign',
    });
    await as('post', `/users/${foreign.id}/disable`).expect(403);
  });
});

describe('bots', () => {
  test('are created as users, and a bot of another addon cannot be used', async () => {
    const { as } = await addon();
    const { body } = await as('post', '/bots').send({ name: 'Zouve' }).expect(201);
    assert.equal(body.bot.role, 'user');
    assert.equal(body.bot.bot, true);
    const listed = await as('get', '/bots').expect(200);
    assert.deepEqual(
      listed.body.bots.map((b) => b.id),
      [body.bot.id],
    );
    // Bots never show among the people an admin manages.
    const su = await signIn(app, stores.accounts, 'Su', { role: 'super_admin' });
    const accounts = await su.agent.get('/api/admin/accounts').expect(200);
    assert.equal(
      accounts.body.accounts.some((a) => a.id === body.bot.id),
      false,
    );
  });

  test('voice is the microphone alone, in the bot’s own name, already in voice', async () => {
    const { as } = await addon();
    const { body } = await as('post', '/bots').send({ name: 'Zouve' }).expect(201);
    const res = await as('post', '/voice/token')
      .send({ bot: body.bot.id, channel: 'zoia' })
      .expect(200);
    assert.equal(res.body.identity, `bot-${body.bot.id}`);
    const payload = decodeTokenPayload(res.body.token);
    assert.equal(payload.video.canPublish, true);
    assert.deepEqual(payload.video.canPublishSources, [TrackSource.MICROPHONE].map(sourceName));
    assert.equal(payload.video.canSubscribe, false);
    assert.equal(payload.video.roomAdmin, false);
    assert.equal(payload.attributes['zoia.voice'], '1');
    assert.equal(payload.attributes['zoia.bot'], 'Tester');
  });

  test('an admin takes a bot out of its channel from the member menu; a user cannot', async () => {
    const { as } = await addon();
    const { body } = await as('post', '/bots').send({ name: 'Zouve' }).expect(201);
    const identity = `bot-${body.bot.id}`;
    rooms.participants = [
      { identity, name: 'Zouve', attributes: { 'zoia.voice': '1' }, tracks: [] },
    ];
    const ana = await signIn(app, stores.accounts, 'Ana');
    await ana.agent.post(`/api/admin/devices/${identity}/disconnect`).expect(403);
    const bia = await signIn(app, stores.accounts, 'Bia', { role: 'admin' });
    const res = await bia.agent.post(`/api/admin/devices/${identity}/kick`).expect(200);
    assert.equal(res.body.kicked, true);
    assert.deepEqual(rooms.participants, []);
    await bia.agent.post(`/api/admin/devices/${identity}/disconnect`).expect(409);
    await bia.agent.post('/api/admin/devices/bot-deadbeef/kick').expect(404);
  });

  test('a channel that does not exist gets no token', async () => {
    const { as } = await addon();
    const { body } = await as('post', '/bots').send({ name: 'Zouve' }).expect(201);
    await as('post', '/voice/token').send({ bot: body.bot.id, channel: 'nope' }).expect(404);
    await as('post', '/voice/token').send({ bot: 'someone', channel: 'zoia' }).expect(404);
  });
});

/** How a source is written in a token: the protobuf enum's name, lowercase. */
function sourceName(source) {
  return { [TrackSource.MICROPHONE]: 'microphone', [TrackSource.CAMERA]: 'camera' }[source];
}

describe('chats', () => {
  test('a bot writes in a bound chat, and in no other', async () => {
    const { as, chat, addon: a } = await addon();
    const { body } = await as('post', '/bots').send({ name: 'Zouve' }).expect(201);
    const sent = await as('post', `/chats/${chat.id}/messages`)
      .send({ bot: body.bot.id, body: 'tocando agora' })
      .expect(201);
    assert.equal(sent.body.message.authorId, body.bot.id);
    // People reading the chat are told it is a bot's.
    const ana = await signIn(app, stores.accounts, 'Ana');
    const page = await ana.agent.get(`/api/chats/${chat.id}/messages`).expect(200);
    assert.equal(page.body.authors[body.bot.id].bot, true);
    await stores.addons.setBindings(a.id, []);
    const refused = await as('post', `/chats/${chat.id}/messages`)
      .send({ bot: body.bot.id, body: 'oi' })
      .expect(403);
    assert.equal(refused.body.error, 'not_bound');
  });

  test('it deletes its bots’ messages and the commands typed to it, and nothing else', async () => {
    const { as, chat, addon: a } = await addon();
    await stores.addons.setCommandNames(a.id, { play: 'p' });
    const { body } = await as('post', '/bots').send({ name: 'Zouve' }).expect(201);
    const reply = await as('post', `/chats/${chat.id}/messages`)
      .send({ bot: body.bot.id, body: 'Now playing' })
      .expect(201);
    const ana = await signIn(app, stores.accounts, 'Ana');
    const send = async (text) =>
      (await ana.agent.post(`/api/chats/${chat.id}/messages`).send({ body: text })).body.message.id;
    const command = await send('!p lofi');
    const oldName = await send('!play lofi');
    const chatter = await send('nice song');

    await as('delete', `/chats/${chat.id}/messages/${reply.body.message.id}`).expect(200);
    await as('delete', `/chats/${chat.id}/messages/${command}`).expect(200);
    // Not a command as it is typed here, and not a command at all: someone's words.
    await as('delete', `/chats/${chat.id}/messages/${oldName}`).expect(403);
    await as('delete', `/chats/${chat.id}/messages/${chatter}`).expect(403);
    const left = (await messages.page({ chatId: chat.id, limit: 10 })).map((m) => m.body);
    assert.deepEqual(left.sort(), ['!play lofi', 'nice song']);
  });

  test('it edits its bots’ messages, and never anyone else’s', async () => {
    const { as, chat, addon: a } = await addon();
    const { body } = await as('post', '/bots').send({ name: 'Zouve' }).expect(201);
    const own = (
      await as('post', `/chats/${chat.id}/messages`)
        .send({ bot: body.bot.id, body: 'Now playing: a' })
        .expect(201)
    ).body.message;
    const ana = await signIn(app, stores.accounts, 'Ana');
    const hers = (await ana.agent.post(`/api/chats/${chat.id}/messages`).send({ body: '!play a' }))
      .body.message;
    const edit = (id, text) => as('patch', `/chats/${chat.id}/messages/${id}`).send({ body: text });

    const res = await edit(own.id, 'Now playing: b').expect(200);
    assert.equal(res.body.message.body, 'Now playing: b');
    assert.ok(res.body.message.editedAt);
    await edit(own.id, '').expect(400);
    // A person's words, even a command typed to it, are theirs.
    assert.equal((await edit(hers.id, 'x').expect(403)).body.error, 'forbidden');
    assert.equal((await messages.get({ chatId: chat.id, id: hers.id })).body, '!play a');
    // And a bot cannot be edited as a person would.
    await ana.agent
      .patch(`/api/chats/${chat.id}/messages/${own.id}`)
      .send({ body: 'hacked' })
      .expect(403);

    await stores.addons.setBindings(a.id, []);
    assert.equal((await edit(own.id, 'c').expect(403)).body.error, 'not_bound');
  });

  test('editing needs chat.write', async () => {
    const { as, chat } = await addon(['commands', 'bots.create']);
    const res = await as('patch', `/chats/${chat.id}/messages/whatever`)
      .send({ body: 'x' })
      .expect(403);
    assert.equal(res.body.permission, 'chat.write');
  });

  test('deleting commands needs commands.delete, and a chat it is bound to', async () => {
    const { as, chat, addon: a } = await addon(['commands', 'chat.write', 'bots.create']);
    const ana = await signIn(app, stores.accounts, 'Ana');
    const { body } = await ana.agent
      .post(`/api/chats/${chat.id}/messages`)
      .send({ body: '!play lofi' });
    const res = await as('delete', `/chats/${chat.id}/messages/${body.message.id}`).expect(403);
    assert.equal(res.body.permission, 'commands.delete');
    await stores.addons.setBindings(a.id, []);
    const unbound = await as('delete', `/chats/${chat.id}/messages/${body.message.id}`);
    assert.equal(unbound.body.error, 'not_bound');
  });

  test('people see which commands they may type, under this server’s names', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    const { addon: a, chat } = await addon();
    await stores.addons.setCommandNames(a.id, { play: 'p' });
    const { body } = await ana.agent.get(`/api/chats/${chat.id}/commands`).expect(200);
    assert.deepEqual(body.commands, [{ name: 'p', description: 'Plays', addon: 'Tester' }]);
  });
});

describe('events', () => {
  async function listen(server, token) {
    const { port } = server.address();
    const req = get({
      port,
      path: '/api/addon/v1/events',
      headers: { Authorization: `Bearer ${token}` },
    });
    const [res] = await once(req, 'response');
    const stream = { res, text: '', ended: false };
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

  const frames = (stream, event) =>
    stream.text
      .split('\n\n')
      .filter((f) => f.startsWith(`event: ${event}`))
      .map((f) => JSON.parse(f.split('\ndata: ')[1]));

  test('a command reaches its addon with where the person is in voice', async () => {
    const server = app.listen(0);
    try {
      const { token, chat, addon: a } = await addon();
      await stores.addons.setCommandNames(a.id, { play: 'p' });
      const ana = await signIn(app, stores.accounts, 'Ana');
      rooms.participants = [
        { identity: ana.record.id, name: 'Ana', attributes: { 'zoia.voice': '1' }, tracks: [] },
      ];
      const stream = await listen(server, token);
      await ana.agent.post(`/api/chats/${chat.id}/messages`).send({ body: '!p lofi beats' });
      await ana.agent.post(`/api/chats/${chat.id}/messages`).send({ body: '!play nothing' });
      await until(
        () => frames(stream, 'command').length > 0 && frames(stream, 'message').length > 1,
      );
      const [command] = frames(stream, 'command');
      assert.equal(command.command, 'play');
      assert.equal(command.args, 'lofi beats');
      assert.equal(command.author.id, ana.account.id);
      assert.deepEqual(command.voice, { channel: 'zoia' });
      assert.equal(frames(stream, 'command').length, 1, 'the old name is no command');
      assert.equal(JSON.stringify(command).includes('@'), false, 'no email');
    } finally {
      server.close();
    }
  });

  test('a bot’s own message is never a command', async () => {
    const server = app.listen(0);
    try {
      const { token, chat, as } = await addon();
      const { body } = await as('post', '/bots').send({ name: 'Zouve' }).expect(201);
      const stream = await listen(server, token);
      await as('post', `/chats/${chat.id}/messages`).send({ bot: body.bot.id, body: '!play x' });
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(frames(stream, 'command').length, 0);
    } finally {
      server.close();
    }
  });

  test('the stream ends when the addon is disabled', async () => {
    const server = app.listen(0);
    try {
      const { token, addon: a } = await addon();
      const stream = await listen(server, token);
      await stores.addons.setEnabled(a.id, false);
      await until(() => stream.ended);
    } finally {
      server.close();
    }
  });
});
