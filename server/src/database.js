/**
 * The database: one SQLite file holding every credential and identity —
 * accounts and the machines signed in to them. See ADR 0032.
 *
 * SQLite rather than JSON files, because the server and keytool both write
 * it: a JSON file can be replaced atomically, but two processes reading,
 * changing and writing it back can each undo the other. Here every change is
 * a transaction holding the database's write lock, so that cannot happen, and
 * constraints keep a record that should not exist — a second account with one
 * email, a device of an account that is gone — from being written at all.
 *
 * `node:sqlite` is built into Node, so this adds no dependency and nothing
 * native to build.
 */

import { DatabaseSync, backup } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Every table, as the fields records have in code. Columns are the same names
 * in snake_case. A field not listed here is refused when written, so nothing
 * a store adds can be dropped silently on its way to disk.
 */
export const TABLES = {
  accounts: {
    fields: {
      id: 'text',
      email: 'text',
      name: 'text',
      role: 'text',
      status: 'text',
      salt: 'text',
      hash: 'text',
      createdAt: 'text',
      signupIp: 'text',
      lastSeen: 'text',
      failedLogins: 'integer',
      lockedUntil: 'text',
      approvedAt: 'text',
      approvedBy: 'text',
      statusChangedAt: 'text',
      passwordChangedAt: 'text',
      renamedAt: 'text',
      migratedAt: 'text',
      avatar: 'text',
      avatarChangedAt: 'text',
      // A reset code's salt, hash and expiry; never the code.
      code: 'json',
    },
  },
  devices: {
    fields: {
      id: 'text',
      name: 'text',
      salt: 'text',
      hash: 'text',
      createdAt: 'text',
      lastSeen: 'text',
      expiresAt: 'text',
      revoked: 'bool',
      revokedAt: 'text',
      revokedReason: 'text',
      accountId: 'text',
      avatar: 'text',
      avatarChangedAt: 'text',
      renamedAt: 'text',
    },
  },
  // Text chats (ADR 0035). Their messages are in ScyllaDB; the list is here,
  // beside the accounts that may change it.
  chats: {
    fields: {
      id: 'text',
      name: 'text',
      isDefault: 'bool',
      createdAt: 'text',
      createdBy: 'text',
      renamedAt: 'text',
    },
  },
};

/**
 * Schema versions, applied in order and recorded in `user_version`. A change
 * to the schema is a new entry here, never an edit to an old one: a database
 * already at that version would not see it.
 */
const MIGRATIONS = [
  `
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'admin', 'super_admin')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'disabled')),
    salt TEXT NOT NULL,
    hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    signup_ip TEXT,
    last_seen TEXT,
    failed_logins INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    approved_at TEXT,
    approved_by TEXT,
    status_changed_at TEXT,
    password_changed_at TEXT,
    renamed_at TEXT,
    migrated_at TEXT,
    avatar TEXT,
    avatar_changed_at TEXT,
    code TEXT
  ) STRICT;

  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    salt TEXT NOT NULL,
    hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen TEXT,
    expires_at TEXT,
    revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
    revoked_at TEXT,
    revoked_reason TEXT,
    -- A rejected sign-up is deleted, and the machine it signed in on with it.
    account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    avatar TEXT,
    avatar_changed_at TEXT,
    renamed_at TEXT
  ) STRICT;

  CREATE INDEX devices_by_account ON devices (account_id);
  `,
  `
  CREATE TABLE chats (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
    created_at TEXT NOT NULL,
    created_by TEXT,
    renamed_at TEXT
  ) STRICT;

  -- At most one default chat.
  CREATE UNIQUE INDEX one_default_chat ON chats (is_default) WHERE is_default = 1;

  -- Settings the super admin changes at runtime, such as how many chats there
  -- may be.
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;
  `,
];

const snake = (field) => field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

function toRow(table, record) {
  const { fields } = TABLES[table];
  const row = {};
  for (const [field, value] of Object.entries(record)) {
    const type = fields[field];
    if (!type) throw new Error(`${table} has no field "${field}"`);
    if (value === undefined) continue;
    row[snake(field)] =
      value === null
        ? null
        : type === 'bool'
          ? value
            ? 1
            : 0
          : type === 'json'
            ? JSON.stringify(value)
            : value;
  }
  return row;
}

