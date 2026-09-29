/**
 * Pairing is the desktop app's whole access story, and its value is that it can
 * be taken away. These tests are mostly about revocation actually revoking.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';

import { createApp } from '../src/app.js';
import { createKeyStore } from '../src/keys.js';
import { createPairingStore } from '../src/pairings.js';
import { createDeviceStore } from '../src/devices.js';
import { createTokenIssuer } from '../src/token.js';
import { createStage } from '../src/stage.js';
import { AVATAR_ATTRIBUTE, AVATAR_MAX_BYTES, createAvatarStore } from '../src/avatars.js';

let dir;
let pairings;
let devices;
let avatars;
let keyStore;
let app;
let logLines;

const quiet = () => {
  logLines = [];
  const capture = (line) => logLines.push(String(line));
  return { info: capture, warn: capture, error: capture };
};

function buildApp(config = {}) {
  const logger = quiet();
  const rooms = {
    participants: [],
    listParticipants: async () => rooms.participants,
    updateParticipant: async () => {},
  };
  return createApp({
    config: {
      sessionSecret: 'test-session-secret-long-enough',
      trustProxy: 1,
      secureCookies: false,
      roomName: 'zoia',
      rateLimit: { windowMs: 60_000, limit: 1000, pairLimit: 1000 },
      ...config,
    },
    keyStore,
    pairingStore: pairings,
    deviceStore: devices,
    avatarStore: avatars,
    tokenIssuer: createTokenIssuer({
      apiKey: 'devkey',
      apiSecret: 'a-secret-long-enough-for-hmac-signing',
      wsUrl: 'wss://sfu.example.com',
      roomName: 'zoia',
      roomService: { createRoom: async () => {} },
      logger,
    }),
    stage: createStage({ rooms, roomName: 'zoia', logger }),
    logger,
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zoia-pair-'));
  keyStore = createKeyStore({ file: join(dir, 'keys.json') });
  pairings = createPairingStore({ file: join(dir, 'pairings.json'), logger: quiet() });
  devices = createDeviceStore({ file: join(dir, 'devices.json'), logger: quiet() });
  avatars = createAvatarStore({ dir: join(dir, 'avatars') });
  app = buildApp();
});

afterEach(async () => {
  await Promise.all([keyStore.idle(), pairings.idle(), devices.idle()]);
  await rm(dir, { recursive: true, force: true });
});

async function pair(token, deviceName = 'Laptop') {
  return request(app).post('/api/pair').send({ pairingToken: token, deviceName });
}

describe('pairing tokens', () => {
  test('a valid token yields a device credential', async () => {
    const { raw } = await pairings.add({ name: 'v1 build' });
    const res = await pair(raw);

    assert.equal(res.status, 200);
    assert.match(res.body.deviceCredential, /^zdev_[0-9a-f]{8}_/);
    assert.equal(res.body.name, 'Laptop');
  });

  test('the raw token is never persisted', async () => {
    const { raw } = await pairings.add({ name: 'v1 build' });
    const secret = raw.split('_').slice(2).join('_');
    const onDisk = await readFile(join(dir, 'pairings.json'), 'utf8');
    assert.ok(!onDisk.includes(secret), 'raw pairing secret must not reach the store');
  });

  test('a wrong token is refused', async () => {
    await pairings.add({ name: 'v1 build' });
    const res = await pair(`zpair_deadbeef_${'x'.repeat(43)}`);
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'invalid');
  });

  test('a device name is required, so the list stays meaningful', async () => {
    const { raw } = await pairings.add({ name: 'v1 build' });
    assert.equal((await pair(raw, '  ')).status, 400);
  });

  test('one token pairs many machines', async () => {
    const { raw } = await pairings.add({ name: 'v1 build' });
    for (const name of ['Alice PC', 'Bob PC', 'Caio PC']) {
      assert.equal((await pair(raw, name)).status, 200);
    }
    assert.equal((await devices.list()).length, 3);
  });

  test('activations can be capped', async () => {
    const { raw } = await pairings.add({ name: 'limited', maxActivations: 2 });

    assert.equal((await pair(raw, 'one')).status, 200);
    assert.equal((await pair(raw, 'two')).status, 200);

    const third = await pair(raw, 'three');
    assert.equal(third.status, 409);
    assert.equal(third.body.error, 'exhausted', 'exhausted is not the same problem as wrong');
  });

  test('revoking a device frees its seat', async () => {
    const { raw } = await pairings.add({ name: 'limited', maxActivations: 2 });

    const one = await pair(raw, 'one');
    assert.equal((await pair(raw, 'two')).status, 200);
    assert.equal((await pair(raw, 'three')).status, 409);

    await devices.revoke(one.body.deviceId);
    assert.equal((await pair(raw, 'three')).status, 200, 'a revoked machine holds no seat');
    assert.equal((await pair(raw, 'four')).status, 409);
  });

  test('no raw token or credential reaches a log line', async () => {
    const { raw } = await pairings.add({ name: 'v1 build' });
    const res = await pair(raw);

    const combined = logLines.join('\n');
    assert.ok(!combined.includes(raw), 'a pairing token reached the logs');
    assert.ok(
      !combined.includes(res.body.deviceCredential),
      'a device credential reached the logs',
    );
  });
});

describe('the two kill switches', () => {
  test('revoking the token stops new machines but spares paired ones', async () => {
    const { record, raw } = await pairings.add({ name: 'leaked build' });
    const first = await pair(raw, 'Already paired');
    assert.equal(first.status, 200);

    await pairings.revoke(record.id);

    assert.equal((await pair(raw, 'Too late')).status, 401, 'no new machines may activate');

    const agent = request.agent(app);
    const session = await agent
      .post('/api/device/session')
      .send({ deviceCredential: first.body.deviceCredential });
    assert.equal(session.status, 200, 'an already-paired machine must keep working');
  });

  test('revoking one device cuts off only that machine', async () => {
    const { raw } = await pairings.add({ name: 'v1 build' });
    const a = (await pair(raw, 'A')).body;
    const b = (await pair(raw, 'B')).body;

    await devices.revoke(a.deviceId);

    assert.equal(
      (
        await request(app)
          .post('/api/device/session')
          .send({ deviceCredential: a.deviceCredential })
      ).status,
      401,
    );
    assert.equal(
      (
        await request(app)
          .post('/api/device/session')
          .send({ deviceCredential: b.deviceCredential })
      ).status,
      200,
    );
  });

  test('a token can cascade to every device it issued', async () => {
    const { record, raw } = await pairings.add({ name: 'v1 build' });
    await pair(raw, 'A');
    await pair(raw, 'B');

    const other = await pairings.add({ name: 'v2 build' });
    const kept = (await pair(other.raw, 'C')).body;

    assert.equal(await devices.revokeByPairing(record.id), 2);

    const live = await devices.list();
    assert.equal(live.filter((d) => !d.revoked).length, 1);
    assert.equal(live.find((d) => !d.revoked).id, kept.deviceId);
  });
});

describe('device sessions', () => {
  async function pairedAgent() {
    const { raw } = await pairings.add({ name: 'v1 build' });
    const { body } = await pair(raw, 'Workstation');
    const agent = request.agent(app);
    await agent.post('/api/device/session').send({ deviceCredential: body.deviceCredential });
    return { agent, body };
  }

  test('a paired device reaches the room like any other member', async () => {
    const { agent } = await pairedAgent();

    const session = await agent.get('/api/session');
    assert.equal(session.status, 200);
    assert.equal(session.body.name, 'Workstation');

    const token = await agent.post('/api/token');
    assert.equal(token.status, 200);

    const grant = JSON.parse(
      Buffer.from(token.body.token.split('.')[1], 'base64url').toString('utf8'),
    ).video;
    assert.equal(grant.canPublish, false, 'devices join subscribe-only like everyone else');
  });

  test('activity is recorded against the device, not the key store', async () => {
    const { agent, body } = await pairedAgent();
    await devices.idle();

    const before = (await devices.list()).find((d) => d.id === body.deviceId).lastSeen;

    // A running app renews its token without re-running /api/device/session,
    // so if this did not update lastSeen, `device:list` would show a machine
    // as idle while it was streaming — and the runbook says to revoke on that.
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await agent.post('/api/token')).status, 200);
    await devices.idle();

    const after = (await devices.list()).find((d) => d.id === body.deviceId).lastSeen;
    assert.ok(after > before, `lastSeen must advance on use (${before} -> ${after})`);
  });

  test('revocation takes effect on the very next request', async () => {
    const { agent, body } = await pairedAgent();
    assert.equal((await agent.get('/api/session')).status, 200);

    await devices.revoke(body.deviceId);

    assert.equal((await agent.get('/api/session')).status, 401);
  });

  test('an invalid credential is refused', async () => {
    const res = await request(app)
      .post('/api/device/session')
      .send({ deviceCredential: `zdev_deadbeef_${'x'.repeat(43)}` });
    assert.equal(res.status, 401);
  });

  test('a device cookie cannot be forged', async () => {
    const res = await request(app).get('/api/session').set('Cookie', 'zoia_sid=device:deadbeef');
    assert.equal(res.status, 401, 'an unsigned cookie must be rejected');
  });

  test('invite-key sessions still work alongside devices', async () => {
    const { rawKey } = await keyStore.add({ name: 'Web user' });
    const agent = request.agent(app);
    await agent.get(`/?k=${encodeURIComponent(rawKey)}`);

    const res = await agent.get('/api/session');
    assert.equal(res.status, 200);
    assert.equal(res.body.name, 'Web user');
  });
});

describe('renaming a device', () => {
  /** Pairs a device and returns an agent holding its session cookie. */
  async function pairedAgent(name = 'Laptop') {
    const { raw } = await pairings.add({ name: 'build', maxActivations: 5 });
    const paired = await request(app)
      .post('/api/pair')
      .send({ pairingToken: raw, deviceName: name });
    // Pairing hands back a credential; it has to be exchanged for a session
    // cookie before any authenticated route will answer.
    const agent = request.agent(app);
    await agent
      .post('/api/device/session')
      .send({ deviceCredential: paired.body.deviceCredential });
    return agent;
  }

  test('a device can rename itself and the new name sticks', async () => {
    const agent = await pairedAgent('Old name');

    const res = await agent.post('/api/name').send({ name: 'Caio' });
    assert.equal(res.status, 200);
    assert.equal(res.body.name, 'Caio');

    // Read back through a fresh request: the store is the source of truth, so
    // a rename that only lived in memory would be caught here.
    const session = await agent.get('/api/session');
    assert.equal(session.body.name, 'Caio');
  });

  test('an empty name is refused rather than blanking the display name', async () => {
    const agent = await pairedAgent('Keep me');

    const res = await agent.post('/api/name').send({ name: '   ' });
    assert.equal(res.status, 400);

    const session = await agent.get('/api/session');
    assert.equal(session.body.name, 'Keep me', 'the old name must survive a rejected rename');
  });

  test('an absurdly long name is refused', async () => {
    const agent = await pairedAgent();
    const res = await agent.post('/api/name').send({ name: 'x'.repeat(33) });
    assert.equal(res.status, 400);
  });

  test('renaming requires a session', async () => {
    const res = await request(app).post('/api/name').send({ name: 'nobody' });
    assert.equal(res.status, 401);
  });

  test('a name someone else has is refused, however it is written', async () => {
    const alice = await pairedAgent('Alice');
    await alice.post('/api/name').send({ name: 'Flávia' });
    const bob = await pairedAgent('Bob');

    for (const name of ['Flávia', 'flavia', '  FLAVIA ', 'Fla\u200Bvia']) {
      const res = await bob.post('/api/name').send({ name });
      assert.equal(res.status, 409, JSON.stringify(name));
      assert.equal(res.body.error, 'name_taken');
    }
    assert.equal(
      (await bob.get('/api/session')).body.name,
      'Bob',
      'the refused name must not stick',
    );
  });

  test('your own name, recased, is still yours', async () => {
    const agent = await pairedAgent('flavi');
    const res = await agent.post('/api/name').send({ name: 'Flavi' });
    assert.equal(res.status, 200);
    assert.equal(res.body.name, 'Flavi');
  });

  test("a revoked device's name is free again", async () => {
    const { raw } = await pairings.add({ name: 'build', maxActivations: 5 });
    const old = await request(app)
      .post('/api/pair')
      .send({ pairingToken: raw, deviceName: 'Caio' });
    await devices.revoke(old.body.deviceId);
    const agent = await pairedAgent('Someone');
    assert.equal((await agent.post('/api/name').send({ name: 'Caio' })).status, 200);
  });

  test('pairing under a name in use gets a number instead of being refused', async () => {
    const { raw } = await pairings.add({ name: 'build', maxActivations: 5 });
    const names = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await request(app)
        .post('/api/pair')
        .send({ pairingToken: raw, deviceName: 'PC' });
      assert.equal(res.status, 200);
      names.push(res.body.name);
    }
    assert.deepEqual(names, ['PC', 'PC 2', 'PC 3']);
  });
});

