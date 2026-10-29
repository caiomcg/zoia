/**
 * Accounts: a person, with an email, a password and a role. See ADR 0031.
 *
 * Devices belong to an account. The account holds what is about the person —
 * the display name, the picture, whether they are let in at all — and the
 * device store holds what is about a machine. A session is still a device;
 * this is what it resolves to.
 *
 * The email is the login and is never shown to anyone but admins. It is not
 * verified: the server sends no mail, and admin approval is the check.
 */

import { randomBytes } from 'node:crypto';
import { PASSWORD_SCRYPT, decoyHash, hashSecret, parseCredential, secretMatches } from './store.js';
import { createTableStore } from './database.js';
import { MAX_NAME_LENGTH, nameKey, uniqueName } from './names.js';

export const ROLES = ['user', 'admin', 'super_admin'];
/**
 * At least six characters, with an uppercase and a lowercase letter, a digit
 * and a symbol. Short by itself; what keeps a short password from being
 * guessed online is the per-account lockout and the per-address rate limit.
 */
export const PASSWORD_MIN_LENGTH = 6;
// scrypt takes any length, but nothing a person types is longer, and an
// unbounded one is free work for whoever sends it.
export const PASSWORD_MAX_LENGTH = 128;

/** Each kind of character a password needs one of. Must match the app's rules. */
const PASSWORD_NEEDS = [/\p{Lu}/u, /\p{Ll}/u, /\p{Nd}/u, /[^\p{L}\p{N}]/u];

/** Failed logins before an account locks, and for how long. */
const LOCK_AFTER = 10;
const LOCK_MS = 15 * 60_000;
/** How long a reset code stays good. */
const CODE_TTL_MS = 24 * 60 * 60_000;
/** Codes look like credentials, `zcode_<account id>_<secret>`, so parsing is shared. */
const CODE_PREFIX = 'zcode';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The email as it is stored and compared, or null when it is not one. */
export function normalizeEmail(email) {
  if (typeof email !== 'string') return null;
  const tidy = email.trim().toLowerCase();
  return tidy.length <= 254 && EMAIL.test(tidy) ? tidy : null;
}

export function isValidPassword(password) {
  return (
    typeof password === 'string' &&
    password.length >= PASSWORD_MIN_LENGTH &&
    password.length <= PASSWORD_MAX_LENGTH &&
    PASSWORD_NEEDS.every((need) => need.test(password))
  );
}

export const isAdmin = (account) => account?.role === 'admin' || account?.role === 'super_admin';

/** A bot user of an addon (ADR 0041): never an admin, and never signs in. */
export const isBot = (account) => Boolean(account?.addonId);

/** The most bots one addon may have. */
export const BOTS_PER_ADDON = 5;

/**
 * A bot's email, which nobody types: the column is required and unique, and
 * `.invalid` is reserved, so it can never be anyone's real address.
 */
const botEmail = (id) => `bot-${id}@addons.invalid`;

/** What a person may set themselves to; see ADR 0038 and src/presence.js. */
export const PRESENCES = ['online', 'busy', 'away', 'invisible'];

/**
 * Whether `actor` may disable, re-enable or reset `target`. Nobody may touch
 * the super admin from the app; only the super admin may touch an admin.
 * Promoting and demoting is narrower still, and checked by the route.
 */
export function canManage(actor, target) {
  if (!isAdmin(actor) || !target || actor.id === target.id) return false;
  if (target.role === 'super_admin') return false;
  if (target.role === 'admin') return actor.role === 'super_admin';
  return true;
}

/** An account without anything secret in it, which is all that leaves this file. */
function safe(record) {
  return record ? withoutSecrets(record) : null;
}

function withoutSecrets({ salt: _salt, hash: _hash, code, ...rest }) {
  return { ...rest, code: code ? { expiresAt: code.expiresAt } : null };
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString('base64');
  return { salt, hash: await hashSecret(password, salt, PASSWORD_SCRYPT) };
}

