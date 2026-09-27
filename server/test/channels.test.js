/**
 * Channels: several rooms, each with its own broadcasts. These cover how they
 * are configured, that a request is always about a real channel, and that one
 * person holds at most one broadcast slot across all of them.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';

import { createApp } from '../src/app.js';
import { parseChannels, DEFAULT_CHANNEL_COUNT } from '../src/config.js';
import { createKeyStore } from '../src/keys.js';
import { createTokenIssuer, decodeTokenPayload } from '../src/token.js';
import { createStage } from '../src/stage.js';
import { createWhipPublisher } from '../src/whip.js';

const quiet = { info() {}, warn() {}, error() {} };

describe('channel configuration', () => {
  test('without ROOMS there are five, and the first keeps the existing room', () => {
    const channels = parseChannels({});
    assert.equal(channels.length, DEFAULT_CHANNEL_COUNT);
    assert.deepEqual(channels[0], { id: 'zoia', name: 'Sala 1' });
    assert.deepEqual(channels[4], { id: 'zoia-5', name: 'Sala 5' });
  });

  test('ROOM_NAME still names the first channel', () => {
    assert.equal(parseChannels({ ROOM_NAME: 'amigos' })[0].id, 'amigos');
    assert.equal(parseChannels({ ROOM_NAME: 'amigos' })[1].id, 'amigos-2');
  });

  test('ROOMS lists id:Label pairs', () => {
    assert.deepEqual(parseChannels({ ROOMS: 'jogos:Jogos, filmes:Filmes e séries' }), [
      { id: 'jogos', name: 'Jogos' },
      { id: 'filmes', name: 'Filmes e séries' },
    ]);
  });

  test('a bad or repeated id fails at boot', () => {
    assert.throws(() => parseChannels({ ROOMS: 'Not Valid:X' }), /not a valid channel id/);
    assert.throws(() => parseChannels({ ROOMS: 'a:A,a:B' }), /same channel id twice/);
    assert.throws(() => parseChannels({ ROOMS: ' , ' }), /no channels/);
  });
});

describe('the channel routes', () => {
  let dir;
  let keyStore;
  let app;
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

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'zoia-channels-'));
    keyStore = createKeyStore({ file: join(dir, 'keys.json') });
    byRoom = {};
    const rooms = roomsStub();
    const secret = 'a-secret-long-enough-for-hmac-signing';
    const channels = [
      { id: 'zoia', name: 'Sala 1' },
      { id: 'zoia-2', name: 'Sala 2' },
    ].map(({ id, name }) => {
      const stage = createStage({ rooms, roomName: id, logger: quiet });
      const whip = createWhipPublisher({
        apiKey: 'devkey',
        apiSecret: secret,
        wsUrl: 'wss://sfu.example.com',
        roomName: id,
        rooms,
        stage,
        logger: quiet,
      });
      return { id, name, stage, whip };
    });
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
        apiSecret: secret,
        wsUrl: 'wss://sfu.example.com',
        roomName: 'zoia',
        roomService: { createRoom: async () => {} },
        logger: quiet,
      }),
      channels,
      logger: quiet,
    });
  });

  afterEach(async () => {
    await keyStore.idle();
    await rm(dir, { recursive: true, force: true });
  });

  /** Signs someone in and puts them in a channel's LiveKit room. */
  async function inChannel(name, room) {
    const { rawKey, record } = await keyStore.add({ name });
    const agent = request.agent(app);
    await agent.get(`/?k=${encodeURIComponent(rawKey)}`);
    (byRoom[room] ??= []).push({
      identity: record.id,
      name,
      permission: { canPublish: false, canSubscribe: true },
      tracks: [],
    });
    return { agent, record };
  }

  test('a token is for the channel asked for, and still subscribe-only', async () => {
    const { agent } = await inChannel('Alice', 'zoia-2');
    const res = await agent.post('/api/token').send({ room: 'zoia-2' });
    assert.equal(res.status, 200);
    assert.equal(res.body.room, 'zoia-2');
    const grant = decodeTokenPayload(res.body.token).video;
    assert.equal(grant.room, 'zoia-2');
    assert.equal(grant.canPublish, false);
  });

  test('naming no channel means the first, as clients from before channels do', async () => {
    const { agent } = await inChannel('Alice', 'zoia');
    const res = await agent.post('/api/token');
    assert.equal(res.body.room, 'zoia');
  });

  test('a channel that is not configured is refused, never created', async () => {
    const { agent } = await inChannel('Alice', 'zoia');
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
    const { agent: alice } = await inChannel('Alice', 'zoia');
    const { agent: bob } = await inChannel('Bob', 'zoia-2');
    await alice.post('/api/stage/claim').send({ room: 'zoia' });
    await bob.post('/api/stage/claim').send({ room: 'zoia-2' });

    const one = await alice.get('/api/stage?room=zoia');
    const two = await alice.get('/api/stage?room=zoia-2');
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
    const { agent, record } = await inChannel('Alice', 'zoia');
    await agent.post('/api/stage/claim').send({ room: 'zoia' });
    // Switched channel without releasing, as a crashed client would.
    byRoom['zoia-2'] = [{ ...byRoom.zoia[0], permission: { canPublish: false } }];

    const res = await agent.post('/api/stage/claim').send({ room: 'zoia-2' });
    assert.equal(res.status, 200);
    const first = byRoom.zoia.find((p) => p.identity === record.id);
    assert.equal(first.permission.canPublish, false, 'the old slot must be released');
  });

  test('the room list shows every channel with who is in it and who is live', async () => {
    const { agent } = await inChannel('Alice', 'zoia');
    await inChannel('Bob', 'zoia-2');
    await agent.post('/api/stage/claim').send({ room: 'zoia' });
    // Alice's hardware broadcast counts as hers, not as a second person.
    byRoom.zoia.push({
      identity: `${byRoom.zoia[0].identity}-gpu`,
      name: 'Alice',
      permission: { canPublish: true },
      tracks: [{}],
    });

    const res = await agent.get('/api/rooms');
    assert.equal(res.status, 200);
    const [one, two] = res.body.rooms;
    assert.equal(one.id, 'zoia');
    assert.equal(one.name, 'Sala 1');
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

  test('the room list requires a session', async () => {
    assert.equal((await request(app).get('/api/rooms')).status, 401);
  });
});
