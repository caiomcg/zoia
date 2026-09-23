/**
 * All HTTP communication with the Zoia server lives here, in the main
 * process, using Electron's `net.fetch` on the default session. That session
 * owns the cookie jar, so the session cookie `POST /api/device/session` sets
 * is stored and replayed automatically on every later request — the same
 * cookie-based auth the web client uses, with no server changes and no
 * cookie handling of our own to get wrong.
 *
 * The renderer never sees the pairing token, the device credential, or the
 * session cookie. It only ever receives what it needs: a LiveKit token, or a
 * stage result.
 */

import { net } from 'electron';
import type { TokenResult, StageState, ClaimResult, IngressEndpoint } from '../shared/ipc';

const BASE = __ZOIA_SERVER_URL__;

class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`request failed: ${status}`);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await net.fetch(`${BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...init.headers },
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

export { ApiError };

export function pair(pairingToken: string, deviceName: string) {
  return call<{ deviceCredential: string; deviceId: string; name: string }>('/api/pair', {
    method: 'POST',
    body: JSON.stringify({ pairingToken, deviceName }),
  });
}

export function deviceSession(deviceCredential: string) {
  return call<{ name: string; id: string }>('/api/device/session', {
    method: 'POST',
    body: JSON.stringify({ deviceCredential }),
  });
}

export function getSession() {
  return call<{ name: string; id: string }>('/api/session');
}

export function getToken() {
  return call<TokenResult>('/api/token', { method: 'POST' });
}

/** Somewhere to publish NVENC output to; see src/main/nvenc.ts for why. */
export function ingressGet() {
  return call<IngressEndpoint>('/api/ingress', { method: 'POST' });
}

export function ingressRelease() {
  return call<{ ok: boolean; released: boolean }>('/api/ingress/release', { method: 'POST' });
}

/**
 * Ships a crash to the server.
 *
 * Failures kept arriving as screenshots of a dialog, relayed from someone
 * else's machine, hours later. Swallows its own errors: a reporter that
 * throws would be one more crash nobody can see.
 */
export function report(entry: { kind: string; message: string; stack?: string; context?: string }) {
  return call<{ ok: boolean }>('/api/report', {
    method: 'POST',
    body: JSON.stringify({ ...entry, appVersion: process.env.npm_package_version ?? 'dev' }),
    headers: { 'content-type': 'application/json' },
  }).catch(() => undefined);
}

export function renameDevice(name: string) {
  return call<{ ok: boolean; name: string }>('/api/name', {
    method: 'POST',
    body: JSON.stringify({ name }),
    headers: { 'content-type': 'application/json' },
  });
}

export function stageGet() {
  return call<StageState>('/api/stage');
}

/** A 409 (stage busy) is an expected outcome, not a failure — it carries the holder. */
export async function stageClaim(force = false): Promise<ClaimResult> {
  try {
    const result = await call<{ ok: true; holder: ClaimResult['holder'] }>('/api/stage/claim', {
      method: 'POST',
      body: JSON.stringify({ force }),
      headers: { 'content-type': 'application/json' },
    });
    return { ok: true, holder: result.holder };
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      const body = err.body as { holder?: ClaimResult['holder'] };
      return { ok: false, holder: body.holder ?? null };
    }
    throw err;
  }
}

export function stageRelease() {
  return call<{ ok: boolean; released?: boolean }>('/api/stage/release', { method: 'POST' });
}
