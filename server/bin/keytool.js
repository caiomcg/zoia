#!/usr/bin/env node
/**
 * Access administration on the server: accounts, the machines signed in to
 * them, and backups of the database that holds both.
 *
 * Most of this is done from the app by admins (ADR 0031). What lives here is
 * what must not be reachable from the app — making the super admin — and
 * what an operator needs when no admin can help: a reset code for an admin
 * who is locked out, or signing out a machine by hand.
 *
 * Every secret this writes is shown once and is unrecoverable afterwards —
 * only its hash is stored. A lost code is replaced, not looked up.
 */

import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { openStores, storePaths } from '../src/stores.js';
import { isActive } from '../src/store.js';

try {
  process.loadEnvFile('.env');
} catch {
  // No .env locally is fine; defaults below cover development.
}

const quiet = { info() {}, warn() {}, error() {} };
// The same database the server uses, which it may have open right now: every
// write is a transaction, so neither can undo the other's.
const { db, devices, accounts } = openStores({ ...storePaths(), logger: quiet });

const USAGE = `
zoia keytool

  Database — see ADR 0032
    db:backup <path>                         a consistent copy, safe while the server runs

  Accounts — see ADR 0031
    account:list
    account:super <email>                    make this account the one super admin
    account:reset <accountId> --codes <path> write a one-time password reset code

  Devices — one per machine signed in to an account
    device:list [accountId]
    device:revoke <deviceId>                 sign that machine out
`;

function fail(message) {
  console.error(`error: ${message}`);
  console.error(USAGE);
  process.exit(1);
}

/** 0600, like the database: a code is a credential until it is spent. */
async function writeSecretFile(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case 'db:backup': {
    if (!rest[0]) fail('db:backup needs a path to write the copy to');
    await db.backupTo(rest[0]);
    console.log(`backed up to ${rest[0]} — it holds password hashes and emails; keep it private`);
    break;
  }

  case 'account:list': {
    const all = await accounts.list();
    if (all.length === 0) {
      console.log('No accounts yet. People sign up from the app.');
      break;
    }
    console.table(
      all.map((a) => ({
        id: a.id,
        email: a.email,
        name: a.name,
        role: a.role,
        status: a.status,
        lastSeen: a.lastSeen ?? 'never',
      })),
    );
    break;
  }

  case 'account:super': {
    if (!rest[0]) fail('account:super needs the email of an account that has signed up');
    const result = await accounts.setSuper(rest[0]);
    if (!result.ok) fail(`no account with email "${rest[0]}" — sign up from the app first`);
    console.log(`${result.account.name} (${result.account.id}) is now the super admin`);
    for (const id of result.demoted) console.log(`${id} was super admin and is now an admin`);
    break;
  }

  case 'account:reset': {
    const id = rest[0];
    if (!id) fail('account:reset needs an account id (see: keytool account:list)');
    const { values } = parseArgs({
      args: rest.slice(1),
      options: { codes: { type: 'string' } },
    });
    if (!values.codes) fail('--codes <path> is required: the code is written to a file, not shown');
    const account = await accounts.get(id);
    if (!account) fail(`no account with id "${id}"`);
    const issued = await accounts.issueCode(id);
    await writeSecretFile(values.codes, { name: account.name, ...issued });
    console.log(`wrote a reset code for ${account.name} to ${values.codes}`);
    console.log(`it works once, until ${issued.expiresAt}`);
    break;
  }

  case 'device:list': {
    const all = (await devices.list()).filter((d) => !rest[0] || d.accountId === rest[0]);
    if (all.length === 0) {
      console.log('No devices signed in.');
      break;
    }
    console.table(
      all.map((d) => ({
        id: d.id,
        name: d.name,
        account: d.accountId,
        status: isActive(d) ? 'active' : d.revoked ? 'revoked' : 'expired',
        lastSeen: d.lastSeen ?? 'never',
      })),
    );
    break;
  }

  case 'device:revoke': {
    if (!rest[0]) fail('device:revoke needs a device id (see: keytool device:list)');
    if (!(await devices.revoke(rest[0]))) fail(`no device with id "${rest[0]}"`);
    console.log(`revoked device ${rest[0]} — it is signed out on its next request`);
    break;
  }

  default:
    if (command && command !== '--help' && command !== '-h') fail(`unknown command "${command}"`);
    console.log(USAGE);
}
