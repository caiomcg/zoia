/**
 * The example addon in docs/addons/example, run against a real app: so the
 * documentation's own addon is known to work, and stays working as the API
 * changes. Its manifest must pass too, as a release would publish it.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/app.js';
import { createStage } from '../src/stage.js';
import { validateManifest } from '../src/addons.js';
import { createEchoAddon } from '../../docs/addons/example/src/addon.js';
import { signIn, testStores } from './people.js';
import { memoryMessages } from './memory-messages.js';

const quiet = { info() {}, warn() {}, error() {} };

let dir;
let stores;
let messages;
let app;
let server;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zoia-addon-example-'));
  stores = testStores(join(dir, 'zoia.db'));
  await stores.chats.ready;
  messages = memoryMessages();
  app = createApp({
    config: {
      sessionSecret: 'test-session-secret-long-enough',
      trustProxy: 1,
      secureCookies: false,
      roomName: 'zoia',
      rateLimit: { windowMs: 60_000, limit: 1000 },
      addons: { limit: { windowMs: 60_000, limit: 1000 } },
    },
    accountStore: stores.accounts,
    deviceStore: stores.devices,
    chatStore: stores.chats,
    addonStore: stores.addons,
    messageStore: () => messages,
    stage: createStage({
      rooms: { listParticipants: async () => [], updateParticipant: async () => {} },
      roomName: 'zoia',
      logger: quiet,
    }),
    logger: quiet,
  });
  server = app.listen(0);
  await once(server, 'listening');
});

afterEach(async () => {
  server.closeAllConnections?.();
  server.close();
  await stores.db.idle();
  stores.db.close();
  await rm(dir, { recursive: true, force: true });
});

async function until(check, ms = 3000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('its manifest is valid once the release fills in the image', async () => {
  const raw = JSON.parse(
    await readFile(new URL('../../docs/addons/example/zoia-addon.json', import.meta.url), 'utf8'),
  );
  raw.image = `ghcr.io/someone/zoia-echo@sha256:${'e'.repeat(64)}`;
  const result = validateManifest(raw);
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('Echo answers !echo in its chat, as its bot, replying to the message', async () => {
  const raw = JSON.parse(
    await readFile(new URL('../../docs/addons/example/zoia-addon.json', import.meta.url), 'utf8'),
  );
  raw.image = `ghcr.io/someone/zoia-echo@sha256:${'e'.repeat(64)}`;
  const { manifest } = validateManifest(raw);
  const { addon, token } = await stores.addons.install({ repo: 'someone/zoia-echo', manifest });
  await stores.addons.setEnabled(addon.id, true);
  const chat = (await stores.chats.list())[0];
  await stores.addons.setBindings(addon.id, [chat.id]);

  const echo = createEchoAddon({
    zoiaUrl: `http://127.0.0.1:${server.address().port}`,
    token,
    logger: quiet,
  });
  const running = echo.run({ once: true });
  try {
    await until(() => echo.bot !== null);
    // Its stream must be open before anyone types, or the command is missed.
    await new Promise((r) => setTimeout(r, 100));
    const ana = await signIn(app, stores.accounts, 'Ana');
    const sent = await ana.agent
      .post(`/api/chats/${chat.id}/messages`)
      .send({ body: '!echo olá, mundo' })
      .expect(201);

    let answer;
    await until(async () => {
      const page = await messages.page({ chatId: chat.id, limit: 10 });
      answer = page.find((m) => m.authorId === echo.bot.id);
      return Boolean(answer);
    });
    assert.equal(answer.body, 'olá, mundo');
    assert.equal(answer.replyTo.id, sent.body.message.id);
  } finally {
    echo.stop();
    await running;
  }
});
