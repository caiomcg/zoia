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
import type {
  TokenResult,
  StageState,
  ClaimResult,
  WhipEndpoint,
  RoomInfo,
  ChannelOutcome,
} from '../shared/ipc';
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

/**
 * The channel this device last joined. Stage and WHIP calls are always about
 * it, which is what keeps the hardware path (whose WHIP token main fetches
 * itself) publishing into the channel the renderer is actually in.
 */
let currentRoom: string | undefined;

export async function getToken(room?: string) {
  const result = await call<TokenResult>('/api/token', {
    method: 'POST',
    body: JSON.stringify(room ? { room } : {}),
  });
  currentRoom = result.room;
  return result;
}

export function roomsList() {
  return call<{ rooms: RoomInfo[]; max: number }>('/api/rooms');
}

/**
 * A refusal the user should hear about (the channel limit, an occupied
 * channel) comes back as its error code rather than thrown: an error crossing
 * IPC arrives in the renderer as a message string, without the server's body.
 */
async function outcome(request: Promise<unknown>): Promise<ChannelOutcome> {
  try {
    await request;
    return { ok: true };
  } catch (err) {
    if (err instanceof ApiError && err.status < 500) {
      const code = (err.body as { error?: string } | null)?.error;
      return { ok: false, error: code ?? `http_${err.status}` };
    }
    throw err;
  }
}

export function roomsCreate(name: string) {
  return outcome(call('/api/rooms', { method: 'POST', body: JSON.stringify({ name }) }));
}

export function roomsRename(id: string, name: string) {
  return outcome(
    call(`/api/rooms/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
  );
}

export function roomsRemove(id: string) {
  return outcome(call(`/api/rooms/${encodeURIComponent(id)}`, { method: 'DELETE' }));
}

/**
 * Where to publish a hardware-encoded broadcast, and a token to do it with.
 * The server only answers for a participant with its own broadcast slot.
 */
export function whipGet(source?: { sourceName?: string; sourceKind?: string }) {
  return call<WhipEndpoint>('/api/whip', {
    method: 'POST',
    body: JSON.stringify({ ...source, room: currentRoom }),
  });
}

/** Removes this device's WHIP publisher from the room, if it is still there. */
export function whipRelease() {
  return call<{ ok: boolean; released: boolean }>('/api/whip/release', {
    method: 'POST',
    body: JSON.stringify({ room: currentRoom }),
  });
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
  const query = currentRoom ? `?room=${encodeURIComponent(currentRoom)}` : '';
  return call<StageState>(`/api/stage${query}`);
}

export async function stageClaim(): Promise<ClaimResult> {
  try {
    const result = await call<{ ok: true; broadcaster: NonNullable<ClaimResult['broadcaster']> }>(
      '/api/stage/claim',
      {
        method: 'POST',
        body: JSON.stringify({ room: currentRoom }),
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
  return call<{ ok: boolean; released?: boolean }>('/api/stage/release', {
    method: 'POST',
    body: JSON.stringify({ room: currentRoom }),
  });
}
