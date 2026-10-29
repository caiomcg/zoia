/**
 * Addons, ADR 0041: what a manifest may ask for, the token that is an addon,
 * the bots it may have, and the chats it listens to. Most of what is worth
 * testing is what does not get through: a manifest asking for something that
 * does not exist, a token that is not the addon's, a bot made an admin.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase } from '../src/database.js';
import { createAccountStore, BOTS_PER_ADDON } from '../src/accounts.js';
import { createChatStore } from '../src/chats.js';
import {
  createAddonStore,
  effectiveSettings,
  parseCommand,
  shownSettings,
  validateManifest,
} from '../src/addons.js';

const quiet = { info() {}, warn() {}, error() {} };
const DIGEST = 'a'.repeat(64);

/** A manifest that passes, changed by `extra`. */
export function manifest(extra = {}) {
  return {
    id: 'zouve',
    name: 'Zouve',
    version: '1.0.0',
    image: `ghcr.io/caiomcg/zouve@sha256:${DIGEST}`,
    permissions: ['chat.read', 'chat.write', 'commands', 'bots.create', 'voice.publish'],
    commands: [
      { name: 'play', description: 'Plays a song', usage: '<link or search>' },
      { name: 'skip', description: 'Skips the song' },
    ],
    settings: [
      { key: 'volume', type: 'number', label: 'Volume', min: 0, max: 100, default: 50 },
      { key: 'spotifySecret', type: 'secret', label: 'Spotify secret' },
    ],
    ...extra,
  };
}

let dir;
let db;
let addons;
let accounts;
let chats;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zoia-addons-'));
  db = openDatabase(join(dir, 'zoia.db'));
  addons = createAddonStore({ db, logger: quiet });
  accounts = createAccountStore({ db, logger: quiet });
  chats = createChatStore({ db, logger: quiet });
  await chats.ready;
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

async function install(extra = {}) {
  const checked = validateManifest(manifest(extra));
  assert.ok(checked.ok, JSON.stringify(checked));
  const result = await addons.install({
    repo: 'caiomcg/zouve',
    manifest: checked.manifest,
    by: 'su',
  });
  assert.ok(result.ok, JSON.stringify(result));
  return result;
}

describe('manifests', () => {
  test('a good one passes, as it was written', () => {
    const result = validateManifest(manifest());
    assert.equal(result.ok, true);
    assert.equal(result.manifest.id, 'zouve');
    assert.deepEqual(
      result.manifest.commands.map((c) => c.name),
      ['play', 'skip'],
    );
  });

  test('an image is pulled from ghcr.io by digest, never by tag or from elsewhere', () => {
    for (const image of [
      'ghcr.io/caiomcg/zouve:latest',
      `docker.io/caiomcg/zouve@sha256:${DIGEST}`,
      `ghcr.io/zouve@sha256:${DIGEST}`,
      `ghcr.io/caiomcg/zouve@sha256:${'z'.repeat(64)}`,
    ]) {
      assert.equal(validateManifest(manifest({ image })).field, 'image', image);
    }
  });

  test('a permission that does not exist, or asked twice, is refused', () => {
    assert.equal(validateManifest(manifest({ permissions: ['root'] })).field, 'permissions');
    assert.equal(
      validateManifest(manifest({ permissions: ['commands', 'commands'] })).field,
      'permissions',
    );
  });

  test('commands need the commands permission, and names of their own', () => {
    assert.equal(validateManifest(manifest({ permissions: ['chat.read'] })).field, 'commands');
    const twice = [
      { name: 'play', description: 'a' },
      { name: 'PLAY', description: 'b' },
    ];
    assert.equal(validateManifest(manifest({ commands: twice })).field, 'commands');
    const spaced = [{ name: 'pl ay', description: 'a' }];
    assert.equal(validateManifest(manifest({ commands: spaced })).field, 'commands');
  });

  test('settings must be of a known type, and a secret has no default', () => {
    const unknown = [{ key: 'x', type: 'script', label: 'X' }];
    assert.equal(validateManifest(manifest({ settings: unknown })).field, 'settings');
    const secret = [{ key: 'x', type: 'secret', label: 'X', default: 'hunter2' }];
    assert.equal(validateManifest(manifest({ settings: secret })).ok, true);
    assert.equal(
      validateManifest(manifest({ settings: secret })).manifest.settings[0].default,
      undefined,
    );
  });

  test('anything but an object is refused', () => {
    for (const raw of [null, [], 'zouve', 42]) assert.equal(validateManifest(raw).ok, false);
  });
});

describe('the token', () => {
  test('is the addon, and is never stored', async () => {
    const { addon, token } = await install();
    assert.match(token, /^zaddon_[0-9a-f]{8}_/);
    assert.equal((await addons.authenticate(token)).id, addon.id);
    assert.equal(JSON.stringify(await addons.list()).includes(token.split('_').pop()), false);
    assert.equal((await addons.get(addon.id)).hash, undefined);
  });

  test('a wrong or rotated token is refused', async () => {
    const { addon, token } = await install();
    assert.equal(await addons.authenticate(`${token.slice(0, -2)}xx`), null);
    assert.equal(await addons.authenticate('zaddon_deadbeef_' + 'x'.repeat(43)), null);
    const fresh = await addons.rotateToken(addon.id);
    assert.equal(await addons.authenticate(token), null);
    assert.equal((await addons.authenticate(fresh)).id, addon.id);
  });

  test('an addon starts disabled, and is installed once', async () => {
    const { addon } = await install();
    assert.equal(addon.enabled, false);
    const again = await addons.install({
      repo: 'someone/else',
      manifest: validateManifest(manifest()).manifest,
    });
    assert.equal(again.reason, 'installed');
  });
});