/** A row as a record. Every field is present, null when it is not set. */
function fromRow(table, row) {
  const record = {};
  for (const [field, type] of Object.entries(TABLES[table].fields)) {
    const value = row[snake(field)];
    record[field] =
      value === null
        ? null
        : type === 'bool'
          ? value === 1
          : type === 'json'
            ? JSON.parse(value)
            : value;
  }
  return record;
}

function insertRow(sqlite, table, record) {
  const row = toRow(table, record);
  const names = Object.keys(row);
  sqlite
    .prepare(
      `INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
    )
    .run(...names.map((n) => row[n]));
}

/**
 * Opens (creating if need be) the database at `file`. The file is readable by
 * this user only: it holds password hashes and every email. SQLite gives its
 * -wal and -shm files the same permissions.
 */
export function openDatabase(file) {
  if (file !== ':memory:') {
    mkdirSync(dirname(file), { recursive: true });
    if (!existsSync(file)) writeFileSync(file, '', { mode: 0o600 });
    chmodSync(file, 0o600);
  }

  const sqlite = new DatabaseSync(file);
  // WAL so a reader never waits on a writer; FULL so a commit that returned
  // is on disk, not in a cache a power cut loses. busy_timeout lets keytool
  // and the server wait their turn for the write lock instead of failing.
  sqlite.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);

  const version = sqlite.prepare('PRAGMA user_version').get().user_version;
  for (let next = version; next < MIGRATIONS.length; next += 1) {
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      sqlite.exec(MIGRATIONS[next]);
      sqlite.exec(`PRAGMA user_version = ${next + 1}`);
      sqlite.exec('COMMIT');
    } catch (err) {
      sqlite.exec('ROLLBACK');
      throw err;
    }
  }

  // One queue for every table. node:sqlite is one connection, and a change
  // whose callback awaits must not have another table's change start a
  // transaction on that connection in the middle of it.
  let queue = Promise.resolve();

  return {
    sqlite,

    /**
     * Runs `fn` inside a write transaction, after any already queued. It
     * commits if `fn` resolves and rolls back if it throws, so a change is
     * all there or not at all.
     */
    transaction(fn) {
      const run = queue.then(async () => {
        sqlite.exec('BEGIN IMMEDIATE');
        try {
          const result = await fn();
          sqlite.exec('COMMIT');
          return result;
        } catch (err) {
          sqlite.exec('ROLLBACK');
          throw err;
        }
      });
      // A failed change must not wedge every later one.
      queue = run.catch(() => {});
      return run;
    },

    /**
     * Copies the database to `path` while the server keeps running: SQLite's
     * online backup, so the copy is consistent even mid-write. Readable by
     * this user only, like the database itself.
     */
    async backupTo(path) {
      await queue;
      await backup(sqlite, path);
      chmodSync(path, 0o600);
    },

    /** Resolves once queued changes have settled. */
    idle() {
      return queue;
    },

    close() {
      sqlite.close();
    },
  };
}

/**
 * One table, as the collection of records the stores were written against:
 * `mutate(fn)` hands `fn` every record to change in place — push, splice or
 * assign — and writes back exactly what changed, in one transaction.
 */
export function createTableStore({ db, table }) {
  const { sqlite } = db;
  const columns = Object.keys(TABLES[table].fields).map(snake);

  function all() {
    return sqlite
      .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
      .all()
      .map((row) => fromRow(table, row));
  }

  function update(record) {
    const row = toRow(table, record);
    // Every column, so a field deleted from the record is cleared in the row.
    const values = columns.map((c) => (c in row ? row[c] : null));
    sqlite
      .prepare(`UPDATE ${table} SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
      .run(...values, record.id);
  }

  function mutate(fn) {
    return db.transaction(async () => {
      const records = all();
      const before = new Map(records.map((r) => [r.id, JSON.stringify(r)]));
      const result = await fn(records);

      const after = new Set(records.map((r) => r.id));
      for (const id of before.keys()) {
        if (!after.has(id)) sqlite.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
      }
      for (const record of records) {
        const was = before.get(record.id);
        if (was === undefined) insertRow(sqlite, table, record);
        else if (was !== JSON.stringify(record)) update(record);
      }
      return result;
    });
  }

  return {
    mutate,

    async all() {
      return all();
    },

    async find(id) {
      const row = sqlite.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
      return row ? fromRow(table, row) : null;
    },

    /** Records without salt or hash, so no caller can accidentally log them. */
    async listSafe() {
      return all().map(({ salt: _salt, hash: _hash, ...rest }) => rest);
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
    idle: () => db.idle(),
  };
}
