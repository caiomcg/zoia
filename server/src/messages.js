/**
 * Chat messages and who has read them, kept in ScyllaDB. See ADR 0036.
 *
 * A chat's messages are split into one partition per calendar month (UTC),
 * newest first, so reading the latest page is one partition and an old chat
 * never becomes one unbounded row. Paging back walks the months down to the
 * one the chat was created in, which the caller passes as `since`: Scylla
 * cannot list a chat's partitions cheaply, and the chat list already knows.
 *
 * A read marker only moves forward. It is written with the message's own
 * time as its write timestamp, so if an older marker arrives after a newer
 * one — two windows, a slow request — Scylla keeps the newer without a
 * read-before-write.
 *
 * Reactions sit beside the messages, under the same partition key, so the
 * reactions of a page of messages are one read per month it spans.
 */

import cassandra from 'cassandra-driver';

const { TimeUuid } = cassandra.types;

/** Characters in one message. Enough for a long paragraph, not a document. */
export const MESSAGE_MAX = 4000;

/** How much of the original a reply shows. */
export const REPLY_EXCERPT_MAX = 200;

/** People one message may @mention. */
export const MENTIONS_MAX = 20;

/** Different emoji on one message. Enough for any real conversation. */
export const REACTIONS_MAX = 20;

/** Months a single query walks back at most, so a bad `since` cannot loop for long. */
const MAX_BUCKETS = 240;

const prepared = { prepare: true };

/**
 * A message body, tidied, or null if it is not one. Line breaks and tabs are
 * kept; other control characters are not text anyone typed.
 */
export function cleanBody(body) {
  if (typeof body !== 'string') return null;
  const tidy = body
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .trim();
  if (!tidy || tidy.length > MESSAGE_MAX) return null;
  return tidy;
}

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

/**
 * A reaction, or null if it is not one: a single emoji, skin tone, flag and
 * keycap sequences included. Words and symbols that only look like one are not.
 */
export function cleanEmoji(emoji) {
  if (typeof emoji !== 'string' || emoji.length === 0 || emoji.length > 32) return null;
  if ([...graphemes.segment(emoji)].length !== 1) return null;
  if (!/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(emoji)) return null;
  if (/[\s\p{Cc}]/u.test(emoji)) return null;
  return emoji;
}

/** The month a time falls in, as yyyymm in UTC. */
export function bucketOf(time) {
  const date = new Date(time);
  return date.getUTCFullYear() * 100 + date.getUTCMonth() + 1;
}

export function previousBucket(bucket) {
  const year = Math.floor(bucket / 100);
  const month = bucket % 100;
  return month === 1 ? (year - 1) * 100 + 12 : bucket - 1;
}

/** Months from `newest` back to `oldest`, newest first, at most MAX_BUCKETS. */
export function bucketsBetween(newest, oldest) {
  const buckets = [];
  for (let b = newest; b >= oldest && buckets.length < MAX_BUCKETS; b = previousBucket(b)) {
    buckets.push(b);
  }
  return buckets;
}

/** A message id as sent by a client, or null if it is not a timeuuid. */
export function parseMessageId(id) {
  if (typeof id !== 'string') return null;
  try {
    const uuid = TimeUuid.fromString(id);
    // fromString accepts any uuid; only version 1 carries a time.
    return uuid.getBuffer()[6] >> 4 === 1 ? uuid : null;
  } catch {
    return null;
  }
}

/** Microseconds since the epoch at which a timeuuid was minted. */
function micros(uuid) {
  const { date, ticks } = uuid.getDatePrecision();
  return BigInt(date.getTime()) * 1000n + BigInt(Math.floor(ticks / 10));
}

function toMessage(chatId, row) {
  return {
    id: row.id.toString(),
    chatId,
    authorId: row.author_id,
    body: row.body ?? '',
    sentAt: row.id.getDate().toISOString(),
    attachment: parseJson(row.attachment),
    replyTo: parseJson(row.reply_to),
    mentions: mentionsOf(row),
  };
}

const mentionsOf = (row) => parseJson(row.mentions) ?? [];

function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * What a reply keeps of the message it answers: enough to show it above the
 * reply without fetching it, and the id to find it by.
 */
export function replySnapshot(original, authorName) {
  const body = original.body.replace(/\s+/g, ' ').trim();
  return {
    id: original.id,
    authorId: original.authorId,
    authorName: authorName ?? null,
    body: body.length > REPLY_EXCERPT_MAX ? `${body.slice(0, REPLY_EXCERPT_MAX - 1)}…` : body,
    kind: original.attachment?.kind ?? null,
  };
}

/**
 * Reaction rows as message id -> [{ emoji, accountIds }]: emoji in the order
 * first used, people in the order they reacted.
 */
