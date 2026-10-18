/**
 * Device credentials.
 *
 * Issued once per machine, when someone logs in to their account or, before
 * accounts, when a pairing token is spent; stored by the app in the OS
 * keychain. Revoking one device cuts off that machine and nobody else.
 *
 * A device that belongs to an account (`accountId`) is only a machine: its
 * name is a label, and the person's display name and picture live on the
 * account. A device without one is from before accounts and is still the
 * person, so names are only compared among those.
 */

import { createCredentialStore, isActive } from './store.js';
import { nameKey, uniqueName } from './names.js';

const PREFIX = 'zdev';

const isLegacy = (record) => !record.accountId;
const lastUsed = (record) => Date.parse(record.lastSeen ?? record.createdAt ?? 0) || 0;

export function createDeviceStore({ file, logger = console }) {
  const store = createCredentialStore({ file, collection: 'devices', prefix: PREFIX });

  return {
    ...store,

    /**
     * Records which pairing token issued this device, so a token can cascade.
     * A name already in use gets a number rather than refusing the pairing:
     * it is usually the machine's hostname, and can be changed afterwards.
     */
    async issue({ name, pairingId, alsoTaken = new Set() }) {
      // Read, then added: two pairings racing on one name could both get it,
      // which is rare enough for dedupeNames() to settle at the next start.
      const taken = new Set([
        ...alsoTaken,
        ...(await store.all())
          .filter((r) => isActive(r) && isLegacy(r))
          .map((r) => nameKey(r.name)),
      ]);
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
    async rename(id, name, { alsoTaken = new Set() } = {}) {
      let outcome = { ok: false, reason: 'unknown_device' };
      await store.mutate((records) => {
        const record = records.find((r) => r.id === id && !r.revoked);
        if (!record) return 0;
        const key = nameKey(name);
        const holder = records.find(
          (r) => r.id !== id && isActive(r) && isLegacy(r) && nameKey(r.name) === key,
        );
        if (holder || alsoTaken.has(key)) {
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
        const live = records
          .filter((r) => isActive(r) && isLegacy(r))
          .sort((a, b) => since(a) - since(b));
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

    /** Name keys of live devices from before accounts, which still name a person. */
    async legacyNameKeys() {
      const records = await store.all();
      return new Set(records.filter((r) => isActive(r) && isLegacy(r)).map((r) => nameKey(r.name)));
    },

    /**
     * A device for an account, on login. An account holds at most `cap` live
     * devices; one more replaces the one used least recently, so a reinstall
     * is the same person logging in again rather than a refusal. A device
     * expires after `idleMs` unused, and `touch` pushes that back.
     */
    async issueForAccount({ name, accountId, cap, idleMs }) {
      const replaced = await store.mutate((records) => {
        const live = records
          .filter((r) => r.accountId === accountId && isActive(r))
          .sort((a, b) => lastUsed(a) - lastUsed(b));
        const evicted = live.slice(0, Math.max(0, live.length - cap + 1));
        for (const record of evicted) {
          record.revoked = true;
          record.revokedAt = new Date().toISOString();
          record.revokedReason = 'replaced';
        }
        return evicted.map((r) => r.id);
      });
      const { record, raw } = await store.add({
        name: String(name ?? '')
          .trim()
          .slice(0, 64),
        accountId,
        expiresAt: new Date(Date.now() + idleMs).toISOString(),
      });
      logger.info(`[device] issued ${record.id} for account ${accountId}`);
      for (const id of replaced) logger.info(`[device] ${id} replaced by ${record.id}`);
      return { record, raw, replaced };
    },

    /** Live devices of one account. */
    async listByAccount(accountId) {
      const records = await store.listSafe();
      return records.filter((r) => r.accountId === accountId && isActive(r));
    },

    /** Revokes every device of an account but `except`. Returns how many. */
    async revokeByAccount(accountId, { except = null } = {}) {
      return store.mutate((records) => {
        let count = 0;
        for (const record of records) {
          if (record.accountId === accountId && record.id !== except && !record.revoked) {
            record.revoked = true;
            record.revokedAt = new Date().toISOString();
            count += 1;
          }
        }
        return count;
      });
    },

    /**
     * Moves devices from before accounts into one, for the migration. They
     * keep working, and from then on expire like any account's device.
     */
    async assignAccount(ids, accountId, { idleMs }) {
      return store.mutate((records) => {
        let count = 0;
        for (const record of records) {
          if (!ids.includes(record.id) || !isActive(record) || !isLegacy(record)) continue;
          record.accountId = accountId;
          record.expiresAt = new Date(Date.now() + idleMs).toISOString();
          count += 1;
        }
        return count;
      });
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
