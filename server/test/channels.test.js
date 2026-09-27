/**
 * Channels: a default one that always exists, plus any others people add, up
 * to the server's limit. These cover the store's rules, that a request is
 * always about a real channel, and that one person holds at most one broadcast
 * slot across all of them.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';

import { createApp } from '../src/app.js';
import { createChannelStore, cleanChannelName, CHANNEL_NAME_MAX } from '../src/channels.js';
import { createKeyStore } from '../src/keys.js';
import { createTokenIssuer, decodeTokenPayload } from '../src/token.js';
import { createStage } from '../src/stage.js';
import { createWhipPublisher } from '../src/whip.js';

const quiet = { info() {}, warn() {}, error() {} };
const SECRET = 'a-secret-long-enough-for-hmac-signing';

let dir;
// Participants per LiveKit room, so channels are genuinely separate.
let byRoom;

function roomsStub() {
  const list = (room) => (byRoom[room] ??= []);
  return {
    listParticipants: async (room) => list(room),
    updateParticipant: async (room, identity, options) => {
      const p = list(room).find((x) => x.identity === identity);
      if (p) p.permission = { ...p.permission, ...options.permission };
      return p;
    },
    removeParticipant: async (room, identity) => {
      byRoom[room] = list(room).filter((x) => x.identity !== identity);
    },
  };
}

function makeStore(overrides = {}) {
  const rooms = roomsStub();
  return createChannelStore({
    file: join(dir, 'channels.json'),
    defaultId: 'zoia',
    max: 5,
    logger: quiet,
    makeRuntime: (id) => {
      const stage = createStage({ rooms, roomName: id, logger: quiet });
      const whip = createWhipPublisher({
        apiKey: 'devkey',
        apiSecret: SECRET,
        wsUrl: 'wss://sfu.example.com',
        roomName: id,
        rooms,
        stage,
        logger: quiet,
      });
      return { stage, whip };
    },
    ...overrides,
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zoia-channels-'));
  byRoom = {};
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('channel names', () => {
  test('are trimmed and collapse inner whitespace', () => {
    assert.equal(cleanChannelName('  Jogos   e  filmes '), 'Jogos e filmes');
  });

  test('blank, too long, control characters or not a string are refused', () => {
    assert.equal(cleanChannelName('   '), null);
    assert.equal(cleanChannelName('x'.repeat(CHANNEL_NAME_MAX + 1)), null);
    assert.equal(cleanChannelName('a\u0007b'), null);
    assert.equal(cleanChannelName(42), null);
  });
});

describe('the channel store', () => {
  test('the default channel always exists, first, even with nothing saved', async () => {
    const channels = await makeStore().list();
    assert.equal(channels.length, 1);
    assert.equal(channels[0].id, 'zoia');
    assert.equal(channels[0].name, 'Geral');
    assert.equal(channels[0].isDefault, true);
  });

  test('channels can be added up to the limit, the default included', async () => {
    const store = makeStore();
    for (let i = 2; i <= 5; i += 1) {
      assert.equal((await store.create(`Sala ${i}`)).ok, true);
    }
    const sixth = await store.create('Sala 6');
    assert.deepEqual(sixth, { ok: false, reason: 'room_limit' });
    assert.equal((await store.list()).length, 5);
  });

  test('added channels get their own room, prefixed by the default id', async () => {
    const { channel } = await makeStore().create('Jogos');
    assert.match(channel.id, /^zoia-[0-9a-f]{6}$/);
  });

  test('any channel can be renamed, the default one included', async () => {
    const store = makeStore();
    assert.equal((await store.rename('zoia', 'Principal')).ok, true);
    const { channel } = await store.create('Jogos');
    assert.equal((await store.rename(channel.id, 'Filmes')).ok, true);
    assert.deepEqual(
      (await store.list()).map((c) => c.name),
      ['Principal', 'Filmes'],
    );
  });

  test('the default channel can never be removed', async () => {
    assert.deepEqual(await makeStore().remove('zoia'), { ok: false, reason: 'room_is_default' });
  });

  test('channels survive a restart', async () => {
    const { channel } = await makeStore().create('Jogos');
    const reopened = makeStore();
    assert.equal((await reopened.get(channel.id))?.name, 'Jogos');
    assert.match(await readFile(join(dir, 'channels.json'), 'utf8'), /Jogos/);
  });

  test('a refused write does not break later ones', async () => {
    const store = makeStore();
    await store.create('   ');
    await store.remove('zoia');
    await store.rename('missing', 'X');
    assert.equal((await store.create('Jogos')).ok, true);
  });
});

describe('the channel routes', () => {
  let keyStore;
  let app;

  beforeEach(() => {
    keyStore = createKeyStore({ file: join(dir, 'keys.json') });
    app = createApp({
      config: {
        sessionSecret: 'test-session-secret-long-enough',
        trustProxy: 1,
        secureCookies: false,
        roomName: 'zoia',
        rateLimit: { windowMs: 60_000, limit: 1000 },
      },
      keyStore,
      tokenIssuer: createTokenIssuer({
        apiKey: 'devkey',
        apiSecret: SECRET,
        wsUrl: 'wss://sfu.example.com',
        roomName: 'zoia',
        roomService: { createRoom: async () => {} },
        logger: quiet,
      }),
      channels: makeStore(),
      logger: quiet,
    });
  });

  afterEach(async () => {
    await keyStore.idle();
  });

  /** Signs someone in and, given a room, puts them in its LiveKit room. */
  async function signedIn(name, room) {
    const { rawKey, record } = await keyStore.add({ name });
    const agent = request.agent(app);
    await agent.get(`/?k=${encodeURIComponent(rawKey)}`);
    if (room) {
      (byRoom[room] ??= []).push({
        identity: record.id,
        name,
        permission: { canPublish: false, canSubscribe: true },
        tracks: [],
      });
    }
    return { agent, record };
  }

  async function newChannel(agent, name) {
    const res = await agent.post('/api/rooms').send({ name });
    assert.equal(res.status, 201);
    return res.body.room.id;
  }

  test('anyone signed in can add, rename and list channels', async () => {
    const { agent } = await signedIn('Alice');
    const id = await newChannel(agent, 'Jogos');
    assert.equal((await agent.patch(`/api/rooms/${id}`).send({ name: 'Filmes' })).status, 200);

    const res = await agent.get('/api/rooms');
    assert.equal(res.body.max, 5);
    assert.deepEqual(
      res.body.rooms.map((r) => [r.name, r.isDefault]),
      [
        ['Geral', true],
        ['Filmes', false],
      ],
    );
  });

  test('the sixth channel is refused', async () => {
    const { agent } = await signedIn('Alice');
    for (let i = 2; i <= 5; i += 1) await newChannel(agent, `Sala ${i}`);
    const res = await agent.post('/api/rooms').send({ name: 'Sala 6' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'room_limit');
  });

  test('a bad name is refused', async () => {
    const { agent } = await signedIn('Alice');
    const res = await agent.post('/api/rooms').send({ name: '' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_name');
  });

  test('an empty channel can be removed; an occupied or default one cannot', async () => {
    const { agent } = await signedIn('Alice');
    const empty = await newChannel(agent, 'Vazia');
    const occupied = await newChannel(agent, 'Cheia');
    await signedIn('Bob', occupied);

    assert.equal((await agent.delete(`/api/rooms/${empty}`)).status, 200);
    const busy = await agent.delete(`/api/rooms/${occupied}`);
    assert.equal(busy.status, 409);
    assert.equal(busy.body.error, 'room_not_empty');
    const main = await agent.delete('/api/rooms/zoia');
    assert.equal(main.status, 409);
    assert.equal(main.body.error, 'room_is_default');
  });

  test('channel management requires a session', async () => {
    assert.equal((await request(app).get('/api/rooms')).status, 401);
    assert.equal((await request(app).post('/api/rooms').send({ name: 'X' })).status, 401);
    assert.equal((await request(app).patch('/api/rooms/zoia').send({ name: 'X' })).status, 401);
    assert.equal((await request(app).delete('/api/rooms/zoia')).status, 401);
  });

  test('a token is for the channel asked for, and still subscribe-only', async () => {
    const { agent } = await signedIn('Alice');
    const id = await newChannel(agent, 'Jogos');
    const res = await agent.post('/api/token').send({ room: id });
    assert.equal(res.status, 200);
    assert.equal(res.body.room, id);
    const grant = decodeTokenPayload(res.body.token).video;
    assert.equal(grant.room, id);
    assert.equal(grant.canPublish, false);
  });

  test('naming no channel means the default, as clients from before channels do', async () => {
    const { agent } = await signedIn('Alice');
    assert.equal((await agent.post('/api/token')).body.room, 'zoia');
  });

  test('a channel that does not exist is refused, never created', async () => {
    const { agent } = await signedIn('Alice', 'zoia');
    // One at a time: a supertest request starts its server when awaited.
    for (const call of [
      () => agent.post('/api/token').send({ room: 'elsewhere' }),
      () => agent.get('/api/stage?room=elsewhere'),
      () => agent.post('/api/stage/claim').send({ room: 'elsewhere' }),
      () => agent.post('/api/whip').send({ room: 'elsewhere' }),
    ]) {
      const res = await call();
      assert.equal(res.status, 404);
      assert.equal(res.body.error, 'unknown_room');
    }
  });

  test('broadcasts are per channel', async () => {
    const { agent: alice } = await signedIn('Alice', 'zoia');
    const other = await newChannel(alice, 'Jogos');
    const { agent: bob } = await signedIn('Bob', other);
    await alice.post('/api/stage/claim').send({ room: 'zoia' });
    await bob.post('/api/stage/claim').send({ room: other });

    const one = await alice.get('/api/stage?room=zoia');
    const two = await alice.get(`/api/stage?room=${other}`);
    assert.deepEqual(
      one.body.broadcasters.map((b) => b.name),
      ['Alice'],
    );
    assert.deepEqual(
      two.body.broadcasters.map((b) => b.name),
      ['Bob'],
    );
  });

  test('claiming in one channel releases a slot held in another', async () => {
    const { agent, record } = await signedIn('Alice', 'zoia');
    const other = await newChannel(agent, 'Jogos');
    await agent.post('/api/stage/claim').send({ room: 'zoia' });
    // Switched channel without releasing, as a crashed client would.
    byRoom[other] = [{ ...byRoom.zoia[0], permission: { canPublish: false } }];

    const res = await agent.post('/api/stage/claim').send({ room: other });
    assert.equal(res.status, 200);
    const first = byRoom.zoia.find((p) => p.identity === record.id);
    assert.equal(first.permission.canPublish, false, 'the old slot must be released');
  });

  test('the room list shows who is in each channel and who is live', async () => {
    const { agent } = await signedIn('Alice', 'zoia');
    const other = await newChannel(agent, 'Jogos');
    await signedIn('Bob', other);
    await agent.post('/api/stage/claim').send({ room: 'zoia' });
    // Alice's hardware broadcast counts as hers, not as a second person.
    byRoom.zoia.push({
      identity: `${byRoom.zoia[0].identity}-gpu`,
      name: 'Alice',
      permission: { canPublish: true },
      tracks: [{}],
    });

    const [one, two] = (await agent.get('/api/rooms')).body.rooms;
    assert.deepEqual(
      one.participants.map((p) => p.name),
      ['Alice'],
    );
    assert.deepEqual(
      one.broadcasters.map((b) => b.name),
      ['Alice'],
    );
    assert.deepEqual(
      two.participants.map((p) => p.name),
      ['Bob'],
    );
    assert.deepEqual(two.broadcasters, []);
  });
});
