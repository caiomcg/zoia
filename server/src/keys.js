/**
 * Invite-key store.
 *
 * A key looks like `zoia_<8 hex id>_<43 char secret>`. The mechanics live in
 * store.js, shared with pairing tokens and device credentials; this file is
 * what a key *means*.
 */

import {
  createJsonStore,
  decoyHash,
  isActive,
  newCredential,
  parseCredential,
  secretMatches,
} from './store.js';

const PREFIX = 'zoia';

// One tier of user. Anyone may claim the stage; see stage.js.
export const ROLES = ['member'];

export { isActive };

/** Splits a raw key into its public id and secret. Returns null if malformed. */
export function parseKey(raw) {
  return parseCredential(raw, PREFIX);
}

export function createKeyStore({ file }) {
  const store = createJsonStore({ file, collection: 'keys' });

  return {
    /**
     * Mints a key. The raw value is returned once and never stored — a lost key
     * is replaced, not recovered.
     */
    async add({ name, role = 'member', expiresAt = null }) {
      if (!ROLES.includes(role)) {
        throw new Error(`role must be one of: ${ROLES.join(', ')}`);
      }
      if (!name || !name.trim()) throw new Error('name is required');

      const { id, salt, hash, raw } = await newCredential(PREFIX);
      const record = {
        id,
        name: name.trim(),
        role,
        salt,
        hash,
        createdAt: new Date().toISOString(),
        lastSeen: null,
        expiresAt,
        revoked: false,
      };

      await store.mutate((keys) => {
        keys.push(record);
      });

      return { record, rawKey: raw };
    },

    list: () => store.listSafe(),
    revoke: (id) => store.revoke(id),
    touch: (id) => store.touch(id),
    idle: () => store.idle(),

    /** Resolves an id to an active record. Used to re-validate sessions per request. */
    async getActive(id) {
      const record = await store.find(id);
      return isActive(record) ? record : null;
    },

    /** Verifies a raw key. Returns the record, or null for any failure. */
    async verify(rawKey) {
      const parsed = parseKey(rawKey);
      if (!parsed) return null;

      const record = await this.getActive(parsed.id);
      if (!record) {
        // Cost the same as a wrong secret rather than answering faster.
        await decoyHash(parsed.secret);
        return null;
      }
      return (await secretMatches(parsed.secret, record)) ? record : null;
    },
  };
}
