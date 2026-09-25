/**
 * The browser client is retired, but this host still serves the desktop app's
 * API. These tests hold that line from both sides: nothing app-like comes
 * back to a browser, and everything the desktop depends on still answers.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import request from 'supertest';

import { createApp } from '../src/app.js';
import { createKeyStore } from '../src/keys.js';
import { createStage } from '../src/stage.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const html = readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8');

const config = {
  port: 0,
  publicHost: 'zoia.example',
  roomName: 'zoia',
  trustProxy: 1,
  sessionSecret: 'x'.repeat(32),
  livekit: { apiKey: 'k', apiSecret: 's'.repeat(32), wsUrl: 'wss://s', apiUrl: 'http://s' },
};

function build() {
  const logger = { info() {}, warn() {}, error() {}, log() {} };
  const rooms = { listParticipants: async () => [], updateParticipant: async () => {} };
  return createApp({
    config,
    keyStore: createKeyStore({ file: join(PUBLIC_DIR, '..', 'test-keys-unused.json') }),
    tokenIssuer: { issue: async () => ({ token: 't', wsUrl: 'wss://s' }) },
    stage: createStage({ rooms, roomName: 'zoia', logger }),
    logger,
  });
}

describe('the retired web client', () => {
  test('the landing page carries no client script', () => {
    assert.ok(!/<script/i.test(html), 'the landing page must not load any script');
  });

  test('it points at the repository rather than pretending to be an app', () => {
    assert.match(html, /github\.com\/caiomcg\/zoia/, 'the repository link must be present');
    assert.ok(!/livekit/i.test(html), 'no trace of the client stack should remain');
  });

  test('a browser gets the static page, not an application', async () => {
    const res = await request(build()).get('/');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /html/);
    assert.ok(!/<script/i.test(res.text));
  });

  test('the desktop API is untouched, since the app still depends on it', async () => {
    const app = build();
    // Unauthenticated, so 401 is the right answer — what matters is that
    // these routes still exist rather than 404ing.
    for (const path of ['/api/session', '/api/stage']) {
      const res = await request(app).get(path);
      assert.notEqual(res.status, 404, `${path} must still be served`);
    }
    for (const path of ['/api/token', '/api/stage/claim', '/api/stage/release']) {
      const res = await request(app).post(path);
      assert.notEqual(res.status, 404, `${path} must still be served`);
    }
  });

  test('health still answers, so deployments can be checked', async () => {
    const res = await request(build()).get('/healthz');
    assert.equal(res.status, 200);
  });
});
