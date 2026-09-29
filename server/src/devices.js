/**
 * Device credentials.
 *
 * Issued once per machine when a pairing token is spent, and stored by the
 * desktop app in the OS keychain. Revoking one device cuts off that machine
 * and nobody else — the finer of the two kill switches.
 */

import { createCredentialStore, isActive } from './store.js';
import { nameKey, uniqueName } from './names.js';

const PREFIX = 'zdev';

export function createDeviceStore({ file, logger = console }) {
  const store = createCredentialStore({ file, collection: 'devices', prefix: PREFIX });

  return {
    ...store,

    /**
     * Records which pairing token issued this device, so a token can cascade.
     * A name already in use gets a number rather than refusing the pairing:
     * it is usually the machine's hostname, and can be changed afterwards.
     */
    async issue({ name, pairingId }) {
      // Read, then added: two pairings racing on one name could both get it,
      // which is rare enough for dedupeNames() to settle at the next start.
      const taken = new Set(
        (await store.all()).filter((r) => isActive(r)).map((r) => nameKey(r.name)),
      );
      const unique = uniqueName(String(name ?? '').trim(), (n) => taken.has(nameKey(n)));
      const { record, raw } = await store.add({ name: unique, pairingId });
      logger.info(`[device] issued ${record.id} (${record.name}) from pairing ${pairingId}`);
      return { record, raw };
    },

    /**
     * Changes a device's display name. The name is what viewers see in the
     * room, and it is read back out of this store on every request, so
     * updating the record here is all a rename needs.
     *
     * Refused with `name_taken` when another live device already has it. The
     * check and the write happen in one mutation, so two people cannot both
     * claim a name at the same moment. Your own name, recased, is yours.
     */
    async rename(id, name) {
      let outcome = { ok: false, reason: 'unknown_device' };
      await store.mutate((records) => {
        const record = records.find((r) => r.id === id && !r.revoked);
        if (!record) return 0;
        const key = nameKey(name);
        const holder = records.find((r) => r.id !== id && isActive(r) && nameKey(r.name) === key);
        if (holder) {
          outcome = { ok: false, reason: 'name_taken' };
          return 0;
        }
        record.name = name;
        record.renamedAt = new Date().toISOString();
        outcome = { ok: true, record: { ...record } };
        return 1;
      });
      if (outcome.ok) logger.info(`[device] ${id} renamed to "${name}"`);
      return outcome;
    },

    /**
     * Gives every live device a name nobody else has. Whoever has held a name
     * longest keeps it; the others become "name 2", "name 3", … Run at
     * startup, for names shared from before names were unique. Returns what
     * was changed.
     */
    async dedupeNames() {
      const changed = [];
      await store.mutate((records) => {
        const since = (r) => Date.parse(r.renamedAt ?? r.createdAt ?? 0) || 0;
        const live = records.filter((r) => isActive(r)).sort((a, b) => since(a) - since(b));
        const keepers = new Map();
        for (const record of live) {
          const key = nameKey(record.name);
          if (!keepers.has(key)) keepers.set(key, record);
        }
        const taken = new Set(keepers.keys());
        for (const record of live) {
          if (keepers.get(nameKey(record.name)) === record) continue;
          const name = uniqueName(record.name, (n) => taken.has(nameKey(n)));
          taken.add(nameKey(name));
          changed.push({ id: record.id, from: record.name, to: name });
          record.name = name;
          record.renamedAt = new Date().toISOString();
        }
        return changed.length;
      });
      for (const { id, from, to } of changed) {
        logger.info(`[device] ${id} renamed from "${from}" to "${to}": the name was taken`);
      }
      return changed;
    },

    /**
     * Records which version of its picture a device has, or that it has none
     * (`null`). The picture itself lives in the avatar store; this is what
     * the next token carries, so people joining later see it too.
     */
    async setAvatar(id, version) {
      let updated = null;
      await store.mutate((records) => {
        const record = records.find((r) => r.id === id && !r.revoked);
        if (!record) return 0;
        if (version) record.avatar = version;
        else delete record.avatar;
        record.avatarChangedAt = new Date().toISOString();
        updated = { ...record };
        return 1;
      });
      if (updated) logger.info(`[device] ${id} ${version ? 'set' : 'removed'} their picture`);
      return updated;
    },

    /** Live devices a pairing token issued: the seats it has in use. */
    async countActiveByPairing(pairingId) {
      const records = await store.all();
      return records.filter((r) => r.pairingId === pairingId && isActive(r)).length;
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
