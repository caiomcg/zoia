/**
 * Pairing tokens.
 *
 * One token is embedded in a build of the desktop app and handed to the people
 * you want. It is spent once per machine, at first run, for a device
 * credential — so it is an invitation, not an access token.
 *
 * That distinction is the point: a secret inside a distributed binary is
 * extractable by anyone holding the .exe. Revoking the token stops *new*
 * machines activating while everyone already paired keeps working.
 */

import { createCredentialStore } from './store.js';

const PREFIX = 'zpair';

export function createPairingStore({ file, logger = console }) {
  const store = createCredentialStore({ file, collection: 'pairings', prefix: PREFIX });

  return {
    ...store,

    /** `maxActivations: null` means unlimited. */
    async add({ name, maxActivations = null, expiresAt = null }) {
      return store.add({ name, expiresAt, maxActivations, activations: 0 });
    },

    /**
     * Verifies a token and consumes one activation. Returns the record, or a
     * reason: an exhausted token is a different problem from a wrong one, and
     * saying which saves a support round trip.
     */
    async claimActivation(rawToken) {
      const record = await store.verify(rawToken);
      if (!record) return { ok: false, reason: 'invalid' };

      const result = await store.mutate((records) => {
        const live = records.find((r) => r.id === record.id);
        if (!live) return { ok: false, reason: 'invalid' };
        if (live.maxActivations !== null && live.activations >= live.maxActivations) {
          return { ok: false, reason: 'exhausted' };
        }
        live.activations += 1;
        live.lastSeen = new Date().toISOString();
        return { ok: true, pairing: { id: live.id, name: live.name } };
      });

      if (result.ok) logger.info(`[pair] activation ${record.id} (${record.name})`);
      return result;
    },
  };
}
