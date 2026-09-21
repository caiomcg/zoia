/**
 * These are security regression tests. If a refactor ever hands viewers publish
 * rights, this file fails rather than you discovering it when someone paints
 * over your screen share.
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
  return {
    created,
    issuer: createTokenIssuer({ ...CONFIG, roomService, ...overrides }),
  };
}

async function grantFor(role) {
  const { issuer } = makeIssuer();
  const { token } = await issuer.issue({ id: 'k_1', name: 'Test', role });
  return decodeTokenPayload(token).video;
}

describe('role enforcement', () => {
  test('a viewer token must not be able to publish', async () => {
    const grant = await grantFor('viewer');
    assert.equal(grant.canPublish, false, 'viewers must never receive canPublish');
    assert.equal(grant.canPublishData, false);
  });

  test('a host token can publish', async () => {
    const grant = await grantFor('host');
    assert.equal(grant.canPublish, true);
  });

  test('every role can subscribe', async () => {
    for (const role of ['host', 'viewer']) {
      assert.equal((await grantFor(role)).canSubscribe, true);
    }
  });

  test('an unrecognised role is treated as a viewer, not as a host', async () => {
    // Fail closed: a typo or a future role must not grant publish rights.
    for (const role of ['admin', 'HOST', '', null, undefined]) {
      const grant = await grantFor(role);
      assert.equal(grant.canPublish, false, `role ${JSON.stringify(role)} must not publish`);
    }
  });

  test('no token carries room administration rights', async () => {
    for (const role of ['host', 'viewer']) {
      const grant = await grantFor(role);
      assert.ok(!grant.roomAdmin, 'roomAdmin must never be granted');
      assert.ok(!grant.roomCreate, 'roomCreate must never be granted');
    }
  });
});

describe('token shape', () => {
  test('is scoped to the configured room only', async () => {
    const grant = await grantFor('viewer');
    assert.equal(grant.room, 'zoia');
    assert.equal(grant.roomJoin, true);
  });

  test('carries the key id as identity and expires quickly', async () => {
    const { issuer } = makeIssuer();
    const { token } = await issuer.issue({ id: 'abc123', name: 'Alice', role: 'viewer' });
    const payload = decodeTokenPayload(token);

    assert.equal(payload.sub, 'abc123');
    assert.equal(payload.name, 'Alice');

    // The SDK stamps nbf rather than iat.
    const ttlSeconds = payload.exp - payload.nbf;
    assert.ok(ttlSeconds > 0 && ttlSeconds <= 900, `unexpected ttl: ${ttlSeconds}s`);
  });

  test('returns the signalling url the browser should connect to', async () => {
    const { issuer } = makeIssuer();
    const result = await issuer.issue({ id: 'k_1', name: 'A', role: 'viewer' });
    assert.equal(result.wsUrl, 'wss://sfu.example.com');
    assert.equal(result.room, 'zoia');
  });

  test('the raw api secret never appears in the token', async () => {
    const { issuer } = makeIssuer();
    const { token } = await issuer.issue({ id: 'k_1', name: 'A', role: 'viewer' });
    assert.ok(!token.includes(CONFIG.apiSecret));
  });
});

describe('room lifecycle', () => {
  test('a host request creates the room, since auto_create is disabled', async () => {
    const { issuer, created } = makeIssuer();
    await issuer.issue({ id: 'k_1', name: 'Host', role: 'host' });
    assert.equal(created.length, 1);
    assert.equal(created[0].name, 'zoia');
  });

  test('a viewer request does not create rooms', async () => {
    const { issuer, created } = makeIssuer();
    await issuer.issue({ id: 'k_2', name: 'Viewer', role: 'viewer' });
    assert.equal(created.length, 0);
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

    const { token } = await issuer.issue({ id: 'k_1', name: 'Host', role: 'host' });
    assert.ok(token, 'token should still be issued so the client can report the real error');
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

    await issuer.issue({ id: 'k_1', name: 'Host', role: 'host' });
    assert.equal(warnings.length, 0);
  });
});
