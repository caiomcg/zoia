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

let dir;
let pairings;
let devices;
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
