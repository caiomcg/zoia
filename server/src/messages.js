/**
 * Chat messages and who has read them, kept in ScyllaDB. See ADR 0035.
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
 */

import cassandra from 'cassandra-driver';

const { TimeUuid } = cassandra.types;

/** Characters in one message. Enough for a long paragraph, not a document. */
export const MESSAGE_MAX = 4000;

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
    attachment: parseAttachment(row.attachment),
  };
}

function parseAttachment(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

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
    async send({ chatId, authorId, body, attachment = null }) {
      const id = TimeUuid.now();
      const stored = attachment ? JSON.stringify(attachment) : null;
      await client.execute(
        `INSERT INTO ${t('messages')} (chat_id, bucket, id, author_id, body, attachment)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [chatId, bucketOf(id.getDate()), id, authorId, body, stored],
        prepared,
      );
      return toMessage(chatId, { id, author_id: authorId, body, attachment: stored });
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
          `SELECT id, author_id, body, attachment FROM ${t('messages')}
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
      const marker = await client.execute(
        `SELECT last_read FROM ${t('read_markers')} WHERE chat_id = ? AND account_id = ?`,
        [chatId, accountId],
        prepared,
      );
      const lastRead = marker.rows[0]?.last_read ?? null;
      const oldest = lastRead
        ? Math.max(bucketOf(lastRead.getDate()), sinceBucket(since))
        : sinceBucket(since);
      let count = 0;
      for (const bucket of bucketsBetween(bucketOf(Date.now()), oldest)) {
        const bounded = lastRead && bucket === bucketOf(lastRead.getDate());
        const result = await client.execute(
          `SELECT author_id FROM ${t('messages')}
           WHERE chat_id = ? AND bucket = ?${bounded ? ' AND id > ?' : ''} LIMIT ?`,
          bounded ? [chatId, bucket, lastRead, cap] : [chatId, bucket, cap],
          prepared,
        );
        count += result.rows.filter((row) => row.author_id !== accountId).length;
        if (count >= cap) return cap;
      }
      return count;
    },

    /** Deletes every message and read marker of a chat that is being removed. */
    async removeChat({ chatId, since }) {
      for (const bucket of bucketsBetween(bucketOf(Date.now()), sinceBucket(since))) {
        await client.execute(
          `DELETE FROM ${t('messages')} WHERE chat_id = ? AND bucket = ?`,
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
