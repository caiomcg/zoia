/**
 * Chat messages (ADR 0036). The pure parts run everywhere. The store runs
 * against a real ScyllaDB when SCYLLA_TEST_CONTACT_POINTS is set — CI starts
 * one — in a keyspace of its own that is dropped afterwards:
 *
 *   docker run -d --name scylla-test -p 9042:9042 scylladb/scylla:2025.1 \
 *     --smp 1 --memory 750M --overprovisioned 1 --developer-mode 1
 *   SCYLLA_TEST_CONTACT_POINTS=127.0.0.1 npm test
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import cassandra from 'cassandra-driver';

import {
  bucketOf,
  bucketsBetween,
  cleanBody,
  createMessageStore,
  MESSAGE_MAX,
  parseMessageId,
  previousBucket,
  replySnapshot,
} from '../src/messages.js';
import { connectInBackground, connectScylla, isKeyspaceName } from '../src/scylla.js';

const { TimeUuid } = cassandra.types;
const quiet = { info() {}, warn() {}, error() {} };

describe('message bodies', () => {
  test('are trimmed, keep line breaks, and lose other control characters', () => {
    assert.equal(cleanBody('  oi\r\ntudo bem?\t\u0007 '), 'oi\ntudo bem?');
  });

  test('empty, too long or not text is refused', () => {
    assert.equal(cleanBody('   \n '), null);
    assert.equal(cleanBody('x'.repeat(MESSAGE_MAX + 1)), null);
    assert.equal(cleanBody('x'.repeat(MESSAGE_MAX)).length, MESSAGE_MAX);
    assert.equal(cleanBody(42), null);
  });
});

describe('monthly buckets', () => {
  test('are the UTC month, as yyyymm', () => {
    assert.equal(bucketOf('2026-10-21T12:00:00Z'), 202610);
    assert.equal(bucketOf('2026-12-31T23:59:59Z'), 202612);
    assert.equal(bucketOf('2027-01-01T00:00:00Z'), 202701);
  });

  test('step back across a year', () => {
    assert.equal(previousBucket(202701), 202612);
    assert.equal(previousBucket(202610), 202609);
  });

  test('are walked newest first, and never for ever', () => {
    assert.deepEqual(bucketsBetween(202702, 202611), [202702, 202701, 202612, 202611]);
    assert.deepEqual(bucketsBetween(202610, 202611), []);
    assert.equal(bucketsBetween(202610, 190001).length, 240);
  });
});

describe('message ids from a client', () => {
  test('only a time-based uuid is one', () => {
    assert.ok(parseMessageId('3d6f0a40-b0f1-11f0-8000-000000000000'));
    assert.equal(parseMessageId('9b2b6c5e-6f1a-4d7e-9a43-2f1b0c8d9e7a'), null);
    assert.equal(parseMessageId('nope'), null);
    assert.equal(parseMessageId(undefined), null);
  });
});

describe('keyspace names', () => {
  test('are plain identifiers, since they are put into CQL', () => {
    assert.ok(isKeyspaceName('zoia'));
    assert.ok(isKeyspaceName('zoia_test_1'));
    assert.ok(!isKeyspaceName('Zoia'));
    assert.ok(!isKeyspaceName('zoia; DROP KEYSPACE system'));
    assert.ok(!isKeyspaceName(''));
  });
});

describe('connecting in the background', () => {
  // The retry timer is unref'd so it never holds the server open; this holds
  // the test runner open while it fires.
  let keepAlive;
  before(() => (keepAlive = setInterval(() => {}, 1000)));
  after(() => clearInterval(keepAlive));

  test('retries with backoff until Scylla answers, then hands the client over', async () => {
    const warnings = [];
    const delays = [];
    let calls = 0;
    const client = { shutdown: async () => {} };
    const connected = new Promise((resolve) => {
      connectInBackground({
        keyspace: 'zoia',
        firstRetryMs: 5,
        maxRetryMs: 8,
        logger: { info() {}, warn: (line) => warnings.push(line) },
        connect: async () => {
          calls += 1;
          if (calls < 4) throw new Error('connection refused');
          return client;
        },
        onConnected: resolve,
      });
    });
    assert.equal(await connected, client);
    assert.equal(calls, 4);
    for (const line of warnings) delays.push(Number(/in ([\d.]+)s/.exec(line)[1]) * 1000);
    assert.deepEqual(delays, [5, 8, 8]);
  });

  test('stopped, it gives up and closes what it opened', async () => {
    let closed = false;
    let release;
    const pending = new Promise((resolve) => (release = resolve));
    const connection = connectInBackground({
      keyspace: 'zoia',
      logger: quiet,
      connect: async () => {
        await pending;
        return { shutdown: async () => (closed = true) };
      },
      onConnected: () => assert.fail('must not hand over a client after stop'),
    });
    await connection.stop();
    release();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(closed, true);
  });
});

const contactPoints = process.env.SCYLLA_TEST_CONTACT_POINTS;

describe(
  'the store, on ScyllaDB',
  { skip: !contactPoints && 'SCYLLA_TEST_CONTACT_POINTS not set' },
  () => {
    const keyspace = `zoia_test_${randomBytes(4).toString('hex')}`;
    const since = new Date().toISOString();
    let client;
    let store;

    before(async () => {
      client = await connectScylla({
        contactPoints: contactPoints.split(','),
        localDataCenter: process.env.SCYLLA_TEST_DC ?? 'datacenter1',
        keyspace,
        logger: quiet,
      });
      store = createMessageStore({ client, keyspace });
    });

    after(async () => {
      if (!client) return;
      await client.execute(`DROP KEYSPACE IF EXISTS ${keyspace}`);
      await client.shutdown();
    });

    test('connecting again applies no migration twice', async () => {
      const again = await connectScylla({
        contactPoints: contactPoints.split(','),
        localDataCenter: process.env.SCYLLA_TEST_DC ?? 'datacenter1',
        keyspace,
        logger: quiet,
      });
      // Closed whatever happens: an open connection keeps the test run alive
      // for ever, and CI then hangs instead of failing.
      try {
        const { rows } = await again.execute(`SELECT version FROM ${keyspace}.schema_migrations`);
        // Each version once, from 1 up, however many there are by now.
        const versions = rows.map((r) => r.version).sort((a, b) => a - b);
        assert.ok(versions.length >= 3);
        assert.deepEqual(
          versions,
          versions.map((_, i) => i + 1),
        );
      } finally {
        await again.shutdown();
      }
    });

    test('a sent message comes back newest first, with its author and time', async () => {
      const first = await store.send({ chatId: 'c1', authorId: 'ana00000', body: 'oi' });
      const second = await store.send({ chatId: 'c1', authorId: 'bia00000', body: 'olá' });
      const page = await store.page({ chatId: 'c1', since });
      assert.deepEqual(
        page.map((m) => [m.authorId, m.body]),
        [
          ['bia00000', 'olá'],
          ['ana00000', 'oi'],
        ],
      );
      assert.equal(page[1].id, first.id);
      assert.ok(Date.parse(second.sentAt) >= Date.parse(first.sentAt));
    });

    test('pages walk back with a cursor and never repeat', async () => {
      const sent = [];
      for (let i = 0; i < 5; i += 1) {
        sent.push(await store.send({ chatId: 'c2', authorId: 'ana00000', body: `m${i}` }));
      }
      const one = await store.page({ chatId: 'c2', since, limit: 2 });
      const two = await store.page({ chatId: 'c2', since, limit: 2, before: one.at(-1).id });
      const three = await store.page({ chatId: 'c2', since, limit: 2, before: two.at(-1).id });
      assert.deepEqual(
        [...one, ...two, ...three].map((m) => m.body),
        ['m4', 'm3', 'm2', 'm1', 'm0'],
      );
    });

    test('paging and unread cross into earlier months', async () => {
      // Two months back, written as send() would have written it then.
      const then = new Date(Date.now() - 62 * 24 * 3600 * 1000);
      const old = TimeUuid.fromDate(then);
      await client.execute(
        `INSERT INTO ${keyspace}.messages (chat_id, bucket, id, author_id, body) VALUES (?, ?, ?, ?, ?)`,
        ['c8', bucketOf(then), old, 'bia00000', 'antiga'],
        { prepare: true },
      );
      const recent = await store.send({ chatId: 'c8', authorId: 'bia00000', body: 'nova' });
      const created = new Date(then.getTime() - 1000).toISOString();

      assert.deepEqual(
        (await store.page({ chatId: 'c8', since: created })).map((m) => m.body),
        ['nova', 'antiga'],
      );
      assert.deepEqual(
        (await store.page({ chatId: 'c8', since: created, before: recent.id })).map((m) => m.body),
        ['antiga'],
      );
      assert.equal(await store.unread({ chatId: 'c8', accountId: 'ana00000', since: created }), 2);
      await store.markRead({ chatId: 'c8', accountId: 'ana00000', messageId: old.toString() });
      assert.equal(await store.unread({ chatId: 'c8', accountId: 'ana00000', since: created }), 1);
      // A chat created this month never looks further back.
      assert.deepEqual(
        (await store.page({ chatId: 'c8', since })).map((m) => m.body),
        ['nova'],
      );
    });

    test('a photo or video travels with its message, and plain text carries none', async () => {
      const attachment = {
        id: 'aaaaaaaaaaaaaaaa',
        type: 'image/png',
        kind: 'image',
        size: 3,
        name: 'a.png',
      };
      const sent = await store.send({ chatId: 'c9', authorId: 'ana00000', body: '', attachment });
      await store.send({ chatId: 'c9', authorId: 'ana00000', body: 'só texto' });
      assert.deepEqual(sent.attachment, attachment);
      const [text, photo] = await store.page({ chatId: 'c9', since });
      assert.equal(text.attachment, null);
      assert.deepEqual(photo.attachment, attachment);
      assert.equal(photo.body, '');
    });

    test('a reply and its mentions are kept, and a message is found by its id', async () => {
      const original = await store.send({ chatId: 'c10', authorId: 'ana00000', body: 'oi' });
      const found = await store.get({ chatId: 'c10', id: original.id });
      assert.equal(found.body, 'oi');
      assert.equal(await store.get({ chatId: 'c11', id: original.id }), null);
      assert.equal(await store.get({ chatId: 'c10', id: 'nope' }), null);

      const replyTo = replySnapshot(found, 'Ana');
      const mentions = [{ id: 'ana00000', name: 'Ana' }];
      await store.send({ chatId: 'c10', authorId: 'bia00000', body: 'oi @Ana', replyTo, mentions });
      const [reply, plain] = await store.page({ chatId: 'c10', since });
      assert.deepEqual(reply.replyTo, replyTo);
      assert.deepEqual(reply.mentions, mentions);
      assert.equal(plain.replyTo, null);
      assert.deepEqual(plain.mentions, []);
    });

    test('a deleted message is gone, and deleting it again is harmless', async () => {
      const m = await store.send({ chatId: 'c12', authorId: 'ana00000', body: 'apaga' });
      await store.remove({ chatId: 'c12', id: m.id });
      assert.equal(await store.get({ chatId: 'c12', id: m.id }), null);
      await store.remove({ chatId: 'c12', id: m.id });
      await store.remove({ chatId: 'c12', id: 'nope' });
      assert.deepEqual(await store.page({ chatId: 'c12', since }), []);
    });

    test('chats do not see each other', async () => {
      await store.send({ chatId: 'c3', authorId: 'ana00000', body: 'só aqui' });
      assert.deepEqual(await store.page({ chatId: 'c4', since }), []);
    });

    test('unread counts what others wrote after the marker', async () => {
      const mine = await store.send({ chatId: 'c5', authorId: 'ana00000', body: 'eu' });
      await store.send({ chatId: 'c5', authorId: 'bia00000', body: 'um' });
      const last = await store.send({ chatId: 'c5', authorId: 'bia00000', body: 'dois' });

      assert.equal(await store.unread({ chatId: 'c5', accountId: 'ana00000', since }), 2);
      assert.equal(
        await store.markRead({ chatId: 'c5', accountId: 'ana00000', messageId: mine.id }),
        true,
      );
      assert.equal(await store.unread({ chatId: 'c5', accountId: 'ana00000', since }), 2);
      await store.markRead({ chatId: 'c5', accountId: 'ana00000', messageId: last.id });
      assert.equal(await store.unread({ chatId: 'c5', accountId: 'ana00000', since }), 0);
      assert.equal(await store.unread({ chatId: 'c5', accountId: 'cai00000', since, cap: 2 }), 2);
    });

    test('a read marker never moves back', async () => {
      const older = await store.send({ chatId: 'c6', authorId: 'bia00000', body: 'a' });
      const newer = await store.send({ chatId: 'c6', authorId: 'bia00000', body: 'b' });
      await store.markRead({ chatId: 'c6', accountId: 'ana00000', messageId: newer.id });
      await store.markRead({ chatId: 'c6', accountId: 'ana00000', messageId: older.id });
      const markers = await store.readMarkers('c6');
      assert.equal(markers.get('ana00000'), newer.id);
    });

    test('a marker that is not a message id is refused', async () => {
      assert.equal(
        await store.markRead({ chatId: 'c6', accountId: 'ana00000', messageId: 'nope' }),
        false,
      );
    });

    test('removing a chat deletes its messages and markers', async () => {
      const m = await store.send({ chatId: 'c7', authorId: 'bia00000', body: 'tchau' });
      await store.markRead({ chatId: 'c7', accountId: 'ana00000', messageId: m.id });
      await store.removeChat({ chatId: 'c7', since });
      assert.deepEqual(await store.page({ chatId: 'c7', since }), []);
      assert.equal((await store.readMarkers('c7')).size, 0);
    });
  },
);
