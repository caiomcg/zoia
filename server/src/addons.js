/**
 * Addons: what the super admin installed, what each may do, and the chats it
 * listens to. See ADR 0041.
 *
 * An addon is a container, run by the addon host, that reaches Zoia only
 * through the addon API with a token minted here. The token is shown once, to
 * the host that starts the container, and kept as a salted hash like every
 * other credential (src/store.js).
 *
 * What an addon may do is the set of permissions the super admin granted at
 * install, from those its manifest asked for. Every addon request is checked
 * against the set as it stands in the database then, so disabling an addon or
 * narrowing it takes effect on its next request.
 *
 * Validation failures come back as `{ ok: false, reason }` rather than thrown,
 * as in channels.js.
 */

import { randomBytes } from 'node:crypto';

import { createTableStore } from './database.js';
import { decoyHash, newCredential, parseCredential, secretMatches } from './store.js';

/** What a token looks like: `zaddon_<addon id>_<secret>`. */
export const TOKEN_PREFIX = 'zaddon';

/**
 * Everything an addon may be allowed, and what each means. The descriptions
 * are what the super admin reads before granting them.
 */
export const PERMISSIONS = {
  'chat.read': 'Read the messages written in the chats it is bound to',
  'chat.write': 'Write in the chats it is bound to, as one of its bots',
  commands: 'Answer ! commands in the chats it is bound to',
  'channels.read': 'See the channels, and who is in each',
  'users.read': 'See names, roles and pictures of everyone, never their email',
  'users.manage': 'Disable, enable and move people who are not admins',
  'bots.create': 'Create bot users of its own, which are never admins',
  'voice.publish': 'Talk or play audio in a channel, as one of its bots',
  'video.publish': 'Share video in a channel, as one of its bots',
  'server.read': "Read the server's name and limits",
};

/** The kinds of setting a manifest may ask for; the app draws each. */
export const SETTING_TYPES = ['string', 'secret', 'number', 'boolean', 'select', 'chat', 'channel'];

const ADDON_KEY = /^[a-z][a-z0-9-]{1,31}$/;
const COMMAND_NAME = /^[a-z][a-z0-9-]{0,23}$/;
const SETTING_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
/**
 * Images are pulled by digest only, so what runs is exactly what the super
 * admin installed, whatever is pushed to the tag afterwards.
 */
const IMAGE = /^ghcr\.io\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+@sha256:[0-9a-f]{64}$/;
/** `owner/name`, as GitHub allows them. */
export const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

const MAX_COMMANDS = 20;
const MAX_SETTINGS = 30;
const TEXT_MAX = 300;
const VALUE_MAX = 2000;

const text = (value, max) =>
  typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null;

/** A command's name as it is typed after the !, or null. */
export function cleanCommandName(name) {
  if (typeof name !== 'string') return null;
  const tidy = name.trim().replace(/^!/, '').toLowerCase();
  return COMMAND_NAME.test(tidy) ? tidy : null;
}

function cleanSettingSchema(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const key = typeof raw.key === 'string' && SETTING_KEY.test(raw.key) ? raw.key : null;
  const label = text(raw.label, 80);
  if (!key || !label || !SETTING_TYPES.includes(raw.type)) return null;
  const setting = { key, type: raw.type, label };
  const description = text(raw.description, TEXT_MAX);
  if (description) setting.description = description;
  if (raw.required === true) setting.required = true;
  if (raw.type === 'select') {
    if (!Array.isArray(raw.options) || raw.options.length === 0 || raw.options.length > 50) {
      return null;
    }
    const options = raw.options.map((o) => ({
      value: text(o?.value, 100),
      label: text(o?.label, 80),
    }));
    if (options.some((o) => !o.value || !o.label)) return null;
    setting.options = options;
  }
  if (raw.type === 'number') {
    for (const bound of ['min', 'max']) {
      if (raw[bound] !== undefined) {
        if (!Number.isFinite(raw[bound])) return null;
        setting[bound] = raw[bound];
      }
    }
  }
  // Secrets have no default: a default would be a secret everyone can read.
  if (raw.default !== undefined && raw.type !== 'secret') {
    const value = cleanSettingValue(setting, raw.default);
    if (value === undefined) return null;
    setting.default = value;
  }
  return setting;
}

/** A value as the setting takes it, or undefined when it does not fit. */
function cleanSettingValue(setting, value) {
  if (value === null) return setting.required ? undefined : null;
  switch (setting.type) {
    case 'string':
    case 'secret':
    case 'chat':
    case 'channel':
      return typeof value === 'string' && value.length <= VALUE_MAX ? value : undefined;
    case 'number':
      if (!Number.isFinite(value)) return undefined;
      if (setting.min !== undefined && value < setting.min) return undefined;
      if (setting.max !== undefined && value > setting.max) return undefined;
      return value;
    case 'boolean':
      return typeof value === 'boolean' ? value : undefined;
    case 'select':
      return setting.options.some((o) => o.value === value) ? value : undefined;
    default:
      return undefined;
  }
}

