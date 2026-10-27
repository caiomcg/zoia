/**
 * Limits admins change while the app runs: how many channels and chats there
 * may be. They start where the server says and stay within their range.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase } from '../src/database.js';
import { createLimitSetting } from '../src/settings.js';

let dir;
let db;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zoia-settings-'));
  db = openDatabase(join(dir, 'zoia.db'));
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

const limit = () => createLimitSetting({ db, key: 'things.max', fallback: 5, max: 20 });

describe('a limit setting', () => {
  test('starts at its fallback, and keeps what was set across a reopen', async () => {
    assert.equal(limit().get(), 5);
    assert.deepEqual(await limit().set(12), { ok: true, value: 12 });
    assert.equal(limit().get(), 12);
  });

  test('refuses anything but a whole number in range', async () => {
    for (const value of [0, 21, 3.5, '7', null, undefined]) {
      assert.deepEqual(await limit().set(value), { ok: false, reason: 'invalid_limit' });
    }
    assert.equal(limit().get(), 5);
  });

  test('reads a value written past it within range, or its fallback', () => {
    const write = (value) =>
      db.sqlite
        .prepare(
          `INSERT INTO settings (key, value) VALUES ('things.max', ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        )
        .run(value);
    write('999');
    assert.equal(limit().get(), 20);
    write('-3');
    assert.equal(limit().get(), 1);
    write('lots');
    assert.equal(limit().get(), 5);
  });

  test('two settings do not share a value', async () => {
    const other = createLimitSetting({ db, key: 'others.max', fallback: 1, max: 50 });
    await limit().set(9);
    assert.equal(other.get(), 1);
  });
});
