/**
 * Invite-key store.
 *
 * A key looks like `zoia_<8 hex id>_<43 char secret>`. The id is public: it
 * selects the record to verify, so a login costs one hash instead of a scan
 * over every record, and it is the safe value to log. The secret is 32 random
 * bytes and is stored only as a scrypt hash.
 *
 * See docs/SECURITY.md for why scrypt rather than argon2id.
 */

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

const PREFIX = 'zoia';
const KEY_LENGTH = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
export const ROLES = ['host', 'viewer'];

// The secret is base64url, whose alphabet includes '_'. Anchoring the pattern
// on the fixed-width id keeps that unambiguous; splitting on '_' would break
// on roughly half of all generated keys.
const KEY_PATTERN = new RegExp(`^${PREFIX}_([0-9a-f]{8})_([A-Za-z0-9_-]{32,})$`);

/** Splits a raw key into its public id and secret. Returns null if malformed. */
export function parseKey(raw) {
  if (typeof raw !== 'string') return null;
  const match = KEY_PATTERN.exec(raw.trim());
  if (!match) return null;
  return { id: match[1], secret: match[2] };
}

async function hashSecret(secret, salt) {
  const derived = await scryptAsync(secret, salt, KEY_LENGTH, SCRYPT_PARAMS);
  return derived.toString('base64');
}

export function isActive(record, now = Date.now()) {
  if (!record || record.revoked) return false;
  if (record.expiresAt && Date.parse(record.expiresAt) <= now) return false;
  return true;
}

export function createKeyStore({ file }) {
  // Serialises writes. The store is a single small JSON file, so a promise
  // chain is enough; anything more would be machinery without a purpose.
  let queue = Promise.resolve();

  async function read() {
    try {
      const raw = await readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      return { version: 1, keys: [], ...parsed };
    } catch (err) {
      if (err.code === 'ENOENT') return { version: 1, keys: [] };
      throw err;
    }
  }

  async function write(store) {
    await mkdir(dirname(file), { recursive: true });
    // Write-then-rename so a crash mid-write cannot truncate the store and
    // lock everyone out.
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, file);
  }

  function mutate(fn) {
    queue = queue.then(async () => {
      const store = await read();
      const result = await fn(store);
      await write(store);
      return result;
    });
    return queue;
  }

  return {
    /**
     * Mints a key. The raw value is returned once and never stored — a lost key
     * is replaced, not recovered.
     */
    async add({ name, role, expiresAt = null }) {
      if (!ROLES.includes(role)) {
        throw new Error(`role must be one of: ${ROLES.join(', ')}`);
      }
      if (!name || !name.trim()) throw new Error('name is required');

      const id = randomBytes(4).toString('hex');
      const secret = randomBytes(32).toString('base64url');
      const salt = randomBytes(16).toString('base64');
      const hash = await hashSecret(secret, salt);

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

      await mutate((store) => {
        store.keys.push(record);
      });

      return { record, rawKey: `${PREFIX}_${id}_${secret}` };
    },

    async list() {
      const store = await read();
      // Never hand back salt or hash, so no caller can accidentally log them.
      return store.keys.map(({ salt: _salt, hash: _hash, ...rest }) => rest);
    },

    async revoke(id) {
      return mutate((store) => {
        const record = store.keys.find((k) => k.id === id);
        if (!record) return false;
        record.revoked = true;
        record.revokedAt = new Date().toISOString();
        return true;
      });
    },

    /** Resolves an id to an active record. Used to re-validate sessions per request. */
    async getActive(id) {
      const store = await read();
      const record = store.keys.find((k) => k.id === id);
      return isActive(record) ? record : null;
    },

    /** Verifies a raw key. Returns the record, or null for any failure. */
    async verify(rawKey) {
      const parsed = parseKey(rawKey);
      if (!parsed) return null;

      const record = await this.getActive(parsed.id);
      if (!record) {
        // Hash anyway so an unknown or revoked id costs the same as a wrong
        // secret, rather than answering noticeably faster.
        await hashSecret(parsed.secret, 'decoy');
        return null;
      }

      const candidate = Buffer.from(await hashSecret(parsed.secret, record.salt));
      const expected = Buffer.from(record.hash);
      if (candidate.length !== expected.length) return null;
      return timingSafeEqual(candidate, expected) ? record : null;
    },

    /**
     * Resolves once all queued writes have settled. `touch` is deliberately
     * fire-and-forget so it never slows a request, which means a write can
     * still be in flight at shutdown or at the end of a test.
     */
    async idle() {
      return queue.catch(() => {});
    },

    /** Records activity. Best-effort: a failure here must not break a request. */
    async touch(id) {
      return mutate((store) => {
        const record = store.keys.find((k) => k.id === id);
        if (record) record.lastSeen = new Date().toISOString();
      }).catch(() => {});
    },
  };
}
