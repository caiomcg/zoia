/**
 * Who is on the server (ADR 0038): the status worked out from open streams,
 * idle machines and what each person chose, and the routes that set it.
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
import { createPresence } from '../src/presence.js';
import { PASSWORD, signIn, testStores } from './people.js';

const quiet = { info() {}, warn() {}, error() {} };

describe('the status', () => {
  let choices;
  let told;
  let presence;

  beforeEach(() => {
    choices = new Map();
    told = [];
    presence = createPresence({
      chosen: async (id) => ({ presence: choices.get(id) ?? null }),
      publish: (event, data) => told.push({ event, ...data }),
      offlineGraceMs: 20,
      logger: quiet,
    });
  });

  afterEach(() => presence.close());

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  test('an open stream is online, and closing it is offline after a moment', async () => {
    const close = presence.connect('a', 'pc');
    await presence.idle();
    assert.deepEqual(presence.snapshot(), { a: 'online' });

    close();
    await presence.idle();
    assert.deepEqual(presence.snapshot(), { a: 'online' }, 'still there during the grace');
    await wait(40);
    await presence.idle();
    assert.deepEqual(presence.snapshot(), {});
    assert.deepEqual(told, [
      { event: 'presence', accountId: 'a', status: 'online' },
      { event: 'presence', accountId: 'a', status: 'offline' },
    ]);
  });

  test('a stream that comes back within the grace changes nothing', async () => {
    presence.connect('a', 'pc')();
    presence.connect('a', 'pc');
    await wait(40);
    await presence.idle();
    assert.deepEqual(presence.snapshot(), { a: 'online' });
    assert.equal(told.length, 1);
  });

  test('away only when every machine is idle', async () => {
    presence.connect('a', 'pc');
    presence.connect('a', 'laptop');
    presence.setIdle('a', 'pc', true);
    await presence.idle();
    assert.equal(presence.snapshot().a, 'online');

    presence.setIdle('a', 'laptop', true);
    await presence.idle();
    assert.equal(presence.snapshot().a, 'away');

    presence.setIdle('a', 'pc', false);
    await presence.idle();
    assert.equal(presence.snapshot().a, 'online');
  });

  test('an idle machine that disconnects no longer counts', async () => {
    presence.connect('a', 'pc');
    const closeLaptop = presence.connect('a', 'laptop');
    presence.setIdle('a', 'pc', true);
    closeLaptop();
    await presence.idle();
    assert.equal(presence.snapshot().a, 'away');
  });

  test('busy and away stay as chosen; invisible is offline to others', async () => {
    presence.connect('a', 'pc');
    choices.set('a', 'busy');
    await presence.changed('a');
    presence.setIdle('a', 'pc', true);
    await presence.idle();
    assert.equal(presence.snapshot().a, 'busy', 'idle does not undo busy');

    choices.set('a', 'away');
    await presence.changed('a');
    assert.equal(presence.snapshot().a, 'away');

    choices.set('a', 'invisible');
    await presence.changed('a');
    assert.deepEqual(presence.snapshot(), {});
    assert.equal(told.at(-1).status, 'offline');
  });

  test('idleness from a machine without a stream is ignored', async () => {
    presence.setIdle('a', 'pc', true);
    await presence.idle();
    assert.deepEqual(presence.snapshot(), {});
    assert.equal(told.length, 0);
  });
});

describe('the routes', () => {
  let dir;
  let stores;
  let app;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'zoia-presence-'));
    stores = testStores(join(dir, 'zoia.db'));
    app = createApp({
      config: {
        sessionSecret: 'test-session-secret-long-enough',
        trustProxy: 1,
        secureCookies: false,
        roomName: 'zoia',
        rateLimit: { windowMs: 60_000, limit: 1000 },
        presence: { offlineGraceMs: 20 },
      },
      accountStore: stores.accounts,
      deviceStore: stores.devices,
      chatStore: stores.chats,
      stage: createStage({
        rooms: { listParticipants: async () => [], updateParticipant: async () => {} },
        roomName: 'zoia',
        logger: quiet,
      }),
      logger: quiet,
    });
  });

  afterEach(async () => {
    await stores.db.idle();
    stores.db.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** Opens the chat's stream as `who`, on a machine of its own. */
  async function listen(server, who) {
    const agent = request.agent(app);
    const login = await agent
      .post('/api/login')
      .send({ email: who.email, password: PASSWORD, deviceName: 'Stream' });
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const { port } = server.address();
    const req = get({ port, path: '/api/chats/events', headers: { Cookie: cookie } });
    const [res] = await once(req, 'response');
    const stream = { req, text: '', agent };
    res.setEncoding('utf8');
    res.on('data', (chunk) => (stream.text += chunk));
    return stream;
  }

  async function until(check, ms = 2000) {
    const start = Date.now();
    while (!(await check())) {
      if (Date.now() - start > ms) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  const peopleOf = async (who) => (await who.agent.get('/api/presence').expect(200)).body.people;

  test('someone with the app open is online, and everyone is told', async () => {
    const server = app.listen(0);
    try {
      const ana = await signIn(app, stores.accounts, 'Ana');
      const bia = await signIn(app, stores.accounts, 'Bia');
      const watching = await listen(server, bia);

      const stream = await listen(server, ana);
      await until(() => watching.text.includes(`"accountId":"${ana.account.id}"`));
      assert.match(watching.text, new RegExp(`"accountId":"${ana.account.id}","status":"online"`));
      assert.equal((await peopleOf(bia))[ana.account.id], 'online');

      stream.req.destroy();
      await until(async () => !(ana.account.id in (await peopleOf(bia))));
      watching.req.destroy();
    } finally {
      server.close();
    }
  });

  test('a status is chosen, kept, and only the four are accepted', async () => {
    const server = app.listen(0);
    try {
      const ana = await signIn(app, stores.accounts, 'Ana');
      const bia = await signIn(app, stores.accounts, 'Bia');
      const stream = await listen(server, ana);
      await until(async () => (await peopleOf(bia))[ana.account.id] === 'online');

      await ana.agent.put('/api/presence').send({ status: 'busy' }).expect(200);
      assert.equal((await ana.agent.get('/api/presence')).body.status, 'busy');
      assert.equal((await peopleOf(bia))[ana.account.id], 'busy');
      assert.equal((await stores.accounts.get(ana.account.id)).presence, 'busy');

      await ana.agent.put('/api/presence').send({ status: 'invisible' }).expect(200);
      assert.equal((await ana.agent.get('/api/presence')).body.status, 'invisible');
      assert.equal(ana.account.id in (await peopleOf(bia)), false);

      await ana.agent.put('/api/presence').send({ status: 'online' }).expect(200);
      assert.equal((await stores.accounts.get(ana.account.id)).presence, null);

      await ana.agent.put('/api/presence').send({ status: 'sleeping' }).expect(400);
      await request(app).put('/api/presence').send({ status: 'busy' }).expect(401);
      stream.req.destroy();
    } finally {
      server.close();
    }
  });

  test('a machine that says it is idle makes its person away', async () => {
    const server = app.listen(0);
    try {
      const ana = await signIn(app, stores.accounts, 'Ana');
      const bia = await signIn(app, stores.accounts, 'Bia');
      const stream = await listen(server, ana);
      await until(async () => (await peopleOf(bia))[ana.account.id] === 'online');

      // From the machine holding the stream, which is the one that counts.
      await stream.agent.post('/api/presence/idle').send({ idle: true }).expect(200);
      await until(async () => (await peopleOf(bia))[ana.account.id] === 'away');
      await stream.agent.post('/api/presence/idle').send({ idle: false }).expect(200);
      await until(async () => (await peopleOf(bia))[ana.account.id] === 'online');

      await stream.agent.post('/api/presence/idle').send({ idle: 'yes' }).expect(400);
      stream.req.destroy();
    } finally {
      server.close();
    }
  });
});
