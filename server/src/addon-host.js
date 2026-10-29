/**
 * The app's side of the addon host (addon-host/, ADR 0041): asks it to run,
 * stop and remove addon containers, and to read their state and logs.
 *
 * Every failure becomes `{ ok: false, reason }`, never a throw: the host being
 * down must not take the admin routes with it, only say so.
 */

export function createAddonHostClient({ url, secret, fetchImpl = fetch, timeoutMs = 300_000 }) {
  async function call(method, path, body) {
    let res;
    try {
      res = await fetchImpl(`${url.replace(/\/+$/, '')}${path}`, {
        method,
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { ok: false, reason: 'host_unreachable' };
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: 'host_failed', message: data.message ?? data.error };
    return { ok: true, ...data };
  }

  return {
    /** Pulls the image and runs the addon from it, replacing what ran before. */
    run: (id, { image, token }) => call('POST', `/addons/${id}/run`, { image, token }),
    start: (id) => call('POST', `/addons/${id}/start`),
    stop: (id) => call('POST', `/addons/${id}/stop`),
    remove: (id) => call('DELETE', `/addons/${id}`),
    state: (id) => call('GET', `/addons/${id}`),
    logs: (id, tail = 200) => call('GET', `/addons/${id}/logs?tail=${tail}`),
  };
}
