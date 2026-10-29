/**
 * The addon host against a stand-in Docker Engine on a real unix socket. What
 * matters is what it refuses — anyone without the secret, an image not pinned
 * by digest, an id that is not one — and that every container it makes is
 * held to the same limits.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDocker, demux } from '../src/docker.js';
import { createHost, containerConfig, LIMITS } from '../src/host.js';

const SECRET = 's'.repeat(40);
const IMAGE = `ghcr.io/caiomcg/zouve@sha256:${'c'.repeat(64)}`;
const TOKEN = `zaddon_0a1b2c3d_${'t'.repeat(43)}`;
const quiet = { info() {}, warn() {}, error() {} };

let dir;
let engine;
let calls;
let containers;
let host;
let base;

/** A Docker Engine that remembers what it was asked, and keeps containers. */
async function startEngine(socketPath) {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    const url = new URL(req.url, 'http://docker');
    calls.push({ method: req.method, path: url.pathname, query: url.searchParams, body });
    const name = decodeURIComponent(url.pathname.split('/')[3] ?? '');
    const json = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(data === undefined ? '' : JSON.stringify(data));
    };
    if (url.pathname.endsWith('/images/create')) {
      return res.end('{"status":"Pulling"}\n{"status":"Downloaded"}\n');
    }
    if (url.pathname.endsWith('/containers/create')) {
      containers.set(url.searchParams.get('name'), { config: body, running: false });
      return json(201, { Id: 'abc' });
    }
    const container = containers.get(name);
    if (!container) return json(404, { message: 'No such container' });
    if (req.method === 'POST' && url.pathname.endsWith('/start')) {
      container.running = true;
      return json(204);
    }
    if (req.method === 'POST' && url.pathname.endsWith('/stop')) {
      container.running = false;
      return json(204);
    }
    if (req.method === 'DELETE') {
      containers.delete(name);
      return json(204);
    }
    if (url.pathname.endsWith('/logs')) {
      const line = Buffer.from('hello from the addon\n');
      const header = Buffer.from([1, 0, 0, 0, 0, 0, 0, line.length]);
      return res.end(Buffer.concat([header, line]));
    }
    if (url.pathname.endsWith('/json')) {
      return json(200, {
        State: { Running: container.running, Status: container.running ? 'running' : 'exited' },
        Config: { Image: container.config.Image },
        RestartCount: 0,
      });
    }
    json(404, { message: 'unknown' });
  });
  server.listen(socketPath);
  await once(server, 'listening');
  return server;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zoia-host-'));
  calls = [];
  containers = new Map();
  // Windows has no unix sockets in Node; a named pipe stands in, as Docker
  // Desktop's own does.
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\zoia-docker-${process.pid}-${Date.now()}`
      : join(dir, 'docker.sock');
  engine = await startEngine(socketPath);
  host = createHost({
    docker: createDocker({ socketPath }),
    secret: SECRET,
    network: 'zoia-addons',
    zoiaUrl: 'http://app:3000',
    livekitUrl: 'ws://host.docker.internal:7880',
    logger: quiet,
  }).listen(0);
  await once(host, 'listening');
  base = `http://127.0.0.1:${host.address().port}`;
});

afterEach(async () => {
  host.close();
  engine.close();
  await rm(dir, { recursive: true, force: true });
});

const ask = (method, path, body, secret = SECRET) =>
  fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

describe('who may ask', () => {
  test('without the secret, nothing', async () => {
    assert.equal((await ask('GET', '/addons/0a1b2c3d', null, 'wrong')).status, 401);
    assert.equal((await fetch(`${base}/addons/0a1b2c3d`)).status, 401);
    assert.equal(calls.length, 0);
  });

  test('a short secret will not start', () => {
    assert.throws(() => createHost({ docker: {}, secret: 'short', network: 'n', zoiaUrl: 'x' }));
  });

  test('an id that is not an addon id is not a route', async () => {
    assert.equal((await ask('POST', '/addons/..%2Fetc/run', {})).status, 404);
    assert.equal((await ask('POST', '/addons/zoia-app/stop')).status, 404);
  });
});

describe('running an addon', () => {
  test('only an image from ghcr.io pinned by digest is pulled', async () => {
    for (const image of [
      'ghcr.io/caiomcg/zouve:latest',
      `docker.io/library/alpine@sha256:${'c'.repeat(64)}`,
      'alpine',
    ]) {
      const res = await ask('POST', '/addons/0a1b2c3d/run', { image, token: TOKEN });
      assert.equal(res.status, 400, image);
    }
    assert.equal(calls.length, 0);
  });

  test('pulls, replaces and starts it, limited, with its token and nothing else', async () => {
    const res = await ask('POST', '/addons/0a1b2c3d/run', { image: IMAGE, token: TOKEN });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).running, true);
    const pull = calls.find((c) => c.path.endsWith('/images/create'));
    assert.equal(pull.query.get('fromImage'), IMAGE);
    const { config } = containers.get('zoia-addon-0a1b2c3d');
    assert.deepEqual(config.Env.sort(), [
      'ZOIA_ADDON_TOKEN=' + TOKEN,
      'ZOIA_LIVEKIT_URL=ws://host.docker.internal:7880',
      'ZOIA_URL=http://app:3000',
    ]);
    assert.equal(config.HostConfig.NetworkMode, 'zoia-addons');
    assert.equal(config.HostConfig.Memory, LIMITS.memory);
    assert.deepEqual(config.HostConfig.CapDrop, ['ALL']);
    assert.equal(config.HostConfig.Binds, undefined, 'no volumes');
    assert.equal(config.HostConfig.Privileged, undefined);
  });

  test('stops, starts again, says how it is, and goes', async () => {
    await ask('POST', '/addons/0a1b2c3d/run', { image: IMAGE, token: TOKEN });
    assert.equal((await (await ask('POST', '/addons/0a1b2c3d/stop')).json()).running, false);
    assert.equal((await (await ask('POST', '/addons/0a1b2c3d/start')).json()).running, true);
    const logs = await (await ask('GET', '/addons/0a1b2c3d/logs?tail=10')).json();
    assert.equal(logs.logs, 'hello from the addon\n');
    await ask('DELETE', '/addons/0a1b2c3d');
    assert.equal((await (await ask('GET', '/addons/0a1b2c3d')).json()).installed, false);
  });
});

describe('the container rules', () => {
  test('hold for any addon, whatever it asks', () => {
    const config = containerConfig({
      id: '0a1b2c3d',
      image: IMAGE,
      token: TOKEN,
      network: 'zoia-addons',
      zoiaUrl: 'http://app:3000',
    });
    const { HostConfig: h } = config;
    assert.ok(h.SecurityOpt.includes('no-new-privileges'));
    assert.equal(h.ReadonlyRootfs, true);
    assert.equal(h.NanoCpus, LIMITS.nanoCpus);
    assert.equal(h.PidsLimit, LIMITS.pids);
    assert.notEqual(h.NetworkMode, 'host');
    assert.equal(JSON.stringify(config).includes('docker.sock'), false);
  });
});

test('logs of a container with a terminal are read as they are', () => {
  assert.equal(demux(Buffer.from('plain text output here\n')), 'plain text output here\n');
});
