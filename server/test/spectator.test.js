/**
 * /spectator watches the room. The pairing token stays on the server; the
 * browser only sends a name.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import http from 'node:http';

import { createApp } from '../src/app.js';
import { createKeyStore } from '../src/keys.js';
import { createPairingStore } from '../src/pairings.js';
import { createDeviceStore } from '../src/devices.js';
import { createStage } from '../src/stage.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const spectator = readFileSync(join(PUBLIC_DIR, 'spectator.html'), 'utf8');
const appJs = readFileSync(join(PUBLIC_DIR, 'app.js'), 'utf8');

let dir;
let pairings;
let devices;
let app;
let rawToken;

const quiet = { info() {}, warn() {}, error() {}, log() {} };

function build(pairingToken = rawToken) {
  const rooms = { listParticipants: async () => [], updateParticipant: async () => {} };
  return createApp({
    config: {
      sessionSecret: 'test-session-secret-long-enough',
      trustProxy: 0,
      secureCookies: false,
      roomName: 'zoia',
      pairingToken,
      rateLimit: { windowMs: 60_000, limit: 1000 },
    },
    keyStore: createKeyStore({ file: join(dir, 'keys.json') }),
    pairingStore: pairings,
    deviceStore: devices,
    tokenIssuer: { issue: async () => ({ token: 't', wsUrl: 'wss://sfu.example' }) },
    stage: createStage({ rooms, roomName: 'zoia', logger: quiet }),
    logger: quiet,
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zoia-spectator-'));
  pairings = createPairingStore({ file: join(dir, 'pairings.json'), logger: quiet });
  devices = createDeviceStore({ file: join(dir, 'devices.json'), logger: quiet });
  ({ raw: rawToken } = await pairings.add({ name: 'browser' }));
  app = build();
});

afterEach(async () => {
  await Promise.all([pairings.idle(), devices.idle()]);
  await rm(dir, { recursive: true, force: true });
});

describe('/spectator', () => {
  test('the page only asks for a name', () => {
    assert.match(spectator, /id="name-input"/);
    assert.match(spectator, /playsinline/);
    assert.ok(!/zpair_/.test(spectator));
    assert.ok(!/getDisplayMedia/.test(appJs));
    assert.ok(!/getUserMedia/.test(appJs));
    assert.match(appJs, /\/api\/spectator\/join/);
    assert.ok(!/\/api\/pair/.test(appJs));
  });

  test('GET /spectator serves the player and leaves / alone', async () => {
    const page = await request(app).get('/spectator');
    assert.equal(page.status, 200);
    assert.match(page.text, /name-input/);

    const root = await request(app).get('/');
    assert.equal(root.status, 200);
    assert.ok(!/name-input/.test(root.text));
  });

  test('a name joins with the server token and opens a session', async () => {
    const res = await request(app).post('/api/spectator/join').send({ deviceName: 'Ada' });
    assert.equal(res.status, 200);
    assert.equal(res.body.name, 'Ada');
    assert.match(res.headers['set-cookie'][0], /zoia_sid=/);
    await pairings.idle();
    const stored = JSON.parse(readFileSync(join(dir, 'pairings.json'), 'utf8'));
    assert.equal(stored.pairings[0].activations, 1);
  });

  test('the raw token is not required from the browser and is not logged', async () => {
    const lines = [];
    const logger = {
      info: (line) => lines.push(String(line)),
      warn: (line) => lines.push(String(line)),
      error: (line) => lines.push(String(line)),
    };
    const rooms = { listParticipants: async () => [], updateParticipant: async () => {} };
    const logged = createApp({
      config: {
        sessionSecret: 'test-session-secret-long-enough',
        trustProxy: 0,
        secureCookies: false,
        roomName: 'zoia',
        pairingToken: rawToken,
      },
      keyStore: createKeyStore({ file: join(dir, 'keys.json') }),
      pairingStore: pairings,
      deviceStore: devices,
      tokenIssuer: { issue: async () => ({ token: 't', wsUrl: 'wss://sfu.example' }) },
      stage: createStage({ rooms, roomName: 'zoia', logger: quiet }),
      logger,
    });

    const res = await request(logged).post('/api/spectator/join').send({ deviceName: 'Bea' });
    assert.equal(res.status, 200);
    assert.ok(!JSON.stringify(res.body).includes(rawToken));
    assert.ok(!lines.join('\n').includes(rawToken));
  });

  test('without a configured token the page cannot join', async () => {
    const res = await request(build('')).post('/api/spectator/join').send({ deviceName: 'Ada' });
    assert.equal(res.status, 503);
  });

  test('with an upstream, the name is sent there and the local store is not used', async () => {
    const seen = [];
    const upstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        seen.push({ url: req.url, body });
        res.setHeader('content-type', 'application/json');
        if (req.url === '/api/pair') {
          res.end(
            JSON.stringify({ deviceCredential: 'zdev_secret', deviceId: 'abc', name: 'Ada' }),
          );
          return;
        }
        res.setHeader('set-cookie', 'zoia_sid=s%3Aabc; Path=/; Secure; Domain=zoia.example');
        res.end(JSON.stringify({ name: 'Ada', id: 'abc' }));
      });
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));

    const appWithUpstream = createApp({
      config: {
        sessionSecret: 'test-session-secret-long-enough',
        trustProxy: 0,
        secureCookies: false,
        roomName: 'zoia',
        pairingToken: 'zpair_from_env',
        upstream: `http://127.0.0.1:${upstream.address().port}`,
      },
      keyStore: createKeyStore({ file: join(dir, 'keys.json') }),
      pairingStore: pairings,
      deviceStore: devices,
      tokenIssuer: { issue: async () => ({ token: 'local', wsUrl: 'ws://127.0.0.1:9' }) },
      stage: createStage({
        rooms: { listParticipants: async () => [], updateParticipant: async () => {} },
        roomName: 'zoia',
        logger: quiet,
      }),
      logger: quiet,
    });

    const res = await request(appWithUpstream)
      .post('/api/spectator/join')
      .send({ deviceName: 'Ada' });
    assert.equal(res.status, 200);
    assert.equal(res.body.name, 'Ada');
    assert.equal(res.body.deviceCredential, undefined);
    assert.match(seen[0].body, /zpair_from_env/);
    assert.match(seen[0].body, /Ada/);
    assert.equal(seen[1].url, '/api/device/session');
    assert.match(res.headers['set-cookie'][0], /zoia_sid=/);
    assert.doesNotMatch(res.headers['set-cookie'][0], /Domain=/i);

    await pairings.idle();
    const stored = JSON.parse(readFileSync(join(dir, 'pairings.json'), 'utf8'));
    assert.equal(stored.pairings[0].activations, 0);

    await new Promise((resolve) => upstream.close(resolve));
  });
});
