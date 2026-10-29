/**
 * The super admin's addon routes (ADR 0041), against a stand-in GitHub and a
 * stand-in addon host. What matters: only the super admin, only what the
 * release says, and off means off at once.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';

import { createApp } from '../src/app.js';
import { createStage } from '../src/stage.js';
import { repoOf } from '../src/addon-admin.js';
import { signIn, testStores } from './people.js';
import { memoryMessages } from './memory-messages.js';

const quiet = { info() {}, warn() {}, error() {} };
const IMAGE = `ghcr.io/caiomcg/zouve@sha256:${'d'.repeat(64)}`;

let dir;
let stores;
let app;
let release;
let host;

const manifest = (extra = {}) => ({
  id: 'zouve',
  name: 'Zouve',
  version: '1.0.0',
  image: IMAGE,
  permissions: ['chat.write', 'commands', 'bots.create', 'voice.publish'],
  commands: [{ name: 'play', description: 'Plays' }],
  settings: [
    { key: 'volume', type: 'number', label: 'Volume', default: 50, min: 0, max: 100 },
    { key: 'secret', type: 'secret', label: 'Secret' },
  ],
  ...extra,
});

/** GitHub, as far as the routes read it: a latest release and its manifest asset. */
async function github(url) {
  if (url.endsWith('/releases/latest')) {
    if (!release) return new Response('', { status: 404 });
    return Response.json({
      tag_name: `v${release.version}`,
      html_url: 'https://github.com/caiomcg/zouve/releases/latest',
      assets: [{ name: 'zoia-addon.json', browser_download_url: 'https://dl/zoia-addon.json' }],
    });
  }
  if (url === 'https://dl/zoia-addon.json') return new Response(JSON.stringify(release));
  return new Response('', { status: 404 });
}

