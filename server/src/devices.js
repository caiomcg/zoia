/**
 * Device credentials: one per machine signed in to an account.
 *
 * Issued when someone logs in, and kept by the app in the OS keychain so the
 * password is typed once per machine. A device is only a machine — its name
 * is a label, usually the hostname — and the person's display name and
 * picture live on their account. Revoking one device signs that machine out
 * and nobody else.
 */

import { createCredentialStore, isActive } from './store.js';

const PREFIX = 'zdev';

const lastUsed = (record) => Date.parse(record.lastSeen ?? record.createdAt ?? 0) || 0;

export function createDeviceStore({ db, logger = console }) {
  const store = createCredentialStore({ db, table: 'devices', prefix: PREFIX });

  return {
    ...store,

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
  };
}