describe('names shared from before they were unique', () => {
  test('whoever held the name longest keeps it, the others get a number', async () => {
    const { raw } = await pairings.add({ name: 'build', maxActivations: 5 });
    const ids = [];
    for (const deviceName of ['A', 'B', 'C']) {
      const res = await request(app).post('/api/pair').send({ pairingToken: raw, deviceName });
      ids.push(res.body.deviceId);
    }
    // As the store looked before: three people on one nick, set in this order.
    await devices.mutate((records) => {
      const at = ['2026-01-02', '2026-01-01', '2026-01-03'];
      records.forEach((r, i) => {
        r.name = i === 2 ? 'FLAVI' : 'Flavi';
        r.renamedAt = `${at[i]}T00:00:00.000Z`;
      });
    });

    const changed = await devices.dedupeNames();
    assert.equal(changed.length, 2);
    const byId = new Map((await devices.all()).map((r) => [r.id, r.name]));
    assert.equal(byId.get(ids[1]), 'Flavi', 'the earliest holder keeps the name');
    assert.equal(byId.get(ids[0]), 'Flavi 2');
    assert.equal(byId.get(ids[2]), 'FLAVI 3');

    assert.deepEqual(await devices.dedupeNames(), [], 'a second run changes nothing');
  });
});

describe('profile pictures', () => {
  // The smallest bytes each accepted type is recognised by.
  const WEBP = Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.alloc(4),
    Buffer.from('WEBPVP8 '),
    Buffer.alloc(16),
  ]);
  const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(16),
  ]);

  /** Pairs a device and returns its id and an agent holding its session. */
  async function pairedDevice(name = 'Laptop') {
    const { raw } = await pairings.add({ name: 'build', maxActivations: 5 });
    const paired = await request(app)
      .post('/api/pair')
      .send({ pairingToken: raw, deviceName: name });
    const agent = request.agent(app);
    await agent
      .post('/api/device/session')
      .send({ deviceCredential: paired.body.deviceCredential });
    return { agent, id: paired.body.deviceId, credential: paired.body.deviceCredential };
  }

  const upload = (agent, bytes, type = 'image/webp') =>
    agent.put('/api/avatar').set('content-type', type).send(bytes);

  test('a device can set a picture, and others can fetch it by its id', async () => {
    const alice = await pairedDevice('Alice');
    const bob = await pairedDevice('Bob');

    const res = await upload(alice.agent, WEBP);
    assert.equal(res.status, 200);
    assert.match(res.body.avatar, /^[0-9a-f]{16}$/);

    const fetched = await bob.agent.get(`/api/avatar/${alice.id}?v=${res.body.avatar}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.headers['content-type'], 'image/webp');
    assert.equal(fetched.headers['x-content-type-options'], 'nosniff');
    assert.deepEqual(Buffer.from(fetched.body), WEBP);
  });

  test('the version survives a restart and reaches the room through the token', async () => {
    const alice = await pairedDevice();
    const { body } = await upload(alice.agent, WEBP);

    const session = await request(app)
      .post('/api/device/session')
      .send({ deviceCredential: alice.credential });
    assert.equal(session.body.avatar, body.avatar);

    const token = await alice.agent.post('/api/token').send({});
    const payload = JSON.parse(
      Buffer.from(token.body.token.split('.')[1], 'base64url').toString('utf8'),
    );
    assert.equal(payload.attributes?.[AVATAR_ATTRIBUTE], body.avatar);
  });

  test('the type is judged by the bytes, not by what the client says', async () => {
    const alice = await pairedDevice();
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    assert.equal((await upload(alice.agent, html, 'image/png')).status, 400);

    const png = await upload(alice.agent, PNG, 'image/webp');
    assert.equal(png.status, 200);
    const fetched = await alice.agent.get(`/api/avatar/${alice.id}`);
    assert.equal(fetched.headers['content-type'], 'image/png');
  });

  test('an oversized picture is refused as too large, not as a server error', async () => {
    const alice = await pairedDevice();
    const huge = Buffer.concat([WEBP, Buffer.alloc(AVATAR_MAX_BYTES)]);
    const res = await upload(alice.agent, huge);
    assert.equal(res.status, 413);
    assert.equal(res.body.error, 'avatar_too_large');
  });

  test('removing the picture takes it away for everyone', async () => {
    const alice = await pairedDevice();
    await upload(alice.agent, WEBP);

    assert.equal((await alice.agent.delete('/api/avatar')).status, 200);
    assert.equal((await alice.agent.get(`/api/avatar/${alice.id}`)).status, 404);
    const session = await request(app)
      .post('/api/device/session')
      .send({ deviceCredential: alice.credential });
    assert.equal(session.body.avatar, null);
  });

  test('an id that is not a device id never reaches the filesystem', async () => {
    const alice = await pairedDevice();
    for (const id of ['..%2Fdevices.json', '..', 'ABCDEF12', '1234567', 'deadbeef']) {
      assert.equal((await alice.agent.get(`/api/avatar/${id}`)).status, 404, id);
    }
  });

  test('setting, removing and fetching all require a session', async () => {
    assert.equal((await upload(request(app), WEBP)).status, 401);
    assert.equal((await request(app).delete('/api/avatar')).status, 401);
    assert.equal((await request(app).get('/api/avatar/deadbeef')).status, 401);
  });
});