export function groupReactions(rows) {
  const time = (row) => row.reacted_at?.getTime() ?? 0;
  const sorted = [...rows].sort((a, b) => time(a) - time(b));
  const out = {};
  for (const row of sorted) {
    const id = row.message_id.toString();
    const list = (out[id] ??= []);
    let group = list.find((g) => g.emoji === row.emoji);
    if (!group) list.push((group = { emoji: row.emoji, accountIds: [] }));
    group.accountIds.push(row.account_id);
  }
  return out;
}

const COLUMNS = 'id, author_id, body, attachment, reply_to, mentions';

/**
 * @param {object} options
 * @param {import('cassandra-driver').Client} options.client a connected client
 * @param {string} options.keyspace where connectScylla created the tables
 */
export function createMessageStore({ client, keyspace }) {
  const t = (table) => `${keyspace}.${table}`;
  const sinceBucket = (since) => {
    const time = Date.parse(since);
    return Number.isNaN(time) ? bucketOf(Date.now()) : bucketOf(time);
  };

  return {
    /**
     * Stores a message. The body must already have passed `cleanBody`, or be
     * empty when an attachment — a photo or video — is the message.
     */
    async send({ chatId, authorId, body, attachment = null, replyTo = null, mentions = [] }) {
      const id = TimeUuid.now();
      const row = {
        id,
        author_id: authorId,
        body,
        attachment: attachment ? JSON.stringify(attachment) : null,
        reply_to: replyTo ? JSON.stringify(replyTo) : null,
        mentions: mentions.length > 0 ? JSON.stringify(mentions) : null,
      };
      await client.execute(
        `INSERT INTO ${t('messages')}
           (chat_id, bucket, id, author_id, body, attachment, reply_to, mentions)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          chatId,
          bucketOf(id.getDate()),
          id,
          authorId,
          body,
          row.attachment,
          row.reply_to,
          row.mentions,
        ],
        prepared,
      );
      return toMessage(chatId, row);
    },

    /**
     * One message by its id, or null. The id says when it was sent, and so
     * which month's partition holds it: one read, by the full key.
     */
    async get({ chatId, id }) {
      const uuid = parseMessageId(id);
      if (!uuid) return null;
      const result = await client.execute(
        `SELECT ${COLUMNS} FROM ${t('messages')} WHERE chat_id = ? AND bucket = ? AND id = ?`,
        [chatId, bucketOf(uuid.getDate()), uuid],
        prepared,
      );
      return result.rows[0] ? toMessage(chatId, result.rows[0]) : null;
    },

    /** Deletes one message, by its full key; nothing happens if it is not there. */
    async remove({ chatId, id }) {
      const uuid = parseMessageId(id);
      if (!uuid) return;
      const bucket = bucketOf(uuid.getDate());
      await client.execute(
        `DELETE FROM ${t('messages')} WHERE chat_id = ? AND bucket = ? AND id = ?`,
        [chatId, bucket, uuid],
        prepared,
      );
      await client.execute(
        `DELETE FROM ${t('reactions')} WHERE chat_id = ? AND bucket = ? AND message_id = ?`,
        [chatId, bucket, uuid],
        prepared,
      );
    },

    /**
     * Adds `accountId`'s `emoji` to a message, or takes it off with `on`
     * false. Doing either twice is harmless. The message must exist: the
     * caller checks.
     */
    async react({ chatId, messageId, accountId, emoji, on = true }) {
      const uuid = parseMessageId(messageId);
      if (!uuid) return;
      const key = [chatId, bucketOf(uuid.getDate()), uuid, emoji, accountId];
      if (on) {
        await client.execute(
          `INSERT INTO ${t('reactions')}
             (chat_id, bucket, message_id, emoji, account_id, reacted_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [...key, new Date()],
          prepared,
        );
      } else {
        await client.execute(
          `DELETE FROM ${t('reactions')}
           WHERE chat_id = ? AND bucket = ? AND message_id = ? AND emoji = ? AND account_id = ?`,
          key,
          prepared,
        );
      }
    },

    /**
     * The reactions to messages `ids`, as message id -> [{ emoji, accountIds }],
     * each emoji in the order it was first used and its people in the order
     * they reacted. A message nobody reacted to is not in the map.
     */
    async reactions({ chatId, ids }) {
      const byBucket = new Map();
      for (const id of ids) {
        const uuid = parseMessageId(id);
        if (!uuid) continue;
        const bucket = bucketOf(uuid.getDate());
        if (!byBucket.has(bucket)) byBucket.set(bucket, []);
        byBucket.get(bucket).push(uuid);
      }
      const rows = [];
      for (const [bucket, uuids] of byBucket) {
        const result = await client.execute(
          `SELECT message_id, emoji, account_id, reacted_at FROM ${t('reactions')}
           WHERE chat_id = ? AND bucket = ? AND message_id IN ?`,
          [chatId, bucket, uuids],
          { ...prepared, fetchSize: 5000 },
        );
        rows.push(...result.rows);
      }
      return groupReactions(rows);
    },

    /**
     * Up to `limit` messages, newest first, older than `before` when given.
     * `since` is when the chat was created.
     */
    async page({ chatId, since, before = null, limit = 50 }) {
      const cursor = before ? parseMessageId(before) : null;
      const newest = cursor ? bucketOf(cursor.getDate()) : bucketOf(Date.now());
      const messages = [];
      for (const bucket of bucketsBetween(newest, sinceBucket(since))) {
        const want = limit - messages.length;
        const bounded = cursor && bucket === newest;
        const result = await client.execute(
          `SELECT ${COLUMNS} FROM ${t('messages')}
           WHERE chat_id = ? AND bucket = ?${bounded ? ' AND id < ?' : ''} LIMIT ?`,
          bounded ? [chatId, bucket, cursor, want] : [chatId, bucket, want],
          prepared,
        );
        for (const row of result.rows) messages.push(toMessage(chatId, row));
        if (messages.length >= limit) break;
      }
      return messages;
    },

    /**
     * Records that `accountId` has read `chatId` up to `messageId`. A marker
     * older than the one stored is ignored. Returns false for an id that is
     * not a message id.
     */
    async markRead({ chatId, accountId, messageId }) {
      const id = parseMessageId(messageId);
      if (!id) return false;
      // USING TIMESTAMP takes a bigint literal; the value is computed here,
      // never taken from the request.
      await client.execute(
        `UPDATE ${t('read_markers')} USING TIMESTAMP ${micros(id)}
         SET last_read = ? WHERE chat_id = ? AND account_id = ?`,
        [id, chatId, accountId],
        prepared,
      );
      return true;
    },

    /** Every reader's last read message in a chat, as accountId -> message id. */
    async readMarkers(chatId) {
      const result = await client.execute(
        `SELECT account_id, last_read FROM ${t('read_markers')} WHERE chat_id = ?`,
        [chatId],
        prepared,
      );
      return new Map(result.rows.map((row) => [row.account_id, row.last_read.toString()]));
    },

    /**
     * Messages in `chatId` that `accountId` has not read and did not write,
     * counted up to `cap`: past that, a badge only needs to say "many".
     */
    async unread({ chatId, accountId, since, cap = 100 }) {
      return (await this.unreadCounts({ chatId, accountId, since, cap })).unread;
    },

    /**
     * What `unread` counts, and how many of those @mention `accountId`, from
     * the same read: { unread, mentions }, each up to `cap`.
     */
    async unreadCounts({ chatId, accountId, since, cap = 100 }) {
      const marker = await client.execute(
        `SELECT last_read FROM ${t('read_markers')} WHERE chat_id = ? AND account_id = ?`,
        [chatId, accountId],
        prepared,
      );
      const lastRead = marker.rows[0]?.last_read ?? null;
      const oldest = lastRead
        ? Math.max(bucketOf(lastRead.getDate()), sinceBucket(since))
        : sinceBucket(since);
      let unread = 0;
      let mentions = 0;
      for (const bucket of bucketsBetween(bucketOf(Date.now()), oldest)) {
        const bounded = lastRead && bucket === bucketOf(lastRead.getDate());
        const result = await client.execute(
          `SELECT author_id, mentions FROM ${t('messages')}
           WHERE chat_id = ? AND bucket = ?${bounded ? ' AND id > ?' : ''} LIMIT ?`,
          bounded ? [chatId, bucket, lastRead, cap] : [chatId, bucket, cap],
          prepared,
        );
        for (const row of result.rows) {
          if (row.author_id === accountId) continue;
          unread += 1;
          if (mentionsOf(row).some((m) => m.id === accountId)) mentions += 1;
        }
        if (unread >= cap) break;
      }
      return { unread: Math.min(unread, cap), mentions: Math.min(mentions, cap) };
    },

    /** Deletes every message, reaction and read marker of a chat that is being removed. */
    async removeChat({ chatId, since }) {
      for (const bucket of bucketsBetween(bucketOf(Date.now()), sinceBucket(since))) {
        await client.execute(
          `DELETE FROM ${t('messages')} WHERE chat_id = ? AND bucket = ?`,
          [chatId, bucket],
          prepared,
        );
        await client.execute(
          `DELETE FROM ${t('reactions')} WHERE chat_id = ? AND bucket = ?`,
          [chatId, bucket],
          prepared,
        );
      }
      await client.execute(
        `DELETE FROM ${t('read_markers')} WHERE chat_id = ?`,
        [chatId],
        prepared,
      );
    },
  };
}