/**
 * Checks a manifest, `zoia-addon.json`, as a release published it. Anything
 * not understood is a refusal, never ignored: a manifest is what the super
 * admin is asked to trust.
 */
export function validateManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'invalid_manifest' };
  }
  const fail = (field) => ({ ok: false, reason: 'invalid_manifest', field });

  const key = typeof raw.id === 'string' && ADDON_KEY.test(raw.id) ? raw.id : null;
  if (!key) return fail('id');
  const name = text(raw.name, 40);
  if (!name) return fail('name');
  const version = typeof raw.version === 'string' && VERSION.test(raw.version) ? raw.version : null;
  if (!version) return fail('version');
  const image = typeof raw.image === 'string' && IMAGE.test(raw.image) ? raw.image : null;
  if (!image) return fail('image');
  const description = raw.description === undefined ? null : text(raw.description, TEXT_MAX);
  if (raw.description !== undefined && !description) return fail('description');

  const permissions = raw.permissions ?? [];
  if (
    !Array.isArray(permissions) ||
    permissions.some((p) => !Object.hasOwn(PERMISSIONS, p)) ||
    new Set(permissions).size !== permissions.length
  ) {
    return fail('permissions');
  }

  const commands = [];
  for (const command of raw.commands ?? []) {
    const commandName = cleanCommandName(command?.name);
    const about = text(command?.description, 120);
    if (!commandName || !about || commands.some((c) => c.name === commandName)) {
      return fail('commands');
    }
    const usage = command.usage === undefined ? null : text(command.usage, 80);
    if (command.usage !== undefined && !usage) return fail('commands');
    commands.push({ name: commandName, description: about, ...(usage ? { usage } : {}) });
  }
  if (!Array.isArray(raw.commands ?? []) || commands.length > MAX_COMMANDS) return fail('commands');
  if (commands.length > 0 && !permissions.includes('commands')) return fail('commands');

  const settings = [];
  for (const entry of raw.settings ?? []) {
    const setting = cleanSettingSchema(entry);
    if (!setting || settings.some((s) => s.key === setting.key)) return fail('settings');
    settings.push(setting);
  }
  if (!Array.isArray(raw.settings ?? []) || settings.length > MAX_SETTINGS) return fail('settings');

  return {
    ok: true,
    manifest: {
      id: key,
      name,
      version,
      image,
      ...(description ? { description } : {}),
      permissions,
      commands,
      settings,
    },
  };
}

/**
 * New values for an addon's settings, checked against its manifest. A key
 * left out keeps its value, so a secret is not wiped by a save that did not
 * send it back; null clears one.
 */
export function mergeSettings(schema, previous, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: 'invalid_settings' };
  }
  const next = { ...previous };
  for (const [key, value] of Object.entries(input)) {
    const setting = schema.find((s) => s.key === key);
    if (!setting) return { ok: false, reason: 'invalid_settings', field: key };
    const clean = cleanSettingValue(setting, value);
    if (clean === undefined) return { ok: false, reason: 'invalid_settings', field: key };
    if (clean === null) delete next[key];
    else next[key] = clean;
  }
  return { ok: true, settings: next };
}

/** Settings with every default filled in, as the addon itself reads them. */
export function effectiveSettings(schema, stored) {
  const values = {};
  for (const setting of schema) {
    const value = stored?.[setting.key] ?? setting.default;
    if (value !== undefined) values[setting.key] = value;
  }
  return values;
}

/**
 * Settings as the app is shown them: a secret is only whether it is set, so
 * one typed once is never sent anywhere but to its addon.
 */
export function shownSettings(schema, stored) {
  const values = effectiveSettings(schema, stored);
  for (const setting of schema) {
    if (setting.type === 'secret') values[setting.key] = { set: Boolean(stored?.[setting.key]) };
  }
  return values;
}

/** An addon as it leaves this file: no salt, no hash. */
function safe(record) {
  return record ? withoutSecrets(record) : null;
}

function withoutSecrets({ salt: _salt, hash: _hash, ...rest }) {
  return rest;
}

/** Canonical command → the name it is typed as here, every command present. */
function commandNames(manifest, stored) {
  const names = {};
  for (const command of manifest.commands)
    names[command.name] = stored?.[command.name] ?? command.name;
  return names;
}

