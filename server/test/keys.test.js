import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createKeyStore, parseKey, isActive } from '../src/keys.js';

let dir;
let store;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zoia-keys-'));
  store = createKeyStore({ file: join(dir, 'keys.json') });
});

afterEach(async () => {
  await store.idle();
  await rm(dir, { recursive: true, force: true });
});

describe('parseKey', () => {
  test('splits a well-formed key into id and secret', () => {
    const parsed = parseKey('zoia_a1b2c3d4_' + 'x'.repeat(43));
    assert.equal(parsed.id, 'a1b2c3d4');
    assert.equal(parsed.secret, 'x'.repeat(43));
  });

  test('accepts secrets containing base64url underscores and dashes', () => {
    // Regression: the secret alphabet includes '_' and '-', so a naive
    // split('_') misparsed roughly half of all generated keys.
    const secret = `${'a'.repeat(20)}_${'b'.repeat(11)}-${'c'.repeat(11)}`;
    const parsed = parseKey(`zoia_a1b2c3d4_${secret}`);
    assert.equal(parsed.id, 'a1b2c3d4');
    assert.equal(parsed.secret, secret);
  });

  test('rejects malformed input rather than throwing', () => {
    for (const bad of [
      null,
      undefined,
      42,
      '',
      'nope',
      'zoia_short_' + 'x'.repeat(43),
      'other_a1b2c3d4_' + 'x'.repeat(43),
      'zoia_a1b2c3d4_tooshort',
      'zoia_ZZZZZZZZ_' + 'x'.repeat(43),
    ]) {
      assert.equal(parseKey(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
  });
});

describe('minting', () => {
  test('returns a raw key that verifies back to its record', async () => {
    const { record, rawKey } = await store.add({ name: 'Alice', role: 'viewer' });
    const verified = await store.verify(rawKey);
    assert.equal(verified.id, record.id);
    assert.equal(verified.name, 'Alice');
    assert.equal(verified.role, 'viewer');
  });

  test('never persists the raw secret', async () => {
    const { rawKey } = await store.add({ name: 'Alice', role: 'viewer' });
    // parseKey, not split('_'): the base64url secret may itself contain '_',
    // and a truncated fragment collides with the stored hash by chance.
    const secret = parseKey(rawKey).secret;
    const onDisk = await readFile(join(dir, 'keys.json'), 'utf8');
    assert.ok(!onDisk.includes(secret), 'raw secret must not appear in the key store');
  });

  test('every minted key round-trips, whatever the random secret contains', async () => {
    // Exercises the alphabet: with 40 keys, a '_' in the secret is near-certain.
    for (let i = 0; i < 40; i += 1) {
      const { rawKey } = await store.add({ name: `user${i}`, role: 'viewer' });
      assert.ok(await store.verify(rawKey), `key ${i} failed to verify: ${rawKey}`);
    }
  });

  test('issues distinct ids and secrets', async () => {
    const a = await store.add({ name: 'Alice', role: 'viewer' });
    const b = await store.add({ name: 'Bob', role: 'viewer' });
    assert.notEqual(a.record.id, b.record.id);
    assert.notEqual(a.rawKey, b.rawKey);
  });

  test('rejects an unknown role', async () => {
    await assert.rejects(() => store.add({ name: 'Alice', role: 'admin' }), /role must be one of/);
  });

  test('rejects a blank name', async () => {
    await assert.rejects(() => store.add({ name: '   ', role: 'viewer' }), /name is required/);
  });

  test('concurrent mints all survive', async () => {
    await Promise.all(['a', 'b', 'c', 'd', 'e'].map((n) => store.add({ name: n, role: 'viewer' })));
    assert.equal((await store.list()).length, 5);
  });
});

describe('verification', () => {
  test('rejects a wrong secret against a real id', async () => {
    const { record } = await store.add({ name: 'Alice', role: 'viewer' });
    const forged = `zoia_${record.id}_${'x'.repeat(43)}`;
    assert.equal(await store.verify(forged), null);
  });

  test('rejects an unknown id', async () => {
    await store.add({ name: 'Alice', role: 'viewer' });
    assert.equal(await store.verify(`zoia_deadbeef_${'x'.repeat(43)}`), null);
  });

  test('rejects a malformed key', async () => {
    assert.equal(await store.verify('not-a-key'), null);
  });

  test('rejects a revoked key', async () => {
    const { record, rawKey } = await store.add({ name: 'Alice', role: 'viewer' });
    assert.ok(await store.verify(rawKey));
    await store.revoke(record.id);
    assert.equal(await store.verify(rawKey), null, 'revocation must take effect immediately');
  });

  test('rejects an expired key', async () => {
    const { rawKey } = await store.add({
      name: 'Alice',
      role: 'viewer',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    assert.equal(await store.verify(rawKey), null);
  });

  test('accepts a key that has not expired yet', async () => {
    const { rawKey } = await store.add({
      name: 'Alice',
      role: 'viewer',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.ok(await store.verify(rawKey));
  });
});

describe('administration', () => {
  test('list omits salt and hash so callers cannot leak them', async () => {
    await store.add({ name: 'Alice', role: 'viewer' });
    const [entry] = await store.list();
    assert.equal(entry.salt, undefined);
    assert.equal(entry.hash, undefined);
    assert.equal(entry.name, 'Alice');
  });

  test('revoking an unknown id reports failure', async () => {
    assert.equal(await store.revoke('deadbeef'), false);
  });

  test('getActive resolves live records and drops revoked ones', async () => {
    const { record } = await store.add({ name: 'Alice', role: 'viewer' });
    assert.ok(await store.getActive(record.id));
    await store.revoke(record.id);
    assert.equal(await store.getActive(record.id), null);
  });

  test('touch records last seen', async () => {
    const { record } = await store.add({ name: 'Alice', role: 'viewer' });
    await store.touch(record.id);
    const [entry] = await store.list();
    assert.ok(entry.lastSeen, 'lastSeen should be populated after touch');
  });

  test('an empty store reads as empty rather than throwing', async () => {
    assert.deepEqual(await store.list(), []);
  });
});

describe('isActive', () => {
  test('classifies records by revocation and expiry', () => {
    assert.equal(isActive({ revoked: false, expiresAt: null }), true);
    assert.equal(isActive({ revoked: true, expiresAt: null }), false);
    assert.equal(isActive(null), false);
    assert.equal(
      isActive({ revoked: false, expiresAt: new Date(Date.now() - 1).toISOString() }),
      false,
    );
  });
});
