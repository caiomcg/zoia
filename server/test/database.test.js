/**
 * The database is where every credential and identity lives (ADR 0032), so
 * these test what it was chosen for: that a write is never lost to another
 * writer, that the rules hold even for code that forgets them, and that the
 * file is not readable by anyone else on the machine.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { openDatabase } from '../src/database.js';
import { openStores } from '../src/stores.js';

const run = promisify(execFile);
const quiet = { info() {}, warn() {}, error() {} };

let dir;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zoia-db-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('rules the database keeps itself', () => {
  test('two accounts cannot share an email, even past the code that checks', () => {
    const db = openDatabase(join(dir, 'zoia.db'));
    const insert = db.sqlite.prepare(
      `INSERT INTO accounts (id, email, name, role, status, salt, hash, created_at)
       VALUES (?, 'same@example.com', ?, 'user', 'pending', 's', 'h', 'now')`,
    );
    insert.run('aaaaaaaa', 'A');
    assert.throws(() => insert.run('bbbbbbbb', 'B'), /UNIQUE/);
    db.close();
  });

  test('a device cannot belong to an account that does not exist', () => {
    const db = openDatabase(join(dir, 'zoia.db'));
    assert.throws(
      () =>
        db.sqlite
          .prepare(
            `INSERT INTO devices (id, name, salt, hash, created_at, account_id)
             VALUES ('dddddddd', 'PC', 's', 'h', 'now', 'nobody00')`,
          )
          .run(),
      /FOREIGN KEY/,
    );
    db.close();
  });

  test('an account without an email or a password is refused', () => {
    const db = openDatabase(join(dir, 'zoia.db'));
    assert.throws(
      () =>
        db.sqlite
          .prepare(
            `INSERT INTO accounts (id, name, role, status, created_at)
             VALUES ('aaaaaaaa', 'X', 'user', 'active', 'now')`,
          )
          .run(),
      /NOT NULL/,
    );
    db.close();
  });

  test('a role or status that does not exist is refused', () => {
    const db = openDatabase(join(dir, 'zoia.db'));
    const insert = (role, status) =>
      db.sqlite
        .prepare(
          `INSERT INTO accounts (id, email, name, role, status, salt, hash, created_at)
           VALUES (lower(hex(randomblob(4))), lower(hex(randomblob(4))), 'X', ?, ?, 's', 'h', 'now')`,
        )
        .run(role, status);
    assert.throws(() => insert('root', 'active'), /CHECK/);
    assert.throws(() => insert('user', 'approved'), /CHECK/);
    db.close();
  });

  test('a rejected sign-up takes the machine it signed in on with it', async () => {
    const { db, accounts, devices } = openStores({
      databaseFile: join(dir, 'zoia.db'),
      logger: quiet,
    });
    const { account } = await accounts.signup({
      email: 'a@example.com',
      password: 'A-long-pass-1',
    });
    await devices.issueForAccount({ name: 'PC', accountId: account.id, cap: 5, idleMs: 60_000 });
    await accounts.reject(account.id, 'test');
    assert.equal((await devices.all()).length, 0);
    db.close();
  });

  test('a failed change leaves nothing half-written, and later ones still work', async () => {
    const { db, accounts } = openStores({ databaseFile: join(dir, 'zoia.db'), logger: quiet });
    await accounts.signup({ email: 'a@example.com', password: 'A-long-pass-1' });
    const [first] = await accounts.list();

    await assert.rejects(
      db.transaction(async () => {
        db.sqlite.prepare(`UPDATE accounts SET name = 'Changed' WHERE id = ?`).run(first.id);
        throw new Error('halfway');
      }),
      /halfway/,
    );
    assert.equal((await accounts.get(first.id)).name, 'a');
    assert.equal(
      (await accounts.signup({ email: 'b@example.com', password: 'A-long-pass-1' })).ok,
      true,
    );
    db.close();
  });
});

describe('two writers', () => {
  test('the server and keytool writing at once lose nothing', async () => {
    const file = join(dir, 'zoia.db');
    // Room for every sign-up below to wait for approval at once.
    const { db, accounts, devices } = openStores({
      databaseFile: file,
      maxPending: 50,
      logger: quiet,
    });
    const { account } = await accounts.signup({
      email: 'owner@example.com',
      password: 'A-long-pass-1',
    });
    const machines = [];
    for (let i = 0; i < 5; i += 1) {
      const { record } = await devices.issueForAccount({
        name: `PC ${i}`,
        accountId: account.id,
        cap: 10,
        idleMs: 60_000,
      });
      machines.push(record.id);
    }

    // Five keytool processes signing machines out, and twenty sign-ups here,
    // all at once. With a JSON file each reads, changes and writes back the
    // whole file, and whichever finishes last silently undoes the others.
    const env = { ...process.env, DATABASE_FILE: file };
    const tools = machines.map((id) =>
      run(process.execPath, ['server/bin/keytool.js', 'device:revoke', id], { env }),
    );
    const here = Array.from({ length: 20 }, (_, i) =>
      accounts.signup({ email: `user${i}@example.com`, password: 'A-long-pass-1' }),
    );
    await Promise.all([...tools, ...here]);

    assert.equal((await accounts.list()).length, 21);
    assert.equal((await devices.listByAccount(account.id)).length, 0);
    db.close();
  });
});

describe('backups', () => {
  test('keytool copies the database while it is open, and the copy is whole', async () => {
    const file = join(dir, 'zoia.db');
    const { db, accounts } = openStores({ databaseFile: file, logger: quiet });
    await accounts.signup({ email: 'a@example.com', password: 'A-long-pass-1' });

    const copy = join(dir, 'backup.db');
    await run(process.execPath, ['server/bin/keytool.js', 'db:backup', copy], {
      env: { ...process.env, DATABASE_FILE: file },
    });
    db.close();

    const restored = openStores({ databaseFile: copy, logger: quiet });
    assert.deepEqual(
      (await restored.accounts.list()).map((a) => a.email),
      ['a@example.com'],
    );
    restored.db.close();
  });
});

describe('the file', () => {
  test(
    'is readable by the server only',
    { skip: process.platform === 'win32' && 'Windows has no POSIX file modes' },
    async () => {
      const file = join(dir, 'zoia.db');
      const { db, accounts } = openStores({ databaseFile: file, logger: quiet });
      await accounts.signup({ email: 'a@example.com', password: 'A-long-pass-1' });
      db.close();
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    },
  );
});