export function createAddonStore({ db, logger = console }) {
  const table = createTableStore({ db, table: 'addons' });
  const bindings = createTableStore({ db, table: 'addon_bindings' });

  async function get(id) {
    return typeof id === 'string' ? safe(await table.find(id)) : null;
  }

  function newId(records) {
    for (;;) {
      const id = randomBytes(4).toString('hex');
      if (!records.some((r) => r.id === id)) return id;
    }
  }

  return {
    get,

    async list() {
      return (await table.all()).map(safe);
    },

    /**
     * Records an addon from its checked manifest, granted everything it asked
     * for, and disabled until its container is running. Returns its token,
     * once: it is the only time it exists outside the container.
     */
    async install({ repo, manifest, by }) {
      if (typeof repo !== 'string' || !REPO.test(repo))
        return { ok: false, reason: 'invalid_repo' };
      const { secret, salt, hash } = await newCredential(TOKEN_PREFIX);
      const result = await table.mutate((records) => {
        if (records.some((r) => r.key === manifest.id)) return { ok: false, reason: 'installed' };
        if (records.some((r) => r.repo.toLowerCase() === repo.toLowerCase())) {
          return { ok: false, reason: 'installed' };
        }
        const record = {
          id: newId(records),
          key: manifest.id,
          repo,
          name: manifest.name,
          version: manifest.version,
          image: manifest.image,
          manifest,
          granted: [...manifest.permissions],
          enabled: false,
          settings: {},
          commands: {},
          salt,
          hash,
          installedAt: new Date().toISOString(),
          installedBy: by ?? null,
          updatedAt: null,
        };
        records.push(record);
        return { ok: true, addon: safe(record) };
      });
      if (!result.ok) return result;
      logger.info(
        `[addon] ${result.addon.id} (${manifest.id} ${manifest.version}) installed by ${by}`,
      );
      return { ...result, token: `${TOKEN_PREFIX}_${result.addon.id}_${secret}` };
    },

    /**
     * Moves an addon to a newer release. Permissions it did not have before
     * are granted only when the super admin said so, having seen them.
     */
    async upgrade(id, manifest, { grant = false, by } = {}) {
      const result = await table.mutate((records) => {
        const record = records.find((r) => r.id === id);
        if (!record) return { ok: false, reason: 'not_found' };
        if (record.key !== manifest.id) return { ok: false, reason: 'different_addon' };
        const added = manifest.permissions.filter((p) => !record.granted.includes(p));
        if (added.length > 0 && !grant) return { ok: false, reason: 'needs_permissions', added };
        Object.assign(record, {
          name: manifest.name,
          version: manifest.version,
          image: manifest.image,
          manifest,
          granted: [...manifest.permissions],
          updatedAt: new Date().toISOString(),
        });
        // Settings and command names the new release no longer has go.
        const keys = new Set(manifest.settings.map((s) => s.key));
        record.settings = Object.fromEntries(
          Object.entries(record.settings).filter(([key]) => keys.has(key)),
        );
        const commands = new Set(manifest.commands.map((c) => c.name));
        record.commands = Object.fromEntries(
          Object.entries(record.commands).filter(([key]) => commands.has(key)),
        );
        return { ok: true, addon: safe(record) };
      });
      if (result.ok) logger.info(`[addon] ${id} updated to ${manifest.version} by ${by}`);
      return result;
    },

    async setEnabled(id, enabled, { by } = {}) {
      const result = await table.mutate((records) => {
        const record = records.find((r) => r.id === id);
        if (!record) return { ok: false, reason: 'not_found' };
        record.enabled = Boolean(enabled);
        return { ok: true, addon: safe(record) };
      });
      if (result.ok) logger.info(`[addon] ${id} ${enabled ? 'enabled' : 'disabled'} by ${by}`);
      return result;
    },

    async setSettings(id, input) {
      return table.mutate((records) => {
        const record = records.find((r) => r.id === id);
        if (!record) return { ok: false, reason: 'not_found' };
        const merged = mergeSettings(record.manifest.settings, record.settings, input);
        if (!merged.ok) return merged;
        record.settings = merged.settings;
        return { ok: true, addon: safe(record) };
      });
    },

    /**
     * What each command is typed as on this server: the super admin's names,
     * the same for everyone. Two commands of one addon cannot share a name.
     */
    async setCommandNames(id, input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { ok: false, reason: 'invalid_commands' };
      }
      return table.mutate((records) => {
        const record = records.find((r) => r.id === id);
        if (!record) return { ok: false, reason: 'not_found' };
        const next = { ...record.commands };
        for (const [command, name] of Object.entries(input)) {
          if (!record.manifest.commands.some((c) => c.name === command)) {
            return { ok: false, reason: 'invalid_commands', field: command };
          }
          const clean = name === null ? command : cleanCommandName(name);
          if (!clean) return { ok: false, reason: 'invalid_commands', field: command };
          if (clean === command) delete next[command];
          else next[command] = clean;
        }
        const typed = Object.values(commandNames(record.manifest, next));
        if (new Set(typed).size !== typed.length) return { ok: false, reason: 'duplicate_command' };
        record.commands = next;
        return { ok: true, addon: safe(record) };
      });
    },

    /** A new token, the old one refused from now on. For a fresh container. */
    async rotateToken(id) {
      const { secret, salt, hash } = await newCredential(TOKEN_PREFIX);
      const ok = await table.mutate((records) => {
        const record = records.find((r) => r.id === id);
        if (!record) return false;
        Object.assign(record, { salt, hash });
        return true;
      });
      return ok ? `${TOKEN_PREFIX}_${id}_${secret}` : null;
    },

    /** Deletes the addon; its bots and bindings go with it, by the database. */
    async remove(id, { by } = {}) {
      const result = await table.mutate((records) => {
        const index = records.findIndex((r) => r.id === id);
        if (index < 0) return { ok: false, reason: 'not_found' };
        records.splice(index, 1);
        return { ok: true };
      });
      if (result.ok) logger.info(`[addon] ${id} uninstalled by ${by}`);
      return result;
    },

    /**
     * The addon a token belongs to, as it stands now, or null. A miss costs
     * what a hit costs, as for every credential.
     */
    async authenticate(raw) {
      const parsed = parseCredential(raw, TOKEN_PREFIX);
      const record = parsed ? await table.find(parsed.id) : null;
      if (!record) {
        await decoyHash(parsed?.secret ?? '');
        return null;
      }
      return (await secretMatches(parsed.secret, record)) ? safe(record) : null;
    },

    // ---- chats ----------------------------------------------------------

    async bindingsOf(addonId) {
      return (await bindings.all()).filter((b) => b.addonId === addonId).map((b) => b.chatId);
    },

    /** The chats an addon listens to, replaced as a whole. */
    async setBindings(addonId, chatIds) {
      if (!Array.isArray(chatIds) || chatIds.some((c) => typeof c !== 'string')) {
        return { ok: false, reason: 'invalid_bindings' };
      }
      if (!(await table.find(addonId))) return { ok: false, reason: 'not_found' };
      const wanted = new Set(chatIds);
      const chats = new Set(
        db.sqlite
          .prepare('SELECT id FROM chats')
          .all()
          .map((r) => r.id),
      );
      if ([...wanted].some((c) => !chats.has(c))) return { ok: false, reason: 'unknown_chat' };
      await bindings.mutate((records) => {
        for (let i = records.length - 1; i >= 0; i -= 1) {
          if (records[i].addonId === addonId && !wanted.has(records[i].chatId))
            records.splice(i, 1);
        }
        for (const chatId of wanted) {
          if (!records.some((r) => r.addonId === addonId && r.chatId === chatId)) {
            records.push({
              id: randomBytes(6).toString('hex'),
              addonId,
              chatId,
              createdAt: new Date().toISOString(),
            });
          }
        }
      });
      return { ok: true, chats: [...wanted] };
    },

    /**
     * Every command that may be typed in a chat, from the enabled addons
     * bound to it that were granted commands: what autocomplete offers, and
     * what a message is matched against.
     */
    async commandsIn(chatId) {
      const bound = new Set(
        (await bindings.all()).filter((b) => b.chatId === chatId).map((b) => b.addonId),
      );
      const commands = [];
      for (const addon of await table.all()) {
        if (!bound.has(addon.id) || !addon.enabled || !addon.granted.includes('commands')) continue;
        const names = commandNames(addon.manifest, addon.commands);
        for (const command of addon.manifest.commands) {
          commands.push({
            addonId: addon.id,
            addon: addon.name,
            command: command.name,
            name: names[command.name],
            description: command.description,
            ...(command.usage ? { usage: command.usage } : {}),
          });
        }
      }
      return commands.sort((a, b) => a.name.localeCompare(b.name));
    },

    /** The enabled addons bound to a chat that may read it. */
    async readersOf(chatId) {
      const bound = new Set(
        (await bindings.all()).filter((b) => b.chatId === chatId).map((b) => b.addonId),
      );
      return (await table.all())
        .filter((a) => bound.has(a.id) && a.enabled && a.granted.includes('chat.read'))
        .map((a) => a.id);
    },

    commandNames: (addon) => commandNames(addon.manifest, addon.commands),
  };
}

/**
 * The command a message is, or null: `!name` at its very start, then its
 * arguments. Matched against the names typed on this server.
 */
export function parseCommand(body, commands) {
  if (typeof body !== 'string' || !body.startsWith('!')) return null;
  const match = /^!([^\s]+)(?:\s+([\s\S]*))?$/.exec(body.trim());
  if (!match) return null;
  const typed = match[1].toLowerCase();
  const hits = commands.filter((c) => c.name === typed);
  if (hits.length === 0) return null;
  return { hits, args: (match[2] ?? '').trim() };
}
