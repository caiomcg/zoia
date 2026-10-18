/**
 * keytool is how an operator does what the app must not let anyone do —
 * make the super admin — and what nobody in the app can do for a locked-out
 * admin. Its output is a real interface: a code it writes is a credential.
 *
 * Run as a subprocess because that is how it is used, against the same
 * database file the server would have open.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { testStores } from './people.js';

const run = promisify(execFile);

let dir;
let stores;

function keytool(args) {
  return run(process.execPath, ['server/bin/keytool.js', ...args], {
    env: { ...process.env, DATABASE_FILE: join(dir, 'zoia.db') },
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zoia-keytool-'));
  stores = testStores(join(dir, 'zoia.db'));
});

afterEach(async () => {
  await stores.db.idle();
  stores.db.close();
  await rm(dir, { recursive: true, force: true });
});

const signup = (email) =>
  stores.accounts.signup({ email, password: 'A-long-pass-1' }).then((r) => r.account);

describe('account:super', () => {
  test('makes a signed-up account the super admin, approving it', async () => {
    await signup('owner@example.com');
    await keytool(['account:super', 'Owner@Example.com']);
    const [owner] = await stores.accounts.list();
    assert.equal(owner.role, 'super_admin');
    assert.equal(owner.status, 'active');
  });

  test('refuses an email nobody has signed up with', async () => {
    await assert.rejects(keytool(['account:super', 'nobody@example.com']), /no account/);
  });
});

describe('account:reset', () => {
  test('writes a code that sets a new password, and does not print it', async () => {
    const account = await signup('admin@example.com');
    const path = join(dir, 'code.json');
    const { stdout } = await keytool(['account:reset', account.id, '--codes', path]);

    const { code } = JSON.parse(await readFile(path, 'utf8'));
    assert.match(code, /^zcode_[0-9a-f]{8}_/);
    // Writing it to a file and echoing it are different disclosures: terminal
    // output lands in scrollback, screen shares and CI logs.
    assert.ok(!stdout.includes(code), 'the code reached stdout as well as the file');
    const redeemed = await stores.accounts.redeemCode(code, { password: 'A-new-pass-1' });
    assert.equal(redeemed.ok, true);
  });

  test(
    'the file is not world-readable — it is a credential',
    { skip: process.platform === 'win32' && 'Windows has no POSIX file modes' },
    async () => {
      const account = await signup('admin@example.com');
      const path = join(dir, 'code.json');
      await keytool(['account:reset', account.id, '--codes', path]);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    },
  );

  test('refuses to print the code instead of writing it', async () => {
    const account = await signup('admin@example.com');
    await assert.rejects(keytool(['account:reset', account.id]), /--codes/);
  });
});

describe('devices', () => {
  test('lists the machines of an account, and signs one out', async () => {
    const account = await signup('a@example.com');
    const { record } = await stores.devices.issueForAccount({
      name: 'Laptop',
      accountId: account.id,
      cap: 5,
      idleMs: 60_000,
    });

    const { stdout } = await keytool(['device:list', account.id]);
    assert.match(stdout, /Laptop/);

    await keytool(['device:revoke', record.id]);
    assert.equal(await stores.devices.getActive(record.id), null);
  });
});

test('an unknown command fails rather than doing nothing', async () => {
  await assert.rejects(keytool(['pair:new', '--name', 'old habits']), /unknown command/);
});