/** The addon host, remembering what it was asked. */
function fakeHost() {
  const calls = [];
  const running = new Map();
  return {
    calls,
    running,
    fail: false,
    async run(id, { image, token }) {
      calls.push(['run', id, image, token]);
      if (this.fail) return { ok: false, reason: 'host_failed', message: 'pull failed' };
      running.set(id, token);
      return { ok: true, running: true };
    },
    async start(id) {
      calls.push(['start', id]);
      return { ok: true };
    },
    async stop(id) {
      calls.push(['stop', id]);
      running.delete(id);
      return { ok: true };
    },
    async remove(id) {
      calls.push(['remove', id]);
      running.delete(id);
      return { ok: true };
    },
    async state(id) {
      return { ok: true, installed: running.has(id), running: running.has(id) };
    },
    async logs() {
      return { ok: true, logs: 'hello\n' };
    },
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zoia-addon-admin-'));
  stores = testStores(join(dir, 'zoia.db'));
  await stores.chats.ready;
  release = manifest();
  host = fakeHost();
  app = createApp({
    config: {
      sessionSecret: 'test-session-secret-long-enough',
      trustProxy: 1,
      secureCookies: false,
      roomName: 'zoia',
      rateLimit: { windowMs: 60_000, limit: 1000 },
      addons: { githubApi: 'https://gh', limit: { windowMs: 60_000, limit: 1000 } },
    },
    accountStore: stores.accounts,
    deviceStore: stores.devices,
    chatStore: stores.chats,
    addonStore: stores.addons,
    addonHost: host,
    githubFetch: github,
    messageStore: () => memoryMessages(),
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

const superAdmin = () => signIn(app, stores.accounts, 'Su', { role: 'super_admin' });

async function installed(su) {
  const res = await su.agent
    .post('/api/admin/addons')
    .send({ repo: 'caiomcg/zouve', version: '1.0.0' })
    .expect(201);
  return res.body.addon;
}

test('a repository is owner/name, or its GitHub address', () => {
  assert.equal(repoOf('https://github.com/caiomcg/zouve'), 'caiomcg/zouve');
  assert.equal(repoOf('caiomcg/zouve.git'), 'caiomcg/zouve');
  assert.equal(repoOf('https://gitlab.com/caiomcg/zouve'), null);
  assert.equal(repoOf('caiomcg'), null);
  assert.equal(repoOf('../../etc'), null);
});

describe('who may', () => {
  test('only the super admin, not an admin, not a user', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    const bia = await signIn(app, stores.accounts, 'Bia', { role: 'admin' });
    for (const who of [ana, bia]) {
      await who.agent.get('/api/admin/addons').expect(403);
      await who.agent.post('/api/admin/addons/preview').send({ repo: 'caiomcg/zouve' }).expect(403);
      await who.agent.post('/api/admin/addons').send({ repo: 'caiomcg/zouve' }).expect(403);
    }
    await request(app).get('/api/admin/addons').expect(401);
  });
});

describe('installing', () => {
  test('the preview shows the release and what it asks for, and installs nothing', async () => {
    const su = await superAdmin();
    const { body } = await su.agent
      .post('/api/admin/addons/preview')
      .send({ repo: 'https://github.com/caiomcg/zouve' })
      .expect(200);
    assert.equal(body.addon.version, '1.0.0');
    assert.ok(body.addon.permissions.every((p) => p.description));
    assert.deepEqual(await stores.addons.list(), []);
  });

  test('installs, starts it with its token, and enables it', async () => {
    const su = await superAdmin();
    const addon = await installed(su);
    assert.equal(addon.enabled, true);
    const [call] = host.calls;
    assert.equal(call[0], 'run');
    assert.equal(call[2], IMAGE);
    assert.equal((await stores.addons.authenticate(call[3])).id, addon.id);
  });

  test('a release that changed since the preview is not installed', async () => {
    const su = await superAdmin();
    release = manifest({ version: '1.0.1' });
    await su.agent
      .post('/api/admin/addons')
      .send({ repo: 'caiomcg/zouve', version: '1.0.0' })
      .expect(409);
    assert.deepEqual(await stores.addons.list(), []);
  });

  test('an image under another owner than the repository is refused', async () => {
    const su = await superAdmin();
    release = manifest({ image: `ghcr.io/someone-else/zouve@sha256:${'d'.repeat(64)}` });
    const res = await su.agent
      .post('/api/admin/addons/preview')
      .send({ repo: 'caiomcg/zouve' })
      .expect(400);
    assert.equal(res.body.field, 'image');
  });

  test('no release, or no manifest in it, says so', async () => {
    const su = await superAdmin();
    release = null;
    const res = await su.agent.post('/api/admin/addons/preview').send({ repo: 'caiomcg/zouve' });
    assert.equal(res.body.error, 'no_release');
  });

  test('when the host fails, it stays installed and off', async () => {
    const su = await superAdmin();
    host.fail = true;
    const res = await su.agent
      .post('/api/admin/addons')
      .send({ repo: 'caiomcg/zouve', version: '1.0.0' })
      .expect(502);
    assert.equal(res.body.addon.enabled, false);
  });
});

describe('running', () => {
  test('disabling refuses its token at once and stops it', async () => {
    const su = await superAdmin();
    const addon = await installed(su);
    const token = host.running.get(addon.id);
    await request(app).get('/api/addon/v1/me').set('Authorization', `Bearer ${token}`).expect(200);
    await su.agent.post(`/api/admin/addons/${addon.id}/disable`).expect(200);
    await request(app).get('/api/addon/v1/me').set('Authorization', `Bearer ${token}`).expect(403);
    assert.ok(host.calls.some(([c, id]) => c === 'stop' && id === addon.id));
  });

  test('enabling again gives it a new token; the old one is refused', async () => {
    const su = await superAdmin();
    const addon = await installed(su);
    const old = host.running.get(addon.id);
    await su.agent.post(`/api/admin/addons/${addon.id}/disable`).expect(200);
    await su.agent.post(`/api/admin/addons/${addon.id}/enable`).expect(200);
    const fresh = host.running.get(addon.id);
    assert.notEqual(fresh, old);
    await request(app).get('/api/addon/v1/me').set('Authorization', `Bearer ${old}`).expect(401);
    await request(app).get('/api/addon/v1/me').set('Authorization', `Bearer ${fresh}`).expect(200);
  });

  test('updating to a release asking for more needs it granted', async () => {
    const su = await superAdmin();
    const addon = await installed(su);
    await su.agent.post(`/api/admin/addons/${addon.id}/update`).expect(409);
    release = manifest({
      version: '1.1.0',
      permissions: [...manifest().permissions, 'users.manage'],
    });
    const asked = await su.agent.post(`/api/admin/addons/${addon.id}/update`).expect(409);
    assert.equal(asked.body.error, 'needs_permissions');
    assert.deepEqual(
      asked.body.added.map((p) => p.id),
      ['users.manage'],
    );
    const done = await su.agent
      .post(`/api/admin/addons/${addon.id}/update`)
      .send({ grant: true })
      .expect(200);
    assert.equal(done.body.addon.version, '1.1.0');
  });

  test('uninstalling removes its container and its bots', async () => {
    const su = await superAdmin();
    const addon = await installed(su);
    await stores.accounts.createBot({ addonId: addon.id, name: 'Zouve' });
    await su.agent.delete(`/api/admin/addons/${addon.id}`).expect(200);
    assert.ok(host.calls.some(([c]) => c === 'remove'));
    assert.deepEqual(await stores.accounts.botsOf(addon.id), []);
    assert.deepEqual(await stores.addons.list(), []);
  });
});

describe('configuring', () => {
  test('settings are checked, and a secret is never shown back', async () => {
    const su = await superAdmin();
    const addon = await installed(su);
    await su.agent
      .put(`/api/admin/addons/${addon.id}/settings`)
      .send({ values: { volume: 500 } })
      .expect(400);
    const { body } = await su.agent
      .put(`/api/admin/addons/${addon.id}/settings`)
      .send({ values: { volume: 70, secret: 'hunter2' } })
      .expect(200);
    assert.deepEqual(body.addon.settings.values, { volume: 70, secret: { set: true } });
    const listed = await su.agent.get('/api/admin/addons').expect(200);
    assert.equal(JSON.stringify(listed.body).includes('hunter2'), false);
  });

  test('commands are renamed for everyone, and bound to chats', async () => {
    const su = await superAdmin();
    const ana = await signIn(app, stores.accounts, 'Ana');
    const addon = await installed(su);
    const chat = (await stores.chats.list())[0];
    await su.agent
      .put(`/api/admin/addons/${addon.id}/chats`)
      .send({ chats: [chat.id] })
      .expect(200);
    await su.agent
      .put(`/api/admin/addons/${addon.id}/commands`)
      .send({ names: { play: 'tocar' } })
      .expect(200);
    const { body } = await ana.agent.get(`/api/chats/${chat.id}/commands`).expect(200);
    assert.deepEqual(
      body.commands.map((c) => c.name),
      ['tocar'],
    );
  });
});