describe('updating', () => {
  test('new permissions need the super admin to grant them', async () => {
    const { addon } = await install();
    const wider = validateManifest(
      manifest({ version: '1.1.0', permissions: [...manifest().permissions, 'users.manage'] }),
    ).manifest;
    const refused = await addons.upgrade(addon.id, wider);
    assert.equal(refused.reason, 'needs_permissions');
    assert.deepEqual(refused.added, ['users.manage']);
    const granted = await addons.upgrade(addon.id, wider, { grant: true });
    assert.ok(granted.addon.granted.includes('users.manage'));
    assert.equal(granted.addon.version, '1.1.0');
  });

  test('a release of another addon cannot replace this one', async () => {
    const { addon } = await install();
    const other = validateManifest(manifest({ id: 'other' })).manifest;
    assert.equal((await addons.upgrade(addon.id, other)).reason, 'different_addon');
  });
});

describe('settings', () => {
  test('are checked against the manifest, and a secret is never shown back', async () => {
    const { addon } = await install();
    assert.equal((await addons.setSettings(addon.id, { volume: 101 })).reason, 'invalid_settings');
    assert.equal((await addons.setSettings(addon.id, { unknown: 1 })).reason, 'invalid_settings');
    const saved = await addons.setSettings(addon.id, { volume: 80, spotifySecret: 's3cret' });
    assert.ok(saved.ok);
    const { manifest: m, settings } = saved.addon;
    assert.deepEqual(effectiveSettings(m.settings, settings), {
      volume: 80,
      spotifySecret: 's3cret',
    });
    assert.deepEqual(shownSettings(m.settings, settings), {
      volume: 80,
      spotifySecret: { set: true },
    });
  });

  test('a save without a secret keeps it; null clears it', async () => {
    const { addon } = await install();
    await addons.setSettings(addon.id, { spotifySecret: 's3cret' });
    await addons.setSettings(addon.id, { volume: 10 });
    assert.equal((await addons.get(addon.id)).settings.spotifySecret, 's3cret');
    await addons.setSettings(addon.id, { spotifySecret: null });
    assert.equal((await addons.get(addon.id)).settings.spotifySecret, undefined);
  });
});

describe('commands', () => {
  test('are offered only in bound chats, enabled, under the names set here', async () => {
    const { addon } = await install();
    const [chat] = await chats.list();
    assert.deepEqual(await addons.commandsIn(chat.id), []);
    await addons.setBindings(addon.id, [chat.id]);
    assert.deepEqual(await addons.commandsIn(chat.id), [], 'disabled offers nothing');
    await addons.setEnabled(addon.id, true);
    await addons.setCommandNames(addon.id, { play: 'p' });
    const names = (await addons.commandsIn(chat.id)).map((c) => `${c.name}:${c.command}`);
    assert.deepEqual(names, ['p:play', 'skip:skip']);
  });

  test('two commands of one addon cannot be typed the same', async () => {
    const { addon } = await install();
    assert.equal(
      (await addons.setCommandNames(addon.id, { play: 'skip' })).reason,
      'duplicate_command',
    );
    assert.equal(
      (await addons.setCommandNames(addon.id, { play: 'two words' })).reason,
      'invalid_commands',
    );
    assert.equal(
      (await addons.setCommandNames(addon.id, { nope: 'x' })).reason,
      'invalid_commands',
    );
  });

  test('a message is a command only at its start, by the name typed here', () => {
    const commands = [{ addonId: 'a', command: 'play', name: 'p' }];
    assert.deepEqual(parseCommand('!p  never gonna give', commands), {
      hits: commands,
      args: 'never gonna give',
    });
    assert.equal(parseCommand('!P', commands).args, '');
    assert.equal(parseCommand('!play', commands), null);
    assert.equal(parseCommand('say !p', commands), null);
    assert.equal(parseCommand('!', commands), null);
  });

  test('a chat that does not exist cannot be bound', async () => {
    const { addon } = await install();
    assert.equal((await addons.setBindings(addon.id, ['nope'])).reason, 'unknown_chat');
  });
});

describe('bots', () => {
  test('are plain users that cannot log in, be made admin or reset', async () => {
    const { addon } = await install();
    const { account } = await accounts.createBot({ addonId: addon.id, name: 'Zouve' });
    assert.equal(account.role, 'user');
    assert.equal(account.status, 'active');
    assert.equal(account.addonId, addon.id);
    assert.equal((await accounts.setRole(account.id, 'admin', 'su')).reason, 'forbidden');
    assert.equal(await accounts.issueCode(account.id), null);
    const login = await accounts.authenticate(account.email, '');
    assert.equal(login.reason, 'invalid_login');
  });

  test('are limited per addon, and go when it is uninstalled', async () => {
    const { addon } = await install();
    for (let i = 0; i < BOTS_PER_ADDON; i += 1) {
      assert.ok((await accounts.createBot({ addonId: addon.id, name: 'Bot' })).ok);
    }
    assert.equal(
      (await accounts.createBot({ addonId: addon.id, name: 'Bot' })).reason,
      'bot_limit',
    );
    const names = (await accounts.botsOf(addon.id)).map((b) => b.name);
    assert.equal(new Set(names).size, BOTS_PER_ADDON, 'names stay unique');
    await addons.remove(addon.id);
    assert.deepEqual(await accounts.botsOf(addon.id), []);
  });
});
