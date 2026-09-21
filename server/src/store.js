/**
 * Shared machinery for credential stores.
 *
 * Invite keys, pairing tokens and device credentials are the same shape: a
 * public id that selects a record, a secret stored only as a scrypt hash, and
 * revocation plus expiry. This holds that once so the three stores differ only
 * in what they mean.
 *
 * Credentials look like `<prefix>_<8 hex id>_<43 char secret>`. The id is public
 * — it makes verification one hash instead of a scan over every salt, and it is
 * the safe value to log. See docs/SECURITY.md for why scrypt.
 */

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

const KEY_LENGTH = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

export async function hashSecret(secret, salt) {
  const derived = await scryptAsync(secret, salt, KEY_LENGTH, SCRYPT_PARAMS);
  return derived.toString('base64');
}

/** Mints an id and secret, plus the salted hash to persist. */
export async function newCredential(prefix) {
  const id = randomBytes(4).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  const salt = randomBytes(16).toString('base64');
  const hash = await hashSecret(secret, salt);
  return { id, secret, salt, hash, raw: `${prefix}_${id}_${secret}` };
}

/**
 * Splits a raw credential into id and secret. The secret is base64url, whose
 * alphabet includes '_', so this anchors on the fixed-width id rather than
 * splitting on '_' — which would misparse roughly half of all credentials.
 */
export function parseCredential(raw, prefix) {
  if (typeof raw !== 'string') return null;
  const match = new RegExp(`^${prefix}_([0-9a-f]{8})_([A-Za-z0-9_-]{32,})$`).exec(raw.trim());
  return match ? { id: match[1], secret: match[2] } : null;
}

export function isActive(record, now = Date.now()) {
  if (!record || record.revoked) return false;
  if (record.expiresAt && Date.parse(record.expiresAt) <= now) return false;
  return true;
}

/** Timing-safe comparison of a presented secret against a stored record. */
export async function secretMatches(secret, record) {
  const candidate = Buffer.from(await hashSecret(secret, record.salt));
  const expected = Buffer.from(record.hash);
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

/** Hashes against a throwaway salt so a miss costs what a hit costs. */
export async function decoyHash(secret) {
  await hashSecret(secret, 'decoy');
}

/**
 * A JSON file holding one collection of records, with serialised writes.
 * These files hold at most a few dozen entries; a promise chain is enough,
 * and anything more would be machinery without a purpose.
 */
export function createJsonStore({ file, collection }) {
  let queue = Promise.resolve();

  async function read() {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      return { version: 1, [collection]: [], ...parsed };
    } catch (err) {
      if (err.code === 'ENOENT') return { version: 1, [collection]: [] };
      throw err;
    }
  }

  async function write(data) {
    await mkdir(dirname(file), { recursive: true });
    // Write-then-rename so a crash mid-write cannot truncate the store and
    // lock everyone out.
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, file);
  }

  function mutate(fn) {
    queue = queue.then(async () => {
      const data = await read();
      const result = await fn(data[collection], data);
      await write(data);
      return result;
    });
    return queue;
  }

  return {
    read,
    mutate,

    async all() {
      return (await read())[collection];
    },

    async find(id) {
      return (await read())[collection].find((r) => r.id === id) ?? null;
    },

    /** Records without salt or hash, so no caller can accidentally log them. */
    async listSafe() {
      const records = (await read())[collection];
      return records.map(({ salt: _salt, hash: _hash, ...rest }) => rest);
    },

    async revoke(id) {
      return mutate((records) => {
        const record = records.find((r) => r.id === id);
        if (!record) return false;
        record.revoked = true;
        record.revokedAt = new Date().toISOString();
        return true;
      });
    },

    /** Best-effort activity stamp. A failure here must not break a request. */
    async touch(id, extra = {}) {
      return mutate((records) => {
        const record = records.find((r) => r.id === id);
        if (record) Object.assign(record, { lastSeen: new Date().toISOString() }, extra);
      }).catch(() => {});
    },

    /**
     * Resolves once queued writes have settled. `touch` is deliberately
     * fire-and-forget so it never slows a request, which means a write can
     * still be in flight at shutdown or at the end of a test.
     */
    async idle() {
      return queue.catch(() => {});
    },
  };
}

/**
 * A store of revocable credentials: mint one, verify a presented value, revoke
 * it. Invite keys, pairing tokens and device credentials are all this, differing
 * only in prefix and in the extra fields they carry.
 */
export function createCredentialStore({ file, collection, prefix }) {
  const store = createJsonStore({ file, collection });

  return {
    ...store,

    /**
     * Mints a credential. The raw value is returned once and never stored — a
     * lost credential is replaced, not recovered.
     */
    async add({ name, expiresAt = null, ...extra }) {
      if (!name || !String(name).trim()) throw new Error('name is required');

      const { id, salt, hash, raw } = await newCredential(prefix);
      const record = {
        id,
        name: String(name).trim(),
        salt,
        hash,
        createdAt: new Date().toISOString(),
        lastSeen: null,
        expiresAt,
        revoked: false,
        ...extra,
      };

      await store.mutate((records) => {
        records.push(record);
      });

      return { record, raw };
    },

    /** Resolves an id to an active record, or null. */
    async getActive(id) {
      const record = await store.find(id);
      return isActive(record) ? record : null;
    },

    /** Verifies a raw credential. Returns the record, or null for any failure. */
    async verify(raw) {
      const parsed = parseCredential(raw, prefix);
      if (!parsed) return null;

      const record = await this.getActive(parsed.id);
      if (!record) {
        // Cost the same as a wrong secret rather than answering faster.
        await decoyHash(parsed.secret);
        return null;
      }
      return (await secretMatches(parsed.secret, record)) ? record : null;
    },

    list: () => store.listSafe(),
  };
}
