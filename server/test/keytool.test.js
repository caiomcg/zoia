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

  test('the file is not world-readable — it is the invitation', async () => {
    const path = join(dir, 'invite.json');
    await keytool(['pair:new', '--name', 'friends', '--invite', path]);

    const mode = (await stat(path)).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  });

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
