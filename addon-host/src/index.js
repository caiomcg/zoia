/**
 * Starts the addon host. See src/host.js and ADR 0041.
 */

import { createDocker } from './docker.js';
import { createHost } from './host.js';

const env = process.env;

const host = createHost({
  docker: createDocker({ socketPath: env.DOCKER_SOCKET ?? '/var/run/docker.sock' }),
  secret: env.ADDON_HOST_SECRET,
  network: env.ADDON_NETWORK ?? 'zoia-addons',
  zoiaUrl: env.ZOIA_INTERNAL_URL ?? 'http://app:3000',
  livekitUrl: env.ZOIA_LIVEKIT_URL ?? 'ws://host.docker.internal:7880',
});

const port = Number(env.PORT ?? 3100);
host.listen(port, () => console.log(`[host] listening on :${port}`));
