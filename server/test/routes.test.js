import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';

import { createApp } from '../src/app.js';
import { createKeyStore } from '../src/keys.js';
import { createTokenIssuer } from '../src/token.js';

let dir;
let keyStore;
let app;
let logLines;

const BASE_CONFIG = {
  sessionSecret: 'test-session-secret-long-enough',
  trustProxy: 1,
  secureCookies: false, // supertest speaks plain HTTP
  roomName: 'zoia',
};

function buildApp(config = {}) {
  logLines = [];
  const capture = (line) => logLines.push(String(line));
  const logger = { info: capture, warn: capture, error: capture };

  const tokenIssuer = createTokenIssuer({
    apiKey: 'devkey',
    apiSecret: 'a-secret-long-enough-for-hmac-signing',
    wsUrl: 'wss://sfu.example.com',
    roomName: 'zoia',
    roomService: { createRoom: async () => {} },
    logger,
  });

  return createApp({
    config: { ...BASE_CONFIG, rateLimit: { windowMs: 60_000, limit: 1000 }, ...config },
    keyStore,
    tokenIssuer,
    logger,
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zoia-routes-'));
  keyStore = createKeyStore({ file: join(dir, 'keys.json') });
  app = buildApp();
});

afterEach(async () => {
  // touch() is fire-and-forget, so let queued writes settle before the
  // directory disappears underneath them.
  await keyStore.idle();
  await rm(dir, { recursive: true, force: true });
});

function sessionCookie(res) {
  const cookies = res.headers['set-cookie'] ?? [];
  return cookies.filter((c) => c.startsWith('zoia_sid='));
}

describe('key login via URL', () => {
  test('a valid key sets a session and redirects with the key stripped', async () => {
    const { rawKey } = await keyStore.add({ name: 'Alice', role: 'viewer' });

    const res = await request(app).get(`/?k=${encodeURIComponent(rawKey)}`);

    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/', 'the key must not survive in the redirect target');
    assert.equal(sessionCookie(res).length, 1);
  });

  test('the session cookie is HttpOnly, SameSite=Lax and signed', async () => {
    const { rawKey } = await keyStore.add({ name: 'Alice', role: 'viewer' });
    const res = await request(app).get(`/?k=${encodeURIComponent(rawKey)}`);
    const [cookie] = sessionCookie(res);

    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    // A signed cookie is prefixed s: by cookie-parser.
    assert.match(cookie, /zoia_sid=s%3A/);
  });

  test('the cookie carries only the key id, never the secret', async () => {
    const { rawKey, record } = await keyStore.add({ name: 'Alice', role: 'viewer' });
    const secret = rawKey.split('_')[2];
    const [cookie] = sessionCookie(await request(app).get(`/?k=${encodeURIComponent(rawKey)}`));

    assert.ok(cookie.includes(record.id));
    assert.ok(!cookie.includes(secret), 'the secret must never reach the cookie');
  });

  test('an invalid key redirects without a session', async () => {
    const res = await request(app).get(`/?k=zoia_deadbeef_${'x'.repeat(43)}`);
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/?error=invalid_key');
    assert.equal(sessionCookie(res).length, 0);
  });

  test('a garbage key is rejected the same way', async () => {
    const res = await request(app).get('/?k=nonsense');
    assert.equal(res.headers.location, '/?error=invalid_key');
    assert.equal(sessionCookie(res).length, 0);
  });

  test('a revoked key cannot start a session', async () => {
    const { rawKey, record } = await keyStore.add({ name: 'Alice', role: 'viewer' });
    await keyStore.revoke(record.id);

    const res = await request(app).get(`/?k=${encodeURIComponent(rawKey)}`);
    assert.equal(res.headers.location, '/?error=invalid_key');
    assert.equal(sessionCookie(res).length, 0);
  });

  test('no raw key is written to any log line', async () => {
    const { rawKey } = await keyStore.add({ name: 'Alice', role: 'viewer' });
    const secret = rawKey.split('_')[2];

    await request(app).get(`/?k=${encodeURIComponent(rawKey)}`);
    await request(app).get(`/?k=zoia_deadbeef_${'x'.repeat(43)}`);

    const combined = logLines.join('\n');
    assert.ok(!combined.includes(secret), 'a raw secret reached the logs');
    assert.ok(!combined.includes(rawKey), 'a raw key reached the logs');
  });
});

describe('sessions', () => {
  async function agentWithKey(role = 'viewer') {
    const { rawKey, record } = await keyStore.add({ name: 'Alice', role });
    const agent = request.agent(app);
    await agent.get(`/?k=${encodeURIComponent(rawKey)}`);
    return { agent, record };
  }

  test('/api/session reports the signed-in person', async () => {
    const { agent, record } = await agentWithKey('host');
    const res = await agent.get('/api/session');

    assert.equal(res.status, 200);
    assert.equal(res.body.name, 'Alice');
    assert.equal(res.body.role, 'host');
    assert.equal(res.body.id, record.id);
  });

  test('/api/session is 401 without a cookie', async () => {
    assert.equal((await request(app).get('/api/session')).status, 401);
  });

  test('a forged cookie is rejected because it is unsigned', async () => {
    const res = await request(app).get('/api/session').set('Cookie', 'zoia_sid=deadbeef');
    assert.equal(res.status, 401);
  });

  test('revocation takes effect on the very next request', async () => {
    const { agent, record } = await agentWithKey();
    assert.equal((await agent.get('/api/session')).status, 200);

    await keyStore.revoke(record.id);

    assert.equal(
      (await agent.get('/api/session')).status,
      401,
      'a revoked key must not survive on an existing session',
    );
  });

  test('logout clears the session', async () => {
    const { agent } = await agentWithKey();
    await agent.post('/api/logout');
    assert.equal((await agent.get('/api/session')).status, 401);
  });

  test('POST /api/login accepts a pasted key', async () => {
    const { rawKey } = await keyStore.add({ name: 'Bob', role: 'viewer' });
    const res = await request(app).post('/api/login').send({ key: rawKey });

    assert.equal(res.status, 200);
    assert.equal(res.body.role, 'viewer');
  });

  test('POST /api/login rejects a bad key with 401', async () => {
    const res = await request(app).post('/api/login').send({ key: 'nope' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'invalid_key');
  });

  test('POST /api/login with no body does not crash', async () => {
    assert.equal((await request(app).post('/api/login').send({})).status, 401);
  });
});

describe('token issuance', () => {
  test('refuses to mint a token without a session', async () => {
    assert.equal((await request(app).post('/api/token')).status, 401);
  });

  test('a viewer session receives a subscribe-only token', async () => {
    const { rawKey } = await keyStore.add({ name: 'Alice', role: 'viewer' });
    const agent = request.agent(app);
    await agent.get(`/?k=${encodeURIComponent(rawKey)}`);

    const res = await agent.post('/api/token');
    assert.equal(res.status, 200);
    assert.equal(res.body.role, 'viewer');
    assert.equal(res.body.wsUrl, 'wss://sfu.example.com');

    const grant = JSON.parse(
      Buffer.from(res.body.token.split('.')[1], 'base64url').toString('utf8'),
    ).video;
    assert.equal(grant.canPublish, false);
  });

  test('a host session receives a publish-capable token', async () => {
    const { rawKey } = await keyStore.add({ name: 'Caio', role: 'host' });
    const agent = request.agent(app);
    await agent.get(`/?k=${encodeURIComponent(rawKey)}`);

    const res = await agent.post('/api/token');
    const grant = JSON.parse(
      Buffer.from(res.body.token.split('.')[1], 'base64url').toString('utf8'),
    ).video;
    assert.equal(grant.canPublish, true);
  });

  test('a revoked viewer cannot obtain a token afterwards', async () => {
    const { rawKey, record } = await keyStore.add({ name: 'Alice', role: 'viewer' });
    const agent = request.agent(app);
    await agent.get(`/?k=${encodeURIComponent(rawKey)}`);
    await keyStore.revoke(record.id);

    assert.equal((await agent.post('/api/token')).status, 401);
  });
});

describe('rate limiting', () => {
  test('repeated failed attempts are throttled', async () => {
    app = buildApp({ rateLimit: { windowMs: 60_000, limit: 3 } });

    const statuses = [];
    for (let i = 0; i < 5; i += 1) {
      statuses.push((await request(app).post('/api/login').send({ key: 'wrong' })).status);
    }

    assert.deepEqual(statuses.slice(0, 3), [401, 401, 401]);
    assert.ok(
      statuses.slice(3).every((s) => s === 429),
      `expected throttling after the limit, got ${statuses.join(',')}`,
    );
  });
});

describe('health', () => {
  test('/healthz answers without a session', async () => {
    const res = await request(app).get('/healthz');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });
});
