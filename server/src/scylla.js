/**
 * The connection to ScyllaDB, where chat messages live. See ADR 0035.
 *
 * Scylla already writes in two steps: every write is appended to its commit
 * log, for durability, and applied to a memtable in memory, which is flushed
 * to SSTables later. The app writes once and leaves that to the database.
 *
 * Talks CQL through `cassandra-driver`, which Scylla speaks natively.
 */

import cassandra from 'cassandra-driver';

const KEYSPACE_NAME = /^[a-z][a-z0-9_]{0,47}$/;

export function isKeyspaceName(name) {
  return typeof name === 'string' && KEYSPACE_NAME.test(name);
}

/**
 * Schema versions, applied in order and recorded in `schema_migrations`. A
 * change is a new entry, never an edit to an old one, as in database.js.
 * `{ks}` is replaced with the keyspace.
 */
const MIGRATIONS = [
  [
    // A chat's messages, newest first, split by month so no partition grows
    // without bound. The id is a timeuuid: it orders the messages and says
    // when each was sent.
    `CREATE TABLE IF NOT EXISTS {ks}.messages (
       chat_id text,
       bucket int,
       id timeuuid,
       author_id text,
       body text,
       PRIMARY KEY ((chat_id, bucket), id)
     ) WITH CLUSTERING ORDER BY (id DESC)`,
    // The last message each person has read in a chat. One partition per chat,
    // so "seen by" is one read of a few dozen rows.
    `CREATE TABLE IF NOT EXISTS {ks}.read_markers (
       chat_id text,
       account_id text,
       last_read timeuuid,
       PRIMARY KEY (chat_id, account_id)
     )`,
  ],
  [
    // A photo or video sent with the message, as JSON: its id in the chat's
    // media folder, type, size and name. The file is on the app's disk.
    `ALTER TABLE {ks}.messages ADD attachment text`,
  ],
];

/**
 * Connects without holding up the caller, retrying with backoff until Scylla
 * answers: it takes a minute to start, and the app must serve broadcasts
 * meanwhile. `onConnected` gets the client once. After that the driver
 * reconnects on its own.
 */
export function connectInBackground({
  onConnected,
  logger = console,
  firstRetryMs = 2000,
  maxRetryMs = 60_000,
  connect = connectScylla,
  ...options
}) {
  let client = null;
  let stopped = false;
  let timer = null;

  async function attempt(delay) {
    try {
      client = await connect({ ...options, logger });
      if (stopped) return client.shutdown().catch(() => {});
      logger.info('[scylla] connected');
      onConnected(client);
    } catch (err) {
      if (stopped) return;
      logger.warn(`[scylla] not reachable (${err.message}); retrying in ${delay / 1000}s`);
      timer = setTimeout(() => attempt(Math.min(delay * 2, maxRetryMs)), delay);
      timer.unref?.();
    }
  }
  attempt(firstRetryMs);

  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await client?.shutdown().catch(() => {});
    },
  };
}

/**
 * Connects, creating the keyspace and applying any migrations not yet
 * applied. One replica: there is one node, on the same VM as the app.
 */
export async function connectScylla({
  contactPoints,
  localDataCenter,
  keyspace,
  logger = console,
  Client = cassandra.Client,
}) {
  if (!isKeyspaceName(keyspace)) throw new Error(`Invalid Scylla keyspace name: ${keyspace}`);
  const client = new Client({ contactPoints, localDataCenter });
  await client.connect();
  try {
    await client.execute(
      `CREATE KEYSPACE IF NOT EXISTS ${keyspace}
       WITH replication = {'class': 'NetworkTopologyStrategy', '${localDataCenter}': 1}`,
    );
    await client.execute(
      `CREATE TABLE IF NOT EXISTS ${keyspace}.schema_migrations (
         version int PRIMARY KEY,
         applied_at timestamp
       )`,
    );
    const applied = new Set(
      (await client.execute(`SELECT version FROM ${keyspace}.schema_migrations`)).rows.map(
        (row) => row.version,
      ),
    );
    for (let version = 1; version <= MIGRATIONS.length; version += 1) {
      if (applied.has(version)) continue;
      for (const statement of MIGRATIONS[version - 1]) {
        await client.execute(statement.replaceAll('{ks}', keyspace));
      }
      await client.execute(
        `INSERT INTO ${keyspace}.schema_migrations (version, applied_at) VALUES (?, ?)`,
        [version, new Date()],
        { prepare: true },
      );
      logger.info(`[scylla] applied schema version ${version}`);
    }
  } catch (err) {
    await client.shutdown().catch(() => {});
    throw err;
  }
  return client;
}