export function createAccountStore({ db, maxPending = 20, logger = console }) {
  const store = createTableStore({ db, table: 'accounts' });

  function newId(records) {
    for (;;) {
      const id = randomBytes(4).toString('hex');
      if (!records.some((r) => r.id === id)) return id;
    }
  }

  /** A display name nobody has, from `wanted`. */
  function freeName(records, wanted) {
    const taken = new Set(records.map((r) => nameKey(r.name)));
    const base =
      String(wanted ?? '')
        .trim()
        .slice(0, MAX_NAME_LENGTH) || 'Zoia';
    return uniqueName(base, (n) => taken.has(nameKey(n)));
  }

  function findLive(records, id) {
    return records.find((r) => r.id === id) ?? null;
  }

  return {
    idle: store.idle,
    touch: store.touch,

    async get(id) {
      return safe(await store.find(id));
    },

    async list() {
      return (await store.all()).map(safe);
    },

    async countPending() {
      return (await store.all()).filter((r) => r.status === 'pending').length;
    },

    /**
     * A new account, pending until an admin approves it. Its display name is
     * the part of the email before the `@`, made unique; the person changes
     * it afterwards.
     */
    async signup({ email, password, ip = null }) {
      const address = normalizeEmail(email);
      if (!address) return { ok: false, reason: 'invalid_email' };
      if (!isValidPassword(password)) return { ok: false, reason: 'weak_password' };

      // Hashed before the queue, so one slow scrypt does not hold up every write.
      const secret = await hashPassword(password);
      const result = await store.mutate((records) => {
        if (records.some((r) => r.email === address)) return { ok: false, reason: 'email_taken' };
        if (records.filter((r) => r.status === 'pending').length >= maxPending) {
          return { ok: false, reason: 'signup_closed' };
        }
        const record = {
          id: newId(records),
          email: address,
          name: freeName(records, address.split('@')[0]),
          role: 'user',
          status: 'pending',
          ...secret,
          createdAt: new Date().toISOString(),
          signupIp: ip,
          lastSeen: null,
          failedLogins: 0,
          lockedUntil: null,
        };
        records.push(record);
        return { ok: true, account: safe(record) };
      });
      // The id, never the email: the log is read more casually than the store.
      if (result.ok) logger.info(`[account] ${result.account.id} signed up, pending approval`);
      return result;
    },

    /**
     * Checks an email and password. An unknown email and a wrong password both
     * answer `invalid_login` and both cost one scrypt, so the answer says
     * nothing about which accounts exist.
     */
    async authenticate(email, password) {
      const address = normalizeEmail(email);
      const records = await store.all();
      const record = address ? records.find((r) => r.email === address) : null;
      const presented = typeof password === 'string' ? password.slice(0, PASSWORD_MAX_LENGTH) : '';

      if (!record?.hash) {
        await decoyHash(presented, PASSWORD_SCRYPT);
        return { ok: false, reason: 'invalid_login' };
      }
      if (record.lockedUntil && Date.parse(record.lockedUntil) > Date.now()) {
        return { ok: false, reason: 'locked' };
      }

      if (!(await secretMatches(presented, record, PASSWORD_SCRYPT))) {
        let locked = false;
        await store.mutate((all) => {
          const live = findLive(all, record.id);
          if (!live) return;
          live.failedLogins = (live.failedLogins ?? 0) + 1;
          if (live.failedLogins >= LOCK_AFTER) {
            live.lockedUntil = new Date(Date.now() + LOCK_MS).toISOString();
            live.failedLogins = 0;
            locked = true;
          }
        });
        if (locked) logger.warn(`[account] ${record.id} locked after ${LOCK_AFTER} failed logins`);
        return { ok: false, reason: 'invalid_login' };
      }

      if (record.failedLogins || record.lockedUntil) {
        await store.mutate((all) => {
          const live = findLive(all, record.id);
          if (live) Object.assign(live, { failedLogins: 0, lockedUntil: null });
        });
      }
      // Only after the password matched, so disabled-ness is not an oracle either.
      if (record.status === 'disabled') return { ok: false, reason: 'disabled' };
      return { ok: true, account: safe(record) };
    },

    /** Whether `password` is this account's, for changing it. */
    async checkPassword(id, password) {
      const record = await store.find(id);
      if (!record?.hash || typeof password !== 'string') {
        await decoyHash(String(password ?? ''), PASSWORD_SCRYPT);
        return false;
      }
      return secretMatches(password.slice(0, PASSWORD_MAX_LENGTH), record, PASSWORD_SCRYPT);
    },

    async setPassword(id, password) {
      if (!isValidPassword(password)) return { ok: false, reason: 'weak_password' };
      const secret = await hashPassword(password);
      const updated = await store.mutate((records) => {
        const record = findLive(records, id);
        if (!record) return false;
        Object.assign(record, secret, { passwordChangedAt: new Date().toISOString() });
        return true;
      });
      if (!updated) return { ok: false, reason: 'unknown_account' };
      logger.info(`[account] ${id} changed their password`);
      return { ok: true };
    },

    /**
     * Changes the display name. Unique per server, judged the way a person
     * reads the list, so "Flavi" and "flávi" are one name.
     */
    async rename(id, name) {
      return store.mutate((records) => {
        const record = findLive(records, id);
        if (!record) return { ok: false, reason: 'unknown_account' };
        const key = nameKey(name);
        const holder = records.find((r) => r.id !== id && nameKey(r.name) === key);
        if (holder) return { ok: false, reason: 'name_taken' };
        record.name = name;
        record.renamedAt = new Date().toISOString();
        return { ok: true, account: safe(record) };
      });
    },

    /** The picture's version, or `null` for none; see src/avatars.js. */
    async setAvatar(id, version) {
      return store.mutate((records) => {
        const record = findLive(records, id);
        if (!record) return null;
        if (version) record.avatar = version;
        else delete record.avatar;
        record.avatarChangedAt = new Date().toISOString();
        return safe(record);
      });
    },

    /** The status the person chose for themselves; online is stored as none. */
    async setPresence(id, presence) {
      if (!PRESENCES.includes(presence)) return { ok: false, reason: 'invalid_presence' };
      return store.mutate((records) => {
        const record = findLive(records, id);
        if (!record) return { ok: false, reason: 'unknown_account' };
        record.presence = presence === 'online' ? null : presence;
        return { ok: true, presence };
      });
    },

    async approve(id, approvedBy) {
      const result = await store.mutate((records) => {
        const record = findLive(records, id);
        if (!record) return { ok: false, reason: 'unknown_account' };
        if (record.status !== 'pending') return { ok: false, reason: 'not_pending' };
        Object.assign(record, {
          status: 'active',
          approvedAt: new Date().toISOString(),
          approvedBy,
        });
        return { ok: true, account: safe(record) };
      });
      if (result.ok) logger.info(`[account] ${id} approved by ${approvedBy}`);
      return result;
    },

    /** Deletes a pending account outright, so its email is free again. */
    async reject(id, rejectedBy) {
      const result = await store.mutate((records) => {
        const index = records.findIndex((r) => r.id === id);
        if (index < 0) return { ok: false, reason: 'unknown_account' };
        if (records[index].status !== 'pending') return { ok: false, reason: 'not_pending' };
        records.splice(index, 1);
        return { ok: true };
      });
      if (result.ok) logger.info(`[account] ${id} rejected by ${rejectedBy}`);
      return result;
    },

    /** `disabled` or back to `active`. Pending accounts are approved or rejected instead. */
    async setStatus(id, status, by) {
      const result = await store.mutate((records) => {
        const record = findLive(records, id);
        if (!record) return { ok: false, reason: 'unknown_account' };
        if (record.status === 'pending') return { ok: false, reason: 'pending' };
        record.status = status;
        record.statusChangedAt = new Date().toISOString();
        return { ok: true, account: safe(record) };
      });
      if (result.ok) logger.info(`[account] ${id} ${status} by ${by}`);
      return result;
    },

    /** `admin` or `user`. The super admin is set by `setSuper`, from the server only. */
    async setRole(id, role, by) {
      if (role !== 'admin' && role !== 'user') return { ok: false, reason: 'invalid_role' };
      const result = await store.mutate((records) => {
        const record = findLive(records, id);
        if (!record) return { ok: false, reason: 'unknown_account' };
        if (record.role === 'super_admin') return { ok: false, reason: 'forbidden' };
        if (isBot(record)) return { ok: false, reason: 'forbidden' };
        if (record.status !== 'active') return { ok: false, reason: 'not_active' };
        record.role = role;
        return { ok: true, account: safe(record) };
      });
      if (result.ok) logger.info(`[account] ${id} is now ${role}, set by ${by}`);
      return result;
    },

    /**
     * Makes the account with this email the one super admin, approving it if
     * need be; whoever was super admin before becomes an admin. Called by
     * keytool on the server, never by a route.
     */
    async setSuper(email) {
      const address = normalizeEmail(email);
      return store.mutate((records) => {
        const record = address ? records.find((r) => r.email === address) : null;
        if (!record) return { ok: false, reason: 'unknown_account' };
        const previous = records.filter((r) => r.role === 'super_admin' && r !== record);
        for (const other of previous) other.role = 'admin';
        record.role = 'super_admin';
        if (record.status === 'pending') record.approvedAt = new Date().toISOString();
        record.status = 'active';
        return { ok: true, account: safe(record), demoted: previous.map((r) => r.id) };
      });
    },

    /**
     * A bot user for an addon: active at once, a plain user, and with no
     * password, so no login can ever match it. Its name is unique like
     * anyone's.
     */
    async createBot({ addonId, name }) {
      return store.mutate((records) => {
        if (records.filter((r) => r.addonId === addonId).length >= BOTS_PER_ADDON) {
          return { ok: false, reason: 'bot_limit' };
        }
        const id = newId(records);
        const record = {
          id,
          email: botEmail(id),
          name: freeName(records, name),
          role: 'user',
          status: 'active',
          salt: '',
          hash: '',
          createdAt: new Date().toISOString(),
          lastSeen: null,
          failedLogins: 0,
          lockedUntil: null,
          approvedAt: new Date().toISOString(),
          addonId,
        };
        records.push(record);
        logger.info(`[account] ${id} created as a bot of addon ${addonId}`);
        return { ok: true, account: safe(record) };
      });
    },

    async botsOf(addonId) {
      return (await store.all()).filter((r) => r.addonId === addonId).map(safe);
    },

    async removeBot(addonId, id) {
      return store.mutate((records) => {
        const index = records.findIndex((r) => r.id === id && r.addonId === addonId);
        if (index < 0) return { ok: false, reason: 'not_found' };
        records.splice(index, 1);
        return { ok: true };
      });
    },

    /**
     * A one-time code to set a forgotten password, which an admin passes on:
     * there is no mail to send a link with. Shown once and stored hashed; a
     * new code replaces any earlier one.
     */
    async issueCode(id, { ttlMs = CODE_TTL_MS } = {}) {
      const secret = randomBytes(32).toString('base64url');
      const salt = randomBytes(16).toString('base64');
      const hash = await hashSecret(secret, salt);
      const expiresAt = new Date(Date.now() + ttlMs).toISOString();
      const ok = await store.mutate((records) => {
        const record = findLive(records, id);
        // A bot has no password to set.
        if (!record || isBot(record)) return false;
        record.code = { salt, hash, expiresAt };
        return true;
      });
      if (!ok) return null;
      return { code: `${CODE_PREFIX}_${id}_${secret}`, expiresAt };
    },

    /** Spends a code: sets the password. Every failure is `invalid_code`, whatever the reason. */
    async redeemCode(raw, { password }) {
      const parsed = parseCredential(raw, CODE_PREFIX);
      const record = parsed ? await store.find(parsed.id) : null;
      const code = record?.code;
      if (!code || Date.parse(code.expiresAt) <= Date.now()) {
        await decoyHash(parsed?.secret ?? '');
        return { ok: false, reason: 'invalid_code' };
      }
      if (!(await secretMatches(parsed.secret, code))) return { ok: false, reason: 'invalid_code' };
      if (!isValidPassword(password)) return { ok: false, reason: 'weak_password' };

      const secret = await hashPassword(password);
      const result = await store.mutate((records) => {
        const live = findLive(records, record.id);
        // Spent or replaced while the password was hashing.
        if (!live?.code || live.code.hash !== code.hash)
          return { ok: false, reason: 'invalid_code' };
        Object.assign(live, secret, {
          passwordChangedAt: new Date().toISOString(),
          failedLogins: 0,
          lockedUntil: null,
          code: null,
        });
        return { ok: true, account: safe(live) };
      });
      if (result.ok) logger.info(`[account] ${record.id} used a reset code`);
      return result;
    },
  };
}
