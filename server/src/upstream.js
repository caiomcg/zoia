/**
 * The page is the only local piece. Joining and the room token go to the
 * server that already holds the pairing token and the LiveKit room.
 */

const PROXIED = new Set(['/api/session', '/api/token', '/api/logout']);

export function cookieForLocal(setCookie) {
  return setCookie
    .replace(/;\s*Domain=[^;]*/gi, '')
    .replace(/;\s*Secure/gi, '')
    .replace(/;\s*Partitioned/gi, '');
}

export function attachRoomProxy(app, origin) {
  const base = origin.replace(/\/$/, '');

  app.use(async (req, res, next) => {
    if (!PROXIED.has(req.path)) return next();

    try {
      const headers = { 'content-type': 'application/json' };
      if (req.headers.cookie) headers.cookie = req.headers.cookie;

      const upstream = await fetch(new URL(req.originalUrl, `${base}/`), {
        method: req.method,
        headers,
        body:
          req.method === 'GET' || req.method === 'HEAD'
            ? undefined
            : JSON.stringify(req.body ?? {}),
      });

      for (const cookie of upstream.headers.getSetCookie?.() ?? []) {
        res.append('Set-Cookie', cookieForLocal(cookie));
      }

      const text = await upstream.text();
      res.status(upstream.status);
      const type = upstream.headers.get('content-type');
      if (type) res.type(type);
      res.send(text);
    } catch (err) {
      next(err);
    }
  });
}

export async function joinUpstream({ origin, pairingToken, deviceName }) {
  const base = origin.replace(/\/$/, '');
  const pairRes = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairingToken, deviceName }),
  });
  const pairBody = await pairRes.json().catch(() => ({}));
  if (!pairRes.ok)
    return { status: pairRes.status, body: { error: pairBody.error ?? 'invalid' }, cookies: [] };

  const sessionRes = await fetch(`${base}/api/device/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceCredential: pairBody.deviceCredential }),
  });
  const sessionBody = await sessionRes.json().catch(() => ({}));
  return {
    status: sessionRes.status,
    body: sessionRes.ok
      ? { name: sessionBody.name, id: sessionBody.id }
      : { error: sessionBody.error ?? 'invalid' },
    cookies: sessionRes.headers.getSetCookie?.() ?? [],
  };
}
