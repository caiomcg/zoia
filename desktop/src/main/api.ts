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
import type { TokenResult, StageState, ClaimResult, WhipEndpoint } from '../shared/ipc';
import { getServerUrl } from './config';

class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`request failed: ${status}`);
  }
}

/**
 * Thrown when nothing has told this copy of Zoia which server to talk to. It
 * is a state the app can be in from launch — a release build carries no URL —
 * so it is a first-class outcome here rather than a crash somewhere downstream.
 */
export class NoServerError extends Error {
  override name = 'NoServerError';
  constructor() {
    super('No server is configured. Add an invite to connect.');
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  // Read per request, not once at module load. The URL is resolved at startup
  // from an invite, and can change again when a stored credential names the
  // server it was paired against — a module constant captured whichever value
  // happened to exist when this file was first imported.
  const base = getServerUrl();
  if (!base) throw new NoServerError();

  const res = await net.fetch(`${base}${path}`, {
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

export function getToken() {
  return call<TokenResult>('/api/token', { method: 'POST' });
}

/**
 * Where to publish a hardware-encoded broadcast, and a token to do it with.
 * The server only answers for a participant with its own broadcast slot.
 */
export function whipGet() {
  return call<WhipEndpoint>('/api/whip', { method: 'POST' });
}

/** Removes this device's WHIP publisher from the room, if it is still there. */
export function whipRelease() {
  return call<{ ok: boolean; released: boolean }>('/api/whip/release', { method: 'POST' });
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

export async function stageClaim(_force = false): Promise<ClaimResult> {
  try {
    const result = await call<{ ok: true; broadcaster: NonNullable<ClaimResult['broadcaster']> }>(
      '/api/stage/claim',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
    );
    return { ok: true, broadcaster: result.broadcaster };
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      return { ok: false };
    }
    throw err;
  }
}

export function stageRelease() {
  return call<{ ok: boolean; released?: boolean }>('/api/stage/release', { method: 'POST' });
}
