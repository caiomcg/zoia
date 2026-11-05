/**
 * Direct messages: a private chat between two accounts (ADR 0047).
 *
 * Unlike the chats in chats.js, nobody else sees a direct chat: not other
 * people, not admins, not addons. Its messages go to ScyllaDB under its id
 * like any chat's, and the chat routes check membership on every request.
 *
 * There is one per pair. The pair is kept with the lower account id first,
 * so a constraint stops the same two people getting a second one.
 */

import { randomBytes } from 'node:crypto';

import { createTableStore } from './database.js';

/** A direct chat's id: never the shape of a chat's eight hex characters. */
export const DIRECT_ID = /^dm-[0-9a-f]{16}$/;

export const isDirectId = (id) => typeof id === 'string' && DIRECT_ID.test(id);

const pairOf = (a, b) => (a < b ? [a, b] : [b, a]);

export function createDirectChatStore({ db, logger = console }) {
  const table = createTableStore({ db, table: 'direct_chats' });
  const { sqlite } = db;
  const fromRow = (row) => ({
    id: row.id,
    memberA: row.member_a,
    memberB: row.member_b,
    createdAt: row.created_at,
    createdBy: row.created_by,
    lastMessageAt: row.last_message_at,
  });

  return {
    /** The direct chat by id, or null. Whoever asks must still be checked against its members. */
    async find(id) {
      return isDirectId(id) ? table.find(id) : null;
    },

    /** The pair's chat, made if there is none yet. */
    async open(accountId, otherId) {
      const [memberA, memberB] = pairOf(accountId, otherId);
      return table.mutate((all) => {
        const found = all.find((c) => c.memberA === memberA && c.memberB === memberB);
        if (found) return found;
        const chat = {
          id: `dm-${randomBytes(8).toString('hex')}`,
          memberA,
          memberB,
          createdAt: new Date().toISOString(),
          createdBy: accountId,
          lastMessageAt: null,
        };
        all.push(chat);
        logger.info(`[chat] direct chat ${chat.id} opened by ${accountId}`);
        return chat;
      });
    },

    /**
     * The direct chats `accountId` is in and should see: those with a message,
     * and those they opened themselves. Newest conversation first.
     */
    async listFor(accountId) {
      const rows = sqlite
        .prepare(
          `SELECT * FROM direct_chats
           WHERE (member_a = ? OR member_b = ?)
             AND (last_message_at IS NOT NULL OR created_by = ?)`,
        )
        .all(accountId, accountId, accountId)
        .map(fromRow);
      const at = (c) => c.lastMessageAt ?? c.createdAt;
      return rows.sort((x, y) => (at(x) < at(y) ? 1 : at(x) > at(y) ? -1 : 0));
    },

    /** Stamps when a message was last written, which orders the list and shows it to both. */
    async touch(id, when = new Date()) {
      await db.transaction(() => {
        sqlite
          .prepare('UPDATE direct_chats SET last_message_at = ? WHERE id = ?')
          .run(when.toISOString(), id);
      });
    },
  };
}

/** The member of `chat` who is not `accountId`. */
export const peerOf = (chat, accountId) =>
  chat.memberA === accountId ? chat.memberB : chat.memberA;

export const isMember = (chat, accountId) =>
  chat.memberA === accountId || chat.memberB === accountId;
