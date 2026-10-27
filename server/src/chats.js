/**
 * Text chats: the list, and how long it may grow. See ADR 0036.
 *
 * There is always a default chat, which can be renamed but never removed.
 * Admins add, rename and remove the others, up to a limit that starts at ten,
 * the default included, and that admins change. The limit is kept in the
 * database rather than the environment so raising it needs no redeploy, and
 * is capped at CHAT_CEILING whatever is asked.
 *
 * The messages themselves are in ScyllaDB (messages.js). Removing a chat here
 * returns it, so the caller can delete its messages there.
 *
 * Validation failures come back as `{ ok: false, reason }` rather than thrown,
 * as in channels.js.
 */

import { randomBytes } from 'node:crypto';

import { createTableStore } from './database.js';
import { cleanChannelName } from './channels.js';
import { createLimitSetting } from './settings.js';

/** Chats that may exist before an admin raises the limit. */
export const DEFAULT_MAX_CHATS = 10;

/** The most chats an admin may allow. */
export const CHAT_CEILING = 50;

export const cleanChatName = cleanChannelName;

export function createChatStore({ db, defaultName = 'Geral', logger = console }) {
  const table = createTableStore({ db, table: 'chats' });
  const limit = createLimitSetting({
    db,
    key: 'chats.max',
    fallback: DEFAULT_MAX_CHATS,
    max: CHAT_CEILING,
  });

  // Created on open, so every later read finds it.
  const ready = table.mutate((chats) => {
    if (chats.some((c) => c.isDefault)) return;
    const chat = {
      id: randomBytes(4).toString('hex'),
      name: cleanChatName(defaultName) ?? 'Geral',
      isDefault: true,
      createdAt: new Date().toISOString(),
      createdBy: null,
    };
    chats.push(chat);
    logger.info(`[chat] created default chat ${chat.id}`);
  });

  /** Chats, the default first, then in the order they were added. */
  async function list() {
    await ready;
    const chats = await table.all();
    return [...chats.filter((c) => c.isDefault), ...chats.filter((c) => !c.isDefault)];
  }

  return {
    ready,
    list,

    async find(id) {
      await ready;
      return typeof id === 'string' ? table.find(id) : null;
    },

    async max() {
      await ready;
      return limit.get();
    },

    /**
     * Sets how many chats there may be. Lowering it below how many exist
     * removes none; it only stops new ones until enough are removed.
     */
    async setMax(value, { by } = {}) {
      await ready;
      const result = await limit.set(value);
      if (!result.ok) return result;
      logger.info(`[chat] limit set to ${value} by ${by ?? 'keytool'}`);
      return { ok: true, max: value };
    },

    async add({ name, by }) {
      const clean = cleanChatName(name);
      if (!clean) return { ok: false, reason: 'invalid_name' };
      await ready;
      return table.mutate((chats) => {
        if (chats.length >= limit.get()) return { ok: false, reason: 'chat_limit' };
        const chat = {
          id: randomBytes(4).toString('hex'),
          name: clean,
          isDefault: false,
          createdAt: new Date().toISOString(),
          createdBy: by ?? null,
        };
        chats.push(chat);
        logger.info(`[chat] ${chat.id} added by ${by}`);
        return { ok: true, chat };
      });
    },

    async rename(id, name, { by } = {}) {
      const clean = cleanChatName(name);
      if (!clean) return { ok: false, reason: 'invalid_name' };
      await ready;
      return table.mutate((chats) => {
        const chat = chats.find((c) => c.id === id);
        if (!chat) return { ok: false, reason: 'not_found' };
        chat.name = clean;
        chat.renamedAt = new Date().toISOString();
        logger.info(`[chat] ${id} renamed by ${by}`);
        return { ok: true, chat };
      });
    },

    /** Removes a chat that is not the default, and returns it. */
    async remove(id, { by } = {}) {
      await ready;
      return table.mutate((chats) => {
        const index = chats.findIndex((c) => c.id === id);
        if (index === -1) return { ok: false, reason: 'not_found' };
        if (chats[index].isDefault) return { ok: false, reason: 'default_chat' };
        const [chat] = chats.splice(index, 1);
        logger.info(`[chat] ${id} removed by ${by}`);
        return { ok: true, chat };
      });
    },
  };
}
