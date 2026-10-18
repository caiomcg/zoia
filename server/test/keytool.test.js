/**
 * keytool is the only way an operator mints anything, so its output is a real
 * interface — the invite file it writes is consumed by the desktop app's
 * parser, and the two agreeing is not something either side can check alone.
 *
 * Run as a subprocess because that is how it is used; a pairing token that
 * only works when imported as a module would be no use to anybody.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { createDeviceStore } from '../src/devices.js';
import { createAccountStore } from '../src/accounts.js';

const run = promisify(execFile);

let dir;

/** Mirrors parseCredential in src/store.js, and the desktop app's own check. */
const TOKEN_PATTERN = /^zpair_[0-9a-f]{8}_[A-Za-z0-9_-]{32,}$/;

function keytool(args, env = {}) {
  return run(process.execPath, ['server/bin/keytool.js', ...args], {
    env: {
      ...process.env,
      PUBLIC_HOST: 'zoia.example.com',
      KEY_STORE_FILE: join(dir, 'keys.json'),
      PAIRING_STORE_FILE: join(dir, 'pairings.json'),
      DEVICE_STORE_FILE: join(dir, 'devices.json'),
      ACCOUNT_STORE_FILE: join(dir, 'accounts.json'),
      AVATAR_DIR: join(dir, 'avatars'),
      ...env,
    },
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zoia-keytool-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('pair:new --invite', () => {
  test('writes an invite the desktop app can parse', async () => {
    const path = join(dir, 'zoia-invite.json');
    await keytool(['pair:new', '--name', 'friends', '--max-activations', '2', '--invite', path]);

    const invite = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(invite.serverUrl, 'https://zoia.example.com');
    assert.match(invite.pairingToken, TOKEN_PATTERN);
    // Exactly two fields: anything extra is something the app would ignore,
    // and a field somebody believes is doing work but is not is worse than none.
    assert.deepEqual(Object.keys(invite).sort(), ['pairingToken', 'serverUrl']);
  });

  test('a localhost server gets http, since there is no certificate for it', async () => {
    const path = join(dir, 'invite.json');
    await keytool(['pair:new', '--name', 'dev', '--invite', path], {
      PUBLIC_HOST: 'localhost:3000',
    });

    const invite = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(invite.serverUrl, 'http://localhost:3000');
  });

  // Windows has no POSIX modes: stat reports 0666 whatever was asked for.
  test(
    'the file is not world-readable — it is the invitation',
    {
      skip: process.platform === 'win32' && 'Windows has no POSIX file modes',
    },
    async () => {
      const path = join(dir, 'invite.json');
      await keytool(['pair:new', '--name', 'friends', '--invite', path]);

      const mode = (await stat(path)).mode & 0o777;
      assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
    },
  );

  test('the raw token is not also printed to the terminal', async () => {
    const path = join(dir, 'invite.json');
    const { stdout } = await keytool(['pair:new', '--name', 'friends', '--invite', path]);

    const { pairingToken } = JSON.parse(await readFile(path, 'utf8'));
    // Writing it to a file and echoing it are different disclosures. Terminal
    // output lands in scrollback, in screen shares, and in CI logs.
    assert.ok(!stdout.includes(pairingToken), 'the token reached stdout as well as the file');
    assert.match(stdout, /Wrote /);
  });

  test('without --invite the token is printed, for a private build', async () => {
    const { stdout } = await keytool(['pair:new', '--name', 'private']);
    assert.match(stdout, /ZOIA_PAIRING_TOKEN=zpair_[0-9a-f]{8}_/);
  });

  test('the token in the file is the one that was actually stored', async () => {
    const path = join(dir, 'invite.json');
    await keytool(['pair:new', '--name', 'friends', '--invite', path]);
    const { pairingToken } = JSON.parse(await readFile(path, 'utf8'));

    // Only a hash is persisted, so the id is the link between the two.
    const [, id] = pairingToken.split('_');
    const stored = JSON.parse(await readFile(join(dir, 'pairings.json'), 'utf8'));
    const records = Array.isArray(stored) ? stored : Object.values(stored).flat();
    assert.ok(
      JSON.stringify(records).includes(id),
      'the invite names a pairing id that is not in the store',
    );

    const onDisk = await readFile(join(dir, 'pairings.json'), 'utf8');
    const secret = pairingToken.split('_').slice(2).join('_');
    assert.ok(!onDisk.includes(secret), 'the raw secret reached the store');
  });
});

describe('account:migrate', () => {
  const quiet = { info() {}, warn() {}, error() {} };

  /** Devices from before accounts, as pairing left them. */
  async function paired(names) {
    const devices = createDeviceStore({ file: join(dir, 'devices.json'), logger: quiet });
    const ids = {};
    for (const name of names) {
      const { record } = await devices.issue({ name, pairingId: 'p1' });
      ids[name] = record.id;
    }
    return { devices, ids };
  }

  test('groups numbered names into one person, as a plan to correct', async () => {
    await paired(['Diego', 'Diego 2', 'Diego 3', 'Ana', 'samsung SM-X510']);
    const plan = join(dir, 'plan.json');
    await keytool(['account:migrate', '--plan', plan]);

    const { accounts } = JSON.parse(await readFile(plan, 'utf8'));
    const groups = Object.fromEntries(accounts.map((a) => [a.name, a.devices.length]));
    assert.deepEqual(groups, { Diego: 3, Ana: 1, 'samsung SM-X510': 1 });
  });

  test('applying it moves the devices into accounts and writes claim codes', async () => {
    const { devices, ids } = await paired(['Diego', 'Diego 2', 'Ana']);
    const plan = join(dir, 'plan.json');
    const codes = join(dir, 'codes.json');
    await keytool(['account:migrate', '--plan', plan]);
    const { stdout } = await keytool(['account:migrate', '--apply', plan, '--codes', codes]);

    const issued = JSON.parse(await readFile(codes, 'utf8'));
    assert.deepEqual(issued.map((c) => c.name).sort(), ['Ana', 'Diego']);
    for (const c of issued) {
      assert.equal(c.kind, 'claim');
      assert.match(c.code, /^zcode_[0-9a-f]{8}_/);
      assert.ok(!stdout.includes(c.code), 'a claim code reached stdout as well as the file');
    }

    const accounts = createAccountStore({ file: join(dir, 'accounts.json'), logger: quiet });
    const diego = (await accounts.list()).find((a) => a.name === 'Diego');
    assert.equal(diego.email, null);
    assert.equal(diego.status, 'active');
    const own = (await devices.listByAccount(diego.id)).map((d) => d.id).sort();
    assert.deepEqual(own, [ids.Diego, ids['Diego 2']].sort());

    // Applying again finds nothing left to move, rather than doubling up.
    await keytool(['account:migrate', '--apply', plan, '--codes', join(dir, 'again.json')]);
    assert.equal((await accounts.list()).length, 2);
  });
});

describe('account:super', () => {
  test('makes a signed-up account the super admin, approving it', async () => {
    const quiet = { info() {}, warn() {}, error() {} };
    const accounts = createAccountStore({ file: join(dir, 'accounts.json'), logger: quiet });
    await accounts.signup({ email: 'owner@example.com', password: 'a long password' });

    await keytool(['account:super', 'Owner@Example.com']);
    const [owner] = await accounts.list();
    assert.equal(owner.role, 'super_admin');
    assert.equal(owner.status, 'active');
  });

  test('refuses an email nobody has signed up with', async () => {
    await assert.rejects(keytool(['account:super', 'nobody@example.com']), /no account/);
  });
});
