#!/usr/bin/env node
/**
 * Access administration: invite keys for the web client, pairing tokens and
 * device credentials for the desktop app.
 *
 * Every secret this prints is shown once and is unrecoverable afterwards —
 * only its hash is stored. A lost credential is replaced, not looked up.
 */

import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { createKeyStore } from '../src/keys.js';
import { createPairingStore } from '../src/pairings.js';
import { createDeviceStore } from '../src/devices.js';

try {
  process.loadEnvFile('.env');
} catch {
  // No .env locally is fine; defaults below cover development.
}

const publicHost = process.env.PUBLIC_HOST ?? 'localhost:3000';
const scheme = publicHost.startsWith('localhost') ? 'http' : 'https';

const quiet = { info() {}, warn() {}, error() {} };
const keys = createKeyStore({ file: process.env.KEY_STORE_FILE ?? 'server/data/keys.json' });
const pairings = createPairingStore({
  file: process.env.PAIRING_STORE_FILE ?? 'server/data/pairings.json',
  logger: quiet,
});
const devices = createDeviceStore({
  file: process.env.DEVICE_STORE_FILE ?? 'server/data/devices.json',
  logger: quiet,
});

const USAGE = `
zoia keytool

  Web invite keys
    add --name "Alice" [--expires-in-days N]
    list
    revoke <keyId>

  Desktop pairing tokens — sent as an invite, spent once per machine
    pair:new --name "friends" [--max-activations N] [--expires-in-days N]
             [--invite <path>]                write a zoia-invite.json to send
    pair:list
    pair:revoke <pairingId> [--cascade]      --cascade also revokes its devices

  Devices — one per machine that has paired
    device:list
    device:revoke <deviceId>
`;

function fail(message) {
  console.error(`error: ${message}`);
  console.error(USAGE);
  process.exit(1);
}

function daysFromNow(value) {
  if (!value) return null;
  const days = Number(value);
  if (!Number.isFinite(days) || days <= 0) fail('--expires-in-days must be a positive number');
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

function status(record) {
  if (record.revoked) return 'revoked';
  if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) return 'expired';
  return 'active';
}

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case 'add': {
    const { values } = parseArgs({
      args: rest,
      options: { name: { type: 'string' }, 'expires-in-days': { type: 'string' } },
    });
    if (!values.name) fail('--name is required');

    const { record, rawKey } = await keys.add({
      name: values.name,
      expiresAt: daysFromNow(values['expires-in-days']),
    });

    console.log(`\n  invite key for ${record.name}`);
    console.log(`  id: ${record.id}`);
    console.log('\n  Send this link — it is shown once and cannot be recovered:\n');
    console.log(`    ${scheme}://${publicHost}/?k=${rawKey}\n`);
    break;
  }

  case 'list': {
    const all = await keys.list();
    if (all.length === 0) {
      console.log('No keys yet. Mint one with: keytool add --name "Alice"');
      break;
    }
    console.table(
      all.map((k) => ({
        id: k.id,
        name: k.name,
        status: status(k),
        lastSeen: k.lastSeen ?? 'never',
      })),
    );
    break;
  }

  case 'revoke': {
    if (!rest[0]) fail('revoke needs a key id (see: keytool list)');
    if (!(await keys.revoke(rest[0]))) fail(`no key with id "${rest[0]}"`);
    console.log(`revoked ${rest[0]} — takes effect on their next request`);
    break;
  }

  case 'pair:new': {
    const { values } = parseArgs({
      args: rest,
      options: {
        name: { type: 'string' },
        'max-activations': { type: 'string' },
        'expires-in-days': { type: 'string' },
        invite: { type: 'string' },
      },
    });
    if (!values.name) fail('--name is required');

    let maxActivations = null;
    if (values['max-activations']) {
      maxActivations = Number(values['max-activations']);
      if (!Number.isInteger(maxActivations) || maxActivations <= 0) {
        fail('--max-activations must be a positive integer');
      }
    }

    const { record, raw } = await pairings.add({
      name: values.name,
      maxActivations,
      expiresAt: daysFromNow(values['expires-in-days']),
    });

    console.log(`\n  pairing token "${record.name}"`);
    console.log(`  id:          ${record.id}`);
    console.log(`  activations: ${maxActivations ?? 'unlimited'}`);

    if (values.invite) {
      // Writing the file is the normal path now. Published builds carry no
      // server and no token, so what a person actually needs to be sent is
      // this, not a token to paste somewhere.
      const invite = { serverUrl: `${scheme}://${publicHost}`, pairingToken: raw };
      // 0600 because this file is the invitation: anyone who can read it can
      // pair a machine, up to the activation cap.
      await writeFile(values.invite, `${JSON.stringify(invite, null, 2)}\n`, { mode: 0o600 });
      console.log(`\n  Wrote ${values.invite} — send it to whoever is joining.`);
      console.log(`  It points at ${invite.serverUrl}`);
      console.log('  Treat it as a credential: it is shown once and cannot be recovered.\n');
    } else {
      console.log('\n  Shown once. Send it as an invite file with --invite <path>,');
      console.log('  or bake it into a private build with make-exe.bat:\n');
      console.log(`    ZOIA_PAIRING_TOKEN=${raw}\n`);
    }

    console.log('  If it leaks: keytool pair:revoke ' + record.id);
    console.log('  Machines already paired keep working; add --cascade to cut them off too.\n');
    break;
  }

  case 'pair:list': {
    const all = await pairings.list();
    if (all.length === 0) {
      console.log('No pairing tokens yet. Mint one with: keytool pair:new --name "v1"');
      break;
    }
    console.table(
      all.map((p) => ({
        id: p.id,
        name: p.name,
        status: status(p),
        activations: `${p.activations}${p.maxActivations === null ? '' : `/${p.maxActivations}`}`,
        lastSeen: p.lastSeen ?? 'never',
      })),
    );
    break;
  }

  case 'pair:revoke': {
    const id = rest[0];
    if (!id) fail('pair:revoke needs a pairing id (see: keytool pair:list)');
    const { values } = parseArgs({
      args: rest.slice(1),
      options: { cascade: { type: 'boolean' } },
    });

    if (!(await pairings.revoke(id))) fail(`no pairing token with id "${id}"`);
    console.log(`revoked pairing token ${id} — no new machines can activate`);

    if (values.cascade) {
      const count = await devices.revokeByPairing(id);
      console.log(`also revoked ${count} device${count === 1 ? '' : 's'} issued by it`);
    } else {
      console.log('machines already paired keep working; re-run with --cascade to cut them off');
    }
    break;
  }

  case 'device:list': {
    const all = await devices.list();
    if (all.length === 0) {
      console.log('No devices paired yet.');
      break;
    }
    console.table(
      all.map((d) => ({
        id: d.id,
        name: d.name,
        status: status(d),
        pairing: d.pairingId,
        lastSeen: d.lastSeen ?? 'never',
      })),
    );
    break;
  }

  case 'device:revoke': {
    if (!rest[0]) fail('device:revoke needs a device id (see: keytool device:list)');
    if (!(await devices.revoke(rest[0]))) fail(`no device with id "${rest[0]}"`);
    console.log(`revoked device ${rest[0]} — it loses access on its next request`);
    break;
  }

  default:
    if (command && command !== '--help' && command !== '-h') fail(`unknown command "${command}"`);
    console.log(USAGE);
}
