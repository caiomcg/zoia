/**
 * The device credential, at rest.
 *
 * safeStorage wraps the OS keychain (DPAPI on Windows) — content is protected
 * from other users on the machine, not from other apps running as the same
 * user. That is the right threshold here: the credential grants access to one
 * viewer identity in one room, not to anything else on the machine.
 */

import { app, safeStorage } from 'electron';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface StoredCredential {
  deviceId: string;
  deviceCredential: string;
  deviceName: string;
}

function credentialPath(): string {
  return join(app.getPath('userData'), 'device.enc');
}

export async function loadCredential(): Promise<StoredCredential | null> {
  try {
    const encrypted = await readFile(credentialPath());
    if (!safeStorage.isEncryptionAvailable()) {
      // Can't decrypt what we can't encrypt on this machine; treat as absent
      // rather than throwing, so the app falls back to pairing.
      return null;
    }
    const json = safeStorage.decryptString(encrypted);
    return JSON.parse(json);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    console.error('[credential-store] could not read stored credential:', err);
    return null;
  }
}

export async function saveCredential(credential: StoredCredential): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS-level encryption is not available on this machine');
  }
  const path = credentialPath();
  await mkdir(dirname(path), { recursive: true });
  const encrypted = safeStorage.encryptString(JSON.stringify(credential));
  await writeFile(path, encrypted, { mode: 0o600 });
}

export async function clearCredential(): Promise<void> {
  await rm(credentialPath(), { force: true });
}
