/**
 * Security regression tests.
 *
 * The invariant changed shape when roles collapsed to one tier: nobody is a
 * broadcaster at join time. Publishing is granted at runtime by stage.js, so
 * every token this module mints must be subscribe-only, whatever it is handed.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createTokenIssuer, decodeTokenPayload } from '../src/token.js';

const CONFIG = {
  apiKey: 'devkey',
  apiSecret: 'a-secret-long-enough-for-hmac-signing',
  apiUrl: 'http://127.0.0.1:7880',
  wsUrl: 'wss://sfu.example.com',
  roomName: 'zoia',
};

function makeIssuer(overrides = {}) {
  const created = [];
  const roomService = {
    createRoom: async (opts) => {
      created.push(opts);
      return opts;
    },
  };
  return { created, issuer: createTokenIssuer({ ...CONFIG, roomService, ...overrides }) };
}

async function grantFor(user) {
  const { issuer } = makeIssuer();
  const { token } = await issuer.issue({ id: 'k_1', name: 'Test', ...user });
  return decodeTokenPayload(token).video;
}

describe('join tokens are never publish tokens', () => {
  test('a plain member cannot publish', async () => {
    const grant = await grantFor({});
    assert.equal(grant.canPublish, false, 'join tokens must never grant publish');
  });

  test('a legacy or forged role field cannot grant publish', async () => {
    // Old keys carry role: 'host'. A request body could carry anything. Neither
    // may influence the grant — publishing comes only from stage.js.
    for (const role of ['host', 'admin', 'HOST', 'member', '', null, undefined, true]) {
      const grant = await grantFor({ role });
      assert.equal(grant.canPublish, false, `role ${JSON.stringify(role)} must not publish`);
    }
  });

  test('everyone can subscribe', async () => {
    assert.equal((await grantFor({})).canSubscribe, true);
  });

  test('no token carries room administration rights', async () => {
    const grant = await grantFor({});
    assert.ok(!grant.roomAdmin, 'roomAdmin must never be granted');
    assert.ok(!grant.roomCreate, 'roomCreate must never be granted');
  });

  test('renaming yourself is allowed, and reaches no further than yourself', async () => {
    const grant = await grantFor({});
    // Needed so a rename shows up for everyone without a reconnect.
    assert.equal(grant.canUpdateOwnMetadata, true);
    // It must stay "own": nothing here may let one person edit another, or
    // quietly become a publisher.
    assert.ok(!grant.roomAdmin);
    assert.equal(grant.canPublish, false);
  });
});

describe('token shape', () => {
  test('is scoped to the configured room only', async () => {
    const grant = await grantFor({});
    assert.equal(grant.room, 'zoia');
    assert.equal(grant.roomJoin, true);
  });

  test('carries the key id as identity and expires quickly', async () => {
    const { issuer } = makeIssuer();
    const { token } = await issuer.issue({ id: 'abc123', name: 'Alice' });
    const payload = decodeTokenPayload(token);

    assert.equal(payload.sub, 'abc123');
    assert.equal(payload.name, 'Alice');

    // The SDK stamps nbf rather than iat.
    const ttlSeconds = payload.exp - payload.nbf;
    assert.ok(ttlSeconds > 0 && ttlSeconds <= 900, `unexpected ttl: ${ttlSeconds}s`);
  });

  test('returns the signalling url the browser should connect to', async () => {
    const { issuer } = makeIssuer();
    const result = await issuer.issue({ id: 'k_1', name: 'A' });
    assert.equal(result.wsUrl, 'wss://sfu.example.com');
    assert.equal(result.room, 'zoia');
  });

  test('the raw api secret never appears in the token', async () => {
    const { issuer } = makeIssuer();
    const { token } = await issuer.issue({ id: 'k_1', name: 'A' });
    assert.ok(!token.includes(CONFIG.apiSecret));
  });
});

describe('room lifecycle', () => {
  test('the room is created on join, since auto_create is disabled', async () => {
    const { issuer, created } = makeIssuer();
    await issuer.issue({ id: 'k_1', name: 'Someone' });
    assert.equal(created.length, 1);
    assert.equal(created[0].name, 'zoia');
  });

  test('an unreachable livekit does not prevent issuing a token', async () => {
    const warnings = [];
    const issuer = createTokenIssuer({
      ...CONFIG,
      roomService: {
        createRoom: async () => {
          throw new Error('connect ECONNREFUSED 127.0.0.1:7880');
        },
      },
      logger: { warn: (m) => warnings.push(m) },
    });

    const { token } = await issuer.issue({ id: 'k_1', name: 'Someone' });
    assert.ok(token, 'token should still be issued so the client reports the real error');
    assert.equal(warnings.length, 1);
  });

  test('an already-existing room is not logged as a problem', async () => {
    const warnings = [];
    const issuer = createTokenIssuer({
      ...CONFIG,
      roomService: {
        createRoom: async () => {
          throw new Error('room already exists');
        },
      },
      logger: { warn: (m) => warnings.push(m) },
    });
    await issuer.issue({ id: 'k_1', name: 'Someone' });
    assert.equal(warnings.length, 0);
  });
});
