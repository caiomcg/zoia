/**
 * The Docker Engine API, over its unix socket, for the little the addon host
 * needs: pull an image, create, start, stop and remove a container, read its
 * state and logs. Plain `node:http`, so the host has no dependency at all:
 * this is the one container holding the Docker socket, and every package it
 * pulled in would hold it too.
 */

import { request } from 'node:http';

const API = '/v1.43';

export class DockerError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * @param {object} options
 * @param {string} [options.socketPath] the Docker socket
 */
export function createDocker({ socketPath = '/var/run/docker.sock' } = {}) {
  function call(method, path, { body, raw = false, timeoutMs = 300_000 } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = request(
        {
          socketPath,
          method,
          path: `${API}${path}`,
          headers: payload
            ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
            : {},
          timeout: timeoutMs,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const data = Buffer.concat(chunks);
            if (res.statusCode >= 400) {
              let message = data.toString('utf8');
              try {
                message = JSON.parse(message).message ?? message;
              } catch {
                // Not JSON; the text is the message.
              }
              return reject(new DockerError(res.statusCode, message));
            }
            if (raw) return resolve(data);
            const text = data.toString('utf8');
            if (!text) return resolve(null);
            try {
              resolve(JSON.parse(text));
            } catch {
              // A pull answers with a stream of JSON lines; the last says how it went.
              resolve(text);
            }
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error(`docker ${method} ${path} timed out`)));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  return {
    /**
     * Pulls `repository@sha256:…`. The answer is a stream of progress lines,
     * and a failure is one of them rather than a status, so it is looked for.
     */
    async pull(image) {
      const out = await call('POST', `/images/create?fromImage=${encodeURIComponent(image)}`);
      const lines = typeof out === 'string' ? out.trim().split('\n') : [];
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.error) throw new DockerError(500, parsed.error);
        } catch (err) {
          if (err instanceof DockerError) throw err;
        }
      }
    },

    async inspect(name) {
      try {
        return await call('GET', `/containers/${encodeURIComponent(name)}/json`);
      } catch (err) {
        if (err instanceof DockerError && err.status === 404) return null;
        throw err;
      }
    },

    create(name, config) {
      return call('POST', `/containers/create?name=${encodeURIComponent(name)}`, { body: config });
    },

    async start(name) {
      try {
        await call('POST', `/containers/${encodeURIComponent(name)}/start`);
      } catch (err) {
        // 304: already running, which is what was asked.
        if (!(err instanceof DockerError && err.status === 304)) throw err;
      }
    },

    async stop(name) {
      try {
        await call('POST', `/containers/${encodeURIComponent(name)}/stop?t=10`);
      } catch (err) {
        if (!(err instanceof DockerError && (err.status === 304 || err.status === 404))) throw err;
      }
    },

    async remove(name) {
      try {
        await call('DELETE', `/containers/${encodeURIComponent(name)}?force=true`);
      } catch (err) {
        if (!(err instanceof DockerError && err.status === 404)) throw err;
      }
    },

    /** The last `tail` lines of its output, both streams, as text. */
    async logs(name, tail = 200) {
      const data = await call(
        'GET',
        `/containers/${encodeURIComponent(name)}/logs?stdout=1&stderr=1&timestamps=1&tail=${tail}`,
        { raw: true },
      );
      return demux(data);
    },
  };
}

/**
 * A container without a terminal sends its logs multiplexed: each frame is an
 * eight-byte header (stream, three zeros, big-endian length) and its bytes.
 */
export function demux(data) {
  const parts = [];
  let offset = 0;
  while (offset + 8 <= data.length) {
    const kind = data[offset];
    const length = data.readUInt32BE(offset + 4);
    if (kind > 2 || data[offset + 1] || data[offset + 2] || data[offset + 3]) {
      // Not multiplexed after all (a container with a terminal): plain text.
      return data.toString('utf8');
    }
    parts.push(data.subarray(offset + 8, offset + 8 + length).toString('utf8'));
    offset += 8 + length;
  }
  return parts.join('');
}
