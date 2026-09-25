/** The browser client is a viewer-only surface. It may subscribe to LiveKit,
 * but it must not grow desktop publishing controls or credentials. */

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

describe('the browser viewer', () => {
  test('the page loads the viewer and LiveKit client', () => {
    assert.match(html, /<script type="module" src="viewer\.js"><\/script>/);
    assert.match(readFileSync(join(PUBLIC_DIR, 'viewer.js'), 'utf8'), /livekit-client/);
    assert.doesNotMatch(readFileSync(join(PUBLIC_DIR, 'viewer.js'), 'utf8'), /canPublish/);
  });

  test('the page explains the viewer flow', () => {
    assert.match(html, /Chave do convite/);
    assert.match(html, /Ao vivo/);
    assert.match(html, /Assistir todas/);
    assert.match(html, /Parar todas/);
  });

  test('a browser gets the viewer shell and its static assets', async () => {
    const res = await request(build()).get('/');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /html/);
    assert.match(res.text, /viewer\.js/);
    assert.equal((await request(build()).get('/viewer.js')).status, 200);
    assert.equal((await request(build()).get('/viewer.css')).status, 200);
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
