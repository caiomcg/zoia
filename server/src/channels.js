/**
 * Channels: the rooms people can be in.
 *
 * There is always a default channel. Its id is ROOM_NAME, the room a
 * single-room server already used, and it is where any request that names no
 * channel lands, so clients from before channels keep working. It can be
 * renamed but never removed.
 *
 * Anyone with a session may add channels, up to a fixed total (five by default,
 * the default channel included), rename any channel, and remove an empty one
 * that is not the default. Each channel is its own LiveKit room, with its own
 * stage and WHIP publisher, built on first use.
 *
 * Validation failures come back as `{ ok: false, reason }` rather than thrown:
 * a throw inside the JSON store's write queue would leave the queue rejected,
 * and every later write would fail with it.
 */

import { randomBytes } from 'node:crypto';

import { createJsonStore } from './store.js';

export const DEFAULT_MAX_CHANNELS = 5;
export const CHANNEL_NAME_MAX = 32;

/** A display name, tidied, or null if it is not one. */
export function cleanChannelName(name) {
  if (typeof name !== 'string') return null;
  const tidy = name.replace(/\s+/g, ' ').trim();
  if (!tidy || tidy.length > CHANNEL_NAME_MAX) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(tidy)) return null;
  return tidy;
}

/**
 * @param {object} options
 * @param {string} options.file where added channels and renames are kept
 * @param {string} options.defaultId the default channel's id and LiveKit room
 * @param {(id: string) => { stage: object, whip: object | null }} options.makeRuntime
 */
export function createChannelStore({
  file,
  defaultId,
  defaultName = 'Geral',
  max = DEFAULT_MAX_CHANNELS,
  makeRuntime,
  logger = console,
}) {
  const store = createJsonStore({ file, collection: 'channels' });
  const runtimes = new Map();

  function runtime(id) {
    if (!runtimes.has(id)) runtimes.set(id, makeRuntime(id));
    return runtimes.get(id);
  }

  /** Every channel, the default first, as plain records. */
  function arrange(saved) {
    const stored = saved.find((c) => c.id === defaultId);
    return [
      { id: defaultId, name: stored?.name ?? defaultName, isDefault: true },
      ...saved
        .filter((c) => c.id !== defaultId)
        .map(({ id, name }) => ({ id, name, isDefault: false })),
    ];
  }

  const withRuntime = (channel) => ({ ...channel, ...runtime(channel.id) });

  return {
    defaultId,
    max,

    async list() {
      return arrange(await store.all()).map(withRuntime);
    },

    async get(id) {
      const channel = arrange(await store.all()).find((c) => c.id === id);
      return channel ? withRuntime(channel) : null;
    },

    async create(name, by) {
      const clean = cleanChannelName(name);
      if (!clean) return { ok: false, reason: 'invalid_name' };
      return store.mutate((saved) => {
        if (arrange(saved).length >= max) return { ok: false, reason: 'room_limit' };
        const id = `${defaultId}-${randomBytes(3).toString('hex')}`;
        saved.push({ id, name: clean, createdBy: by?.id, createdAt: new Date().toISOString() });
        logger.info(`[channels] ${by?.name ?? '?'} created "${clean}" (${id})`);
        return { ok: true, channel: { id, name: clean, isDefault: false } };
      });
    },

    async rename(id, name, by) {
      const clean = cleanChannelName(name);
      if (!clean) return { ok: false, reason: 'invalid_name' };
      return store.mutate((saved) => {
        let record = saved.find((c) => c.id === id);
        // The default channel exists without a record until it is renamed.
        if (!record && id === defaultId) {
          record = { id };
          saved.push(record);
        }
        if (!record) return { ok: false, reason: 'unknown_room' };
        record.name = clean;
        record.renamedAt = new Date().toISOString();
        logger.info(`[channels] ${by?.name ?? '?'} renamed ${id} to "${clean}"`);
        return { ok: true, channel: { id, name: clean, isDefault: id === defaultId } };
      });
    },

    /** Removes a channel. Whether it is empty is the caller's check. */
    async remove(id, by) {
      if (id === defaultId) return { ok: false, reason: 'room_is_default' };
      const result = await store.mutate((saved) => {
        const index = saved.findIndex((c) => c.id === id);
        if (index === -1) return { ok: false, reason: 'unknown_room' };
        const [removed] = saved.splice(index, 1);
        logger.info(`[channels] ${by?.name ?? '?'} removed "${removed.name}" (${id})`);
        return { ok: true };
      });
      if (result.ok) runtimes.delete(id);
      return result;
    },
  };
}

/**
 * A fixed set of channels with runtimes already built: what a single-room
 * caller (the tests, mostly) hands createApp. Adding, renaming and removing are
 * refused.
 */
export function fixedChannels(list) {
  const [first] = list;
  const find = (id) => list.find((c) => c.id === id) ?? null;
  const refuse = async () => ({ ok: false, reason: 'channels_fixed' });
  return {
    defaultId: first.id,
    max: list.length,
    list: async () => list.map((c, i) => ({ isDefault: i === 0, ...c })),
    get: async (id) => {
      const channel = find(id);
      return channel ? { isDefault: channel === first, ...channel } : null;
    },
    create: refuse,
    rename: refuse,
    remove: refuse,
  };
}
