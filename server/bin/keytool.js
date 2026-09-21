#!/usr/bin/env node
/**
 * Invite-key administration.
 *
 *   keytool add --name "Alice" [--expires-in-days 30]
 *   keytool list
 *   keytool revoke <keyId>
 */

import { parseArgs } from 'node:util';
import { createKeyStore, ROLES } from '../src/keys.js';

try {
  process.loadEnvFile('.env');
} catch {
  // No .env locally is fine; defaults below cover development.
}

const file = process.env.KEY_STORE_FILE ?? 'server/data/keys.json';
const publicHost = process.env.PUBLIC_HOST ?? 'localhost:3000';
const scheme = publicHost.startsWith('localhost') ? 'http' : 'https';
const store = createKeyStore({ file });

const USAGE = `
zoia keytool — manage invite keys

  keytool add --name "Alice" [--expires-in-days N]
  keytool list
  keytool revoke <keyId>

Store: ${file}
`;

function fail(message) {
  console.error(`error: ${message}`);
  console.error(USAGE);
  process.exit(1);
}

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case 'add': {
    const { values } = parseArgs({
      args: rest,
      options: {
        name: { type: 'string' },
        role: { type: 'string', default: 'member' },
        'expires-in-days': { type: 'string' },
      },
    });

    if (!values.name) fail('--name is required');
    if (!ROLES.includes(values.role)) fail(`--role must be one of: ${ROLES.join(', ')}`);

    let expiresAt = null;
    if (values['expires-in-days']) {
      const days = Number(values['expires-in-days']);
      if (!Number.isFinite(days) || days <= 0) fail('--expires-in-days must be a positive number');
      expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
    }

    const { record, rawKey } = await store.add({
      name: values.name,
      role: values.role,
      expiresAt,
    });

    console.log(`\n  invite key for ${record.name}`);
    console.log(`  id:      ${record.id}`);
    console.log('  anyone with a key may broadcast, one at a time');
    if (expiresAt) console.log(`  expires: ${expiresAt}`);
    console.log(`\n  Send this link — it is shown once and cannot be recovered:\n`);
    console.log(`    ${scheme}://${publicHost}/?k=${rawKey}\n`);
    break;
  }

  case 'list': {
    const keys = await store.list();
    if (keys.length === 0) {
      console.log('No keys yet. Mint one with: keytool add --name "Alice"');
      break;
    }
    const rows = keys.map((k) => ({
      id: k.id,
      name: k.name,
      role: k.role,
      status: k.revoked
        ? 'revoked'
        : k.expiresAt && Date.parse(k.expiresAt) <= Date.now()
          ? 'expired'
          : 'active',
      lastSeen: k.lastSeen ?? 'never',
    }));
    console.table(rows);
    break;
  }

  case 'revoke': {
    const id = rest[0];
    if (!id) fail('revoke needs a key id (see: keytool list)');
    const ok = await store.revoke(id);
    if (!ok) fail(`no key with id "${id}"`);
    console.log(`revoked ${id} — takes effect on their next request`);
    break;
  }

  default:
    if (command && command !== '--help' && command !== '-h') {
      fail(`unknown command "${command}"`);
    }
    console.log(USAGE);
}
