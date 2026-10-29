/**
 * The message store, kept in memory, for route tests. messages.test.js
 * covers the real one against ScyllaDB.
 */

import cassandra from 'cassandra-driver';

const { TimeUuid } = cassandra.types;

/**
 * What the routes use of the message store, kept in memory. Messages are in
 * the order sent, so a message's place in `sent` stands in for its time.
 */
export function memoryMessages() {
  const sent = [];
  const markers = new Map();
  const key = (chatId, accountId) => `${chatId}/${accountId}`;
  // [{ chatId, messageId, emoji, accountId }], oldest first.
  const reactions = [];
  const place = (id) => sent.findIndex((m) => m.id === id);
  return {
    async send({ chatId, authorId, body, attachment = null, replyTo = null, mentions = [] }) {
      const id = TimeUuid.now();
      const message = {
        id: id.toString(),
        chatId,
        authorId,
        body,
        sentAt: id.getDate().toISOString(),
        attachment,
        replyTo,
        mentions,
      };
      sent.push(message);
      return message;
    },
    async get({ chatId, id }) {
      return sent.find((m) => m.chatId === chatId && m.id === id) ?? null;
    },
    async remove({ chatId, id }) {
      const at = sent.findIndex((m) => m.chatId === chatId && m.id === id);
      if (at !== -1) sent.splice(at, 1);
      for (let i = reactions.length - 1; i >= 0; i -= 1) {
        if (reactions[i].chatId === chatId && reactions[i].messageId === id) reactions.splice(i, 1);
      }
    },
    async react({ chatId, messageId, accountId, emoji, on = true }) {
      const at = reactions.findIndex(
        (r) =>
          r.chatId === chatId &&
          r.messageId === messageId &&
          r.emoji === emoji &&
          r.accountId === accountId,
      );
      if (on && at === -1) reactions.push({ chatId, messageId, emoji, accountId });
      if (!on && at !== -1) reactions.splice(at, 1);
    },
    async reactions({ chatId, ids }) {
      const out = {};
      for (const r of reactions) {
        if (r.chatId !== chatId || !ids.includes(r.messageId)) continue;
        const list = (out[r.messageId] ??= []);
        let group = list.find((g) => g.emoji === r.emoji);
        if (!group) list.push((group = { emoji: r.emoji, accountIds: [] }));
        group.accountIds.push(r.accountId);
      }
      return out;
    },
    async page({ chatId, before, limit }) {
      const end = before ? place(before) : sent.length;
      return sent
        .slice(0, end === -1 ? 0 : end)
        .filter((m) => m.chatId === chatId)
        .reverse()
        .slice(0, limit);
    },
    async markRead({ chatId, accountId, messageId }) {
      if (!/^[0-9a-f-]{36}$/.test(messageId ?? '')) return false;
      markers.set(key(chatId, accountId), messageId);
      return true;
    },
    async readMarkers(chatId) {
      const out = new Map();
      for (const [k, v] of markers) {
        const [c, a] = k.split('/');
        if (c === chatId) out.set(a, v);
      }
      return out;
    },
    async unreadCounts({ chatId, accountId }) {
      const last = markers.has(key(chatId, accountId))
        ? place(markers.get(key(chatId, accountId)))
        : -1;
      const unread = sent
        .slice(last + 1)
        .filter((m) => m.chatId === chatId && m.authorId !== accountId);
      return {
        unread: unread.length,
        mentions: unread.filter((m) => m.mentions.some((x) => x.id === accountId)).length,
      };
    },
    removed: [],
    async removeChat({ chatId }) {
      this.removed.push(chatId);
    },
  };
}
