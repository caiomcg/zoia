/**
 * Who this machine is signed in as, and getting it signed in.
 *
 * A machine signs in to an account once, with an email and a password, and
 * gets a per-device credential back; after that this module's job on every
 * launch is just to prove that credential still works, since it may have
 * been revoked, replaced or its account disabled. See ADR 0031.
 */

import { hostname } from 'node:os';
import * as api from './api';
import { ApiError, NoServerError, type SessionInfo } from './api';
import * as config from './config';
import { normalizeServerUrl } from './server-url';
import { t } from './language';
import { loadCredential, saveCredential, clearCredential } from './credential-store';
import type { AccountInfo, AuthOutcome, PairingStatus } from '../shared/ipc';

let status: PairingStatus = {
  paired: false,
  deviceName: null,
  error: null,
  serverUrl: null,
};

/** Tells the window, which keeps its own copy. Set by index.ts. */
let notify: (status: PairingStatus) => void = () => {};

export function onStatusChange(listener: (status: PairingStatus) => void): void {
  notify = listener;
}

function setStatus(next: PairingStatus): PairingStatus {
  status = next;
  notify(status);
  return status;
}

export function getStatus(): PairingStatus {
  return status;
}

// Settled once restoreSession has run. Until then `status` is only a
// placeholder, and answering with it made the sign-in screen flash on every
// launch of an already signed-in machine.
let markRestored: () => void = () => {};
const restored = new Promise<void>((resolve) => {
  markRestored = resolve;
});

/** The status, once the stored credential has been checked. */
export async function getRestoredStatus(): Promise<PairingStatus> {
  await restored;
  return status;
}

function signedOut(error: string | null): PairingStatus {
  return { paired: false, deviceName: null, error, serverUrl: config.getServerUrl() };
}

function accountOf(info: SessionInfo): AccountInfo {
  return {
    id: info.accountId,
    email: info.email,
    role: info.role,
    status: info.status,
    ...(info.pendingApprovals !== undefined ? { pendingApprovals: info.pendingApprovals } : {}),
  };
}

function signedIn(info: SessionInfo): PairingStatus {
  return {
    paired: true,
    deviceName: info.name,
    error: null,
    serverUrl: config.getServerUrl(),
    deviceId: info.id,
    avatar: info.avatar ?? null,
    account: accountOf(info),
  };
}

/** The server's refusal code, or `unreachable` when there was no answer at all. */
function errorCode(err: unknown): string {
  if (err instanceof ApiError) {
    return (err.body as { error?: string } | null)?.error ?? `http_${err.status}`;
  }
  if (err instanceof NoServerError) return 'invalid_server';
  return 'unreachable';
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
  if (!stored) return setStatus(signedOut(null));

  // The credential is only valid at the server that issued it, so that
  // server wins over whatever address the build starts with.
  config.useCredentialServer(stored.serverUrl);

  try {
    return setStatus(signedIn(await api.deviceSession(stored.deviceCredential)));
  } catch (err) {
    // A 401 means this device is gone — revoked, replaced by a newer machine,
    // or unused too long; a 403 that its account was disabled. Anything else
    // — the server being down, a laptop opened on a train — is temporary, and
    // deleting the credential for it would sign out a working machine.
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      await clearCredential();
      const reason = err.status === 403 ? t('pair.error.disabled') : t('pair.error.removed');
      return setStatus(signedOut(reason));
    }
    return setStatus({
      paired: false,
      deviceName: stored.deviceName,
      error: t('pair.error.unreachable', { error: (err as Error).message }),
      serverUrl: config.getServerUrl(),
      offline: true,
    });
  }
}

/** Points this copy at a typed address, if it is one. Returns an error code otherwise. */
function adoptServer(serverUrl: string): string | null {
  try {
    config.useTypedServer(normalizeServerUrl(serverUrl.trim()));
    return null;
  } catch {
    return 'invalid_server';
  }
}

/**
 * Signs this machine in to an account and keeps the credential it gets, so
 * the password is typed once per machine. The machine is named after its
 * hostname, which is what someone reads in their list of devices.
 */
export async function signIn(
  serverUrl: string,
  email: string,
  password: string,
): Promise<AuthOutcome> {
  const invalid = adoptServer(serverUrl);
  if (invalid) return { ok: false, error: invalid };
  try {
    const result = await api.login(email, password, hostname());
    await saveCredential({
      deviceId: result.deviceId,
      deviceCredential: result.deviceCredential,
      deviceName: result.name,
      // Set by adoptServer above, so never null here.
      serverUrl: config.getServerUrl() ?? serverUrl,
    });
    return { ok: true, status: setStatus(signedIn(result)) };
  } catch (err) {
    return { ok: false, error: errorCode(err) };
  }
}

/**
 * Creates an account and signs in to it straight away. It is pending until an
 * admin approves it, which the app shows as a waiting screen.
 */
export async function signUp(
  serverUrl: string,
  email: string,
  password: string,
): Promise<AuthOutcome> {
  const invalid = adoptServer(serverUrl);
  if (invalid) return { ok: false, error: invalid };
  try {
    await api.signup(email, password);
  } catch (err) {
    return { ok: false, error: errorCode(err) };
  }
  return signIn(serverUrl, email, password);
}

/**
 * Spends a reset code from an admin, then signs in with the new password: a
 * reset signs every machine of the account out, this one included.
 */
export async function redeem(
  serverUrl: string,
  code: string,
  password: string,
): Promise<AuthOutcome> {
  const invalid = adoptServer(serverUrl);
  if (invalid) return { ok: false, error: invalid };
  let result: { email: string };
  try {
    result = await api.redeemCode(code.trim(), password);
  } catch (err) {
    return { ok: false, error: errorCode(err) };
  }
  return signIn(serverUrl, result.email, password);
}

/**
 * Asks the server who this machine is now: an approval, a rename, a role
 * change or new sign-ups waiting. A machine that has been signed out
 * meanwhile drops back to the sign-in screen; an unreachable server changes
 * nothing.
 */
export async function refresh(): Promise<PairingStatus> {
  if (!status.paired) return status;
  try {
    return setStatus(signedIn(await api.session()));
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      await clearCredential();
      return setStatus(signedOut(t('pair.error.removed')));
    }
    return status;
  }
}

/**
 * Signs this machine out, and asks the server to forget it so it stops holding
 * a seat. Local state goes either way: an unreachable server is no reason to
 * stay signed in against someone's wishes.
 */
export async function signOut(): Promise<PairingStatus> {
  await api.forgetDevice().catch(() => undefined);
  await clearCredential();
  return setStatus(signedOut(null));
}
