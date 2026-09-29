/**
 * Pairing orchestration: turn an invitation into a working session, once per
 * machine, and re-establish that session on every launch.
 *
 * The invitation used to be compiled into the binary; it now normally arrives
 * as an invite file, because a published build cannot carry a secret (see
 * src/main/config.ts). Either way the shape is the same: it is spent once for
 * a per-device credential, and after that this module's job on every launch is
 * just to prove that credential still works, since it may have been revoked.
 */

import { hostname } from 'node:os';
import * as api from './api';
import { ApiError, NoServerError } from './api';
import * as config from './config';
import { t } from './language';
import { loadCredential, saveCredential, clearCredential } from './credential-store';
import type { PairingStatus } from '../shared/ipc';

let status: PairingStatus = {
  paired: false,
  deviceName: null,
  error: null,
  serverUrl: null,
  needsInvite: true,
};

export function getStatus(): PairingStatus {
  return status;
}

// Settled once restoreSession has run. Until then `status` is only a
// placeholder, and answering with it made the pairing screen flash on every
// launch of an already-paired machine.
let markRestored: () => void = () => {};
const restored = new Promise<void>((resolve) => {
  markRestored = resolve;
});

/** The status, once the stored credential has been checked. */
export async function getRestoredStatus(): Promise<PairingStatus> {
  await restored;
  return status;
}

/** Folds the current config into the status the UI renders. */
function unpaired(error: string | null): PairingStatus {
  const resolved = config.describe();
  return {
    paired: false,
    deviceName: null,
    error: error ?? resolved.error,
    serverUrl: resolved.serverUrl,
    // An invite is needed when nothing has supplied a server and a token.
    needsInvite: !resolved.serverUrl || !resolved.hasPairingToken,
  };
}

/**
 * Called once at startup. If a credential is already stored, replays it to
 * establish this run's session cookie.
 */
export async function restoreSession(): Promise<PairingStatus> {
  try {
    return await restore();
  } finally {
    markRestored();
  }
}

async function restore(): Promise<PairingStatus> {
  const stored = await loadCredential();
  if (!stored) {
    status = unpaired(null);
    return status;
  }

  // The credential is only valid at the server that issued it, so that server
  // wins over any invite still sitting next to the exe. Records written before
  // invites existed carry no URL, and fall back to whatever config resolved.
  if (stored.serverUrl) config.useCredentialServer(stored.serverUrl);

  // A credential from a build that had its server compiled in, now running in
  // a build that does not. The credential is probably still good, but there is
  // nowhere to present it, and an invite for the same server is what fixes it.
  if (!config.getServerUrl()) {
    status = unpaired(t('pair.error.noServer'));
    return status;
  }

  try {
    const { name, id, avatar } = await api.deviceSession(stored.deviceCredential);
    status = {
      paired: true,
      deviceName: name,
      error: null,
      serverUrl: config.getServerUrl(),
      needsInvite: false,
      deviceId: id,
      avatar: avatar ?? null,
    };
  } catch (err) {
    // Only a 401 means "this device is gone". Anything else — the server being
    // down, a laptop opened on a train, DNS not up yet — is temporary, and
    // deleting the credential for it would un-pair a working machine and
    // demand a fresh invite the user almost certainly no longer has. This
    // previously cleared on *any* failure, so a brief server outage un-paired
    // everybody at once.
    if (err instanceof ApiError && err.status === 401) {
      await clearCredential();
      status = unpaired(t('pair.error.removed'));
      return status;
    }

    status = {
      paired: false,
      deviceName: stored.deviceName,
      error: t('pair.error.unreachable', { error: (err as Error).message }),
      serverUrl: config.getServerUrl(),
      // The credential is still there and still believed good, so this is not
      // a state an invite fixes. Saying otherwise sends people hunting for a
      // file when the real answer is to try again later.
      needsInvite: false,
    };
  }
  return status;
}

/**
 * Spends the pairing token for a device credential, stores it, and establishes
 * the session. `deviceName` defaults to the machine's hostname — it exists so
 * an admin's `keytool device:list` output means something.
 */
export async function pair(deviceName?: string): Promise<PairingStatus> {
  const serverUrl = config.getServerUrl();
  const pairingToken = config.getPairingToken();

  if (!serverUrl || !pairingToken) {
    status = unpaired(config.describe().error ?? t('pair.error.noInvite'));
    return status;
  }

  const name = deviceName?.trim() || hostname();

  try {
    const result = await api.pair(pairingToken, name);
    await saveCredential({
      deviceId: result.deviceId,
      deviceCredential: result.deviceCredential,
      deviceName: result.name,
      serverUrl,
    });
    // Spends the pairing activation; still need the actual session cookie.
    await api.deviceSession(result.deviceCredential);
    status = {
      paired: true,
      deviceName: result.name,
      error: null,
      serverUrl,
      needsInvite: false,
      // A newly paired device has no picture yet.
      deviceId: result.deviceId,
      avatar: null,
    };
  } catch (err) {
    status = unpaired(
      err instanceof ApiError
        ? pairingErrorMessage(err)
        : err instanceof NoServerError
          ? err.message
          : t('pair.error.unreachable', { error: (err as Error).message }),
    );
  }
  return status;
}

/**
 * Adopts an invite the user picked or dropped, then reports the resulting
 * state. Pairing stays a separate, deliberate step so they can see which
 * server they are about to join before joining it.
 */
export async function useInvite(path: string): Promise<PairingStatus> {
  try {
    await config.importInvite(path);
    status = unpaired(null);
  } catch (err) {
    status = unpaired((err as Error).message);
  }
  return status;
}

function pairingErrorMessage(err: ApiError): string {
  const code = (err.body as { error?: string })?.error;
  switch (code) {
    case 'invalid':
      return t('pair.error.tokenRejected');
    case 'exhausted':
      return t('pair.error.exhausted');
    case 'device_name_required':
      return t('pair.error.nameRequired');
    case 'pairing_not_configured':
      return t('pair.error.notSetUp');
    default:
      return t('pair.error.failed', { status: err.status });
  }
}
