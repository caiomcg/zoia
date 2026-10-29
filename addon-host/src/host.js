/**
 * The addon host (ADR 0041): runs addon containers when the Zoia app asks.
 *
 * It is the only container given the Docker socket, so it is kept small and
 * narrow. It answers only the app, by a shared secret, on the compose network;
 * it pulls only `ghcr.io/…@sha256:…` images; and every container it starts is
 * limited the same way, whatever the addon would like:
 *
 *   - on the addons network alone, which reaches the app and the internet;
 *   - 512 MB, two CPUs, 256 processes, every capability dropped, no new
 *     privileges, a read-only root with a scratch /tmp;
 *   - no volume, no Docker socket, no host network, nothing published.
 *
 * Its environment is the addon's token and where Zoia is, and nothing else.
 */

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

/** What an image must be: from ghcr.io, by digest. Matches src/addons.js in the server. */
export const IMAGE =
  /^ghcr\.io\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+@sha256:[0-9a-f]{64}$/;
/** An addon id, as the server mints them. */
const ADDON_ID = /^[0-9a-f]{8}$/;
const TOKEN = /^zaddon_[0-9a-f]{8}_[A-Za-z0-9_-]{32,}$/;

export const LIMITS = {
  memory: 512 * 1024 * 1024,
  // Two: reading YouTube solves its JavaScript challenges, which is CPU-bound.
  nanoCpus: 2_000_000_000,
  pids: 256,
};

export const containerName = (id) => `zoia-addon-${id}`;

/** How a container is created. Exported so tests can hold it to the rules above. */
export function containerConfig({ id, image, token, network, zoiaUrl, livekitUrl }) {
  return {
    Image: image,
    Env: [
      `ZOIA_URL=${zoiaUrl}`,
      `ZOIA_ADDON_TOKEN=${token}`,
      ...(livekitUrl ? [`ZOIA_LIVEKIT_URL=${livekitUrl}`] : []),
    ],
    Labels: { 'zoia.addon': id },
    HostConfig: {
      NetworkMode: network,
      Memory: LIMITS.memory,
      MemorySwap: LIMITS.memory,
      NanoCpus: LIMITS.nanoCpus,
      PidsLimit: LIMITS.pids,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      ReadonlyRootfs: true,
      Tmpfs: { '/tmp': 'rw,nosuid,size=256m' },
      RestartPolicy: { Name: 'unless-stopped' },
      // LiveKit runs in the host's network; this is how an addon reaches it.
      ExtraHosts: ['host.docker.internal:host-gateway'],
      LogConfig: { Type: 'json-file', Config: { 'max-size': '5m', 'max-file': '2' } },
    },
  };
}

function secretMatches(given, secret) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16_384) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid JSON'), { status: 400 });
  }
}

/**
 * @param {object} options
 * @param {ReturnType<import('./docker.js').createDocker>} options.docker
 * @param {string} options.secret shared with the app, ADDON_HOST_SECRET
 * @param {string} options.network the network addon containers join
 * @param {string} options.zoiaUrl how an addon reaches the app
 * @param {string} [options.livekitUrl] how an addon reaches LiveKit
 */
export function createHost({
  docker,
  secret,
  network,
  zoiaUrl,
  livekitUrl = null,
  logger = console,
}) {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error('ADDON_HOST_SECRET must be at least 32 characters.');
  }

  async function state(id) {
    const info = await docker.inspect(containerName(id));
    if (!info) return { installed: false, running: false };
    return {
      installed: true,
      running: Boolean(info.State?.Running),
      status: info.State?.Status ?? 'unknown',
      startedAt: info.State?.StartedAt ?? null,
      restarts: info.RestartCount ?? 0,
      image: info.Config?.Image ?? null,
    };
  }

  const routes = {
    /** Pulls the image and (re)creates the container from it, running. */
    async run(id, body) {
      if (typeof body.image !== 'string' || !IMAGE.test(body.image)) {
        return [400, { error: 'invalid_image' }];
      }
      if (typeof body.token !== 'string' || !TOKEN.test(body.token)) {
        return [400, { error: 'invalid_token' }];
      }
      await docker.pull(body.image);
      await docker.remove(containerName(id));
      await docker.create(
        containerName(id),
        containerConfig({ id, image: body.image, token: body.token, network, zoiaUrl, livekitUrl }),
      );
      await docker.start(containerName(id));
      logger.info(`[host] addon ${id} running ${body.image}`);
      return [200, await state(id)];
    },
    async start(id) {
      if (!(await docker.inspect(containerName(id)))) return [404, { error: 'not_found' }];
      await docker.start(containerName(id));
      return [200, await state(id)];
    },
    async stop(id) {
      await docker.stop(containerName(id));
      logger.info(`[host] addon ${id} stopped`);
      return [200, await state(id)];
    },
    async remove(id) {
      await docker.remove(containerName(id));
      logger.info(`[host] addon ${id} removed`);
      return [200, { installed: false, running: false }];
    },
    async state(id) {
      return [200, await state(id)];
    },
    async logs(id, _body, url) {
      if (!(await docker.inspect(containerName(id)))) return [404, { error: 'not_found' }];
      const asked = Number(url.searchParams.get('tail') ?? 200);
      const tail = Number.isInteger(asked) && asked > 0 ? Math.min(asked, 2000) : 200;
      return [200, { logs: await docker.logs(containerName(id), tail) }];
    },
  };

  /** `METHOD /addons/:id[/action]` to a route, or null. */
  function route(method, path) {
    const match = /^\/addons\/([^/]+)(?:\/([a-z]+))?$/.exec(path);
    if (!match || !ADDON_ID.test(match[1])) return null;
    const [, id, action] = match;
    const table = {
      'POST run': 'run',
      'POST start': 'start',
      'POST stop': 'stop',
      'GET logs': 'logs',
      'GET ': 'state',
      'DELETE ': 'remove',
    };
    const name = table[`${method} ${action ?? ''}`];
    return name ? { id, handler: routes[name] } : null;
  }

  return createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url, 'http://host');
      if (req.method === 'GET' && url.pathname === '/healthz') return send(200, { ok: true });
      const header = req.headers.authorization ?? '';
      if (!secretMatches(header.replace(/^Bearer /, ''), secret)) {
        return send(401, { error: 'unauthenticated' });
      }
      const found = route(req.method, url.pathname);
      if (!found) return send(404, { error: 'not_found' });
      const body = req.method === 'POST' ? await readJson(req) : {};
      const [status, answer] = await found.handler(found.id, body, url);
      send(status, answer);
    } catch (err) {
      // Docker's message, never the request: a run's body holds a token.
      logger.error(`[host] ${req.method} ${req.url}: ${err.message}`);
      send(err.status && err.status < 500 ? err.status : 502, {
        error: 'docker',
        message: err.message,
      });
    }
  });
}
