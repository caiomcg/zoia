#!/usr/bin/env node
/**
 * Access administration: accounts, invite keys for the web client, pairing
 * tokens and device credentials for the desktop app.
 *
 * Every secret this prints is shown once and is unrecoverable afterwards —
 * only its hash is stored. A lost credential is replaced, not looked up.
 */

import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { createKeyStore } from '../src/keys.js';
import { createPairingStore } from '../src/pairings.js';
import { createDeviceStore } from '../src/devices.js';
import { createAccountStore } from '../src/accounts.js';
import { createAvatarStore } from '../src/avatars.js';
import { isActive } from '../src/store.js';
import { nameKey } from '../src/names.js';

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
const accounts = createAccountStore({
  file: process.env.ACCOUNT_STORE_FILE ?? 'server/data/accounts.json',
  logger: quiet,
});
const avatars = createAvatarStore({ dir: process.env.AVATAR_DIR ?? 'server/data/avatars' });
const deviceIdleMs = Number(process.env.ACCOUNT_DEVICE_IDLE_DAYS ?? 60) * 86_400_000;
// Long enough for everyone to open the app once; an admin can issue a new one.
const CLAIM_CODE_TTL_MS = 14 * 86_400_000;

const USAGE = `
zoia keytool

  Accounts — see ADR 0031
    account:list
    account:super <email>                    make this account the one super admin
    account:reset <accountId> --codes <path> write a one-time reset (or claim) code
    account:migrate --plan <path>            group devices from before accounts
    account:migrate --apply <path> --codes <path>
                                             create those accounts, write claim codes

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

/** 0600, like an invite file: a code is a credential until it is spent. */
async function writeSecretFile(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Live devices from before accounts, grouped into the people they probably
 * are: "Diego", "Diego 2" and "Diego 3" are one person, because the numbers
 * were only ever added to keep names unique. It is a guess; the plan is a
 * file so the operator can correct it before anything is applied.
 */
function migrationPlan(records) {
  const groups = new Map();
  for (const d of records.filter((r) => isActive(r) && !r.accountId)) {
    const base = d.name.replace(/\s+\d+$/, '').trim() || d.name;
    const key = nameKey(base);
    if (!groups.has(key)) groups.set(key, { name: base, devices: [] });
    groups.get(key).devices.push({ id: d.id, name: d.name, lastSeen: d.lastSeen ?? null });
  }
  return { accounts: [...groups.values()] };
}

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case 'account:list': {
    const all = await accounts.list();
    if (all.length === 0) {
      console.log('No accounts yet. People sign up from the app.');
      break;
    }
    console.table(
      all.map((a) => ({
        id: a.id,
        email: a.email ?? '(unclaimed)',
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
    const kind = account.email ? 'reset' : 'claim';
    const issued = await accounts.issueCode(id, kind, {
      ...(kind === 'claim' ? { ttlMs: CLAIM_CODE_TTL_MS } : {}),
    });
    await writeSecretFile(values.codes, [{ name: account.name, ...issued }]);
    console.log(`wrote a ${kind} code for ${account.name} to ${values.codes}`);
    console.log(`it works once, until ${issued.expiresAt}`);
    break;
  }

  case 'account:migrate': {
    const { values } = parseArgs({
      args: rest,
      options: {
        plan: { type: 'string' },
        apply: { type: 'string' },
        codes: { type: 'string' },
      },
    });

    if (values.plan) {
      const plan = migrationPlan(await devices.all());
      await writeFile(values.plan, `${JSON.stringify(plan, null, 2)}\n`);
      console.log(`wrote ${plan.accounts.length} accounts to ${values.plan}:`);
      for (const a of plan.accounts) {
        console.log(`  ${a.name}: ${a.devices.map((d) => d.name).join(', ')}`);
      }
      console.log('\nCorrect it if a guess is wrong, then run --apply with it.');
      break;
    }

    if (!values.apply) fail('account:migrate needs --plan <path> or --apply <path>');
    if (!values.codes) fail('--codes <path> is required: claim codes are written to a file');

    const plan = JSON.parse(await readFile(values.apply, 'utf8'));
    const live = new Map(
      (await devices.all()).filter((r) => isActive(r) && !r.accountId).map((r) => [r.id, r]),
    );
    const issued = [];
    for (const entry of plan.accounts ?? []) {
      // Devices already migrated, revoked or unknown are left out, so a plan
      // can be applied again after a partial run.
      const own = (entry.devices ?? []).map((d) => live.get(d.id)).filter(Boolean);
      if (own.length === 0) continue;

      const account = await accounts.createClaimable({ name: entry.name });
      // The newest picture among the person's devices becomes theirs.
      const pictured = own
        .filter((d) => d.avatar)
        .sort((a, b) => Date.parse(b.avatarChangedAt ?? 0) - Date.parse(a.avatarChangedAt ?? 0));
      const picture = pictured[0] ? await avatars.read(pictured[0].id) : null;
      if (picture) {
        await accounts.setAvatar(account.id, await avatars.save(account.id, picture.bytes));
      }

      await devices.assignAccount(
        own.map((d) => d.id),
        account.id,
        { idleMs: deviceIdleMs },
      );
      const code = await accounts.issueCode(account.id, 'claim', { ttlMs: CLAIM_CODE_TTL_MS });
      issued.push({ name: account.name, accountId: account.id, ...code });
      console.log(`  ${account.name} (${account.id}): ${own.length} device(s)`);
    }

    await writeSecretFile(values.codes, issued);
    console.log(`\ncreated ${issued.length} accounts; claim codes are in ${values.codes}`);
    console.log('Send each person theirs. Their devices keep working until they claim it.');
    break;
  }

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
    // Seats are live devices against the cap; activations is the lifetime
    // tally, which keeps growing as revoked machines are replaced.
    const rows = [];
    for (const p of all) {
      const seats = await devices.countActiveByPairing(p.id);
      rows.push({
        id: p.id,
        name: p.name,
        status: status(p),
        seats: `${seats}${p.maxActivations === null ? '' : `/${p.maxActivations}`}`,
        activations: p.activations,
        lastSeen: p.lastSeen ?? 'never',
      });
    }
    console.table(rows);
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
