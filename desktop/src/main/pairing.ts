/**
 * Pairing orchestration: turn the embedded pairing token into a working
 * session, once per machine, and re-establish that session on every launch.
 *
 * The credential is spent once (see credential-store.ts); after that, this
 * module's job on every subsequent launch is just to prove the stored
 * credential still works, since it may have been revoked since the last run.
 */

import { hostname } from 'node:os';
import * as api from './api';
import { ApiError } from './api';
import { loadCredential, saveCredential, clearCredential } from './credential-store';
import type { PairingStatus } from '../shared/ipc';

let status: PairingStatus = { paired: false, deviceName: null, error: null };

export function getStatus(): PairingStatus {
  return status;
}

/**
 * Called once at startup. If a credential is already stored, replays it to
 * establish this run's session cookie. A rejection here almost always means
 * the device was revoked, so the stored credential is cleared rather than
 * retried forever.
 */
export async function restoreSession(): Promise<PairingStatus> {
  const stored = await loadCredential();
  if (!stored) {
    status = { paired: false, deviceName: null, error: null };
    return status;
  }

  try {
    const { name } = await api.deviceSession(stored.deviceCredential);
    status = { paired: true, deviceName: name, error: null };
  } catch (err) {
    await clearCredential();
    const message =
      err instanceof ApiError && err.status === 401
        ? 'This device was removed. Pair again to continue.'
        : `Could not reach the server: ${(err as Error).message}`;
    status = { paired: false, deviceName: null, error: message };
  }
  return status;
}

/**
 * Spends the embedded pairing token for a device credential, stores it, and
 * establishes the session. `deviceName` defaults to the machine's hostname —
 * it exists so an admin's `keytool device:list` output means something.
 */
export async function pair(deviceName?: string): Promise<PairingStatus> {
  if (!__ZOIA_PAIRING_TOKEN__) {
    status = {
      paired: false,
      deviceName: null,
      error: 'This build has no pairing token embedded.',
    };
    return status;
  }

  const name = deviceName?.trim() || hostname();

  try {
    const result = await api.pair(__ZOIA_PAIRING_TOKEN__, name);
    await saveCredential({
      deviceId: result.deviceId,
      deviceCredential: result.deviceCredential,
      deviceName: result.name,
    });
    // Spends the pairing activation; still need the actual session cookie.
    await api.deviceSession(result.deviceCredential);
    status = { paired: true, deviceName: result.name, error: null };
  } catch (err) {
    const message =
      err instanceof ApiError
        ? pairingErrorMessage(err)
        : `Could not reach the server: ${(err as Error).message}`;
    status = { paired: false, deviceName: null, error: message };
  }
  return status;
}

function pairingErrorMessage(err: ApiError): string {
  const code = (err.body as { error?: string })?.error;
  switch (code) {
    case 'invalid':
      return 'This build’s pairing token was not accepted. It may have been revoked.';
    case 'exhausted':
      return 'This pairing token has reached its device limit.';
    case 'device_name_required':
      return 'A device name is required.';
    default:
      return `Pairing failed (${err.status}).`;
  }
}
