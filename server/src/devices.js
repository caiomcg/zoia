/**
 * Device credentials.
 *
 * Issued once per machine when a pairing token is spent, and stored by the
 * desktop app in the OS keychain. Revoking one device cuts off that machine
 * and nobody else — the finer of the two kill switches.
 */

import { createCredentialStore } from './store.js';

const PREFIX = 'zdev';

export function createDeviceStore({ file, logger = console }) {
  const store = createCredentialStore({ file, collection: 'devices', prefix: PREFIX });

  return {
    ...store,

    /** Records which pairing token issued this device, so a token can cascade. */
    async issue({ name, pairingId }) {
      const { record, raw } = await store.add({ name, pairingId });
      logger.info(`[device] issued ${record.id} (${record.name}) from pairing ${pairingId}`);
      return { record, raw };
    },

    /**
     * Changes a device's display name. The name is what viewers see in the
     * room, and it is read back out of this store on every request, so
     * updating the record here is all a rename needs.
     */
    async rename(id, name) {
      let renamed = null;
      await store.mutate((records) => {
        const record = records.find((r) => r.id === id && !r.revoked);
        if (!record) return 0;
        record.name = name;
        record.renamedAt = new Date().toISOString();
        renamed = { ...record };
        return 1;
      });
      if (renamed) logger.info(`[device] ${id} renamed to "${name}"`);
      return renamed;
    },

    /** Revokes every device issued by a pairing token. */
    async revokeByPairing(pairingId) {
      return store.mutate((records) => {
        let count = 0;
        for (const record of records) {
          if (record.pairingId === pairingId && !record.revoked) {
            record.revoked = true;
            record.revokedAt = new Date().toISOString();
            count += 1;
          }
        }
        return count;
      });
    },
  };
}
