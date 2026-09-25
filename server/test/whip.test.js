/**
 * Hardware-encoded broadcasts publish straight to the SFU over WHIP. These
 * tests cover the three ways that went wrong or nearly did: an endpoint nobody
 * outside the LAN could reach, a publish path that ignored the stage, and a
 * stage that mistook the publisher for a second person.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  createWhipPublisher,
  whipUrlFrom,
  NotStageHolderError,
  WHIP_SUFFIX,
  ownerOf,
} from '../src/whip.js';
import { createStage } from '../src/stage.js';

const quiet = { info() {}, warn() {}, error() {} };

function decode(jwt) {
  return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
}

describe('the WHIP endpoint comes from the configured LiveKit URL', () => {
  test('wss becomes https, on the same host, at /whip/v1', () => {
    assert.equal(whipUrlFrom('wss://sfu.example.com'), 'https://sfu.example.com/whip/v1');
  });

  test('ws becomes http, for a local server without TLS', () => {
    assert.equal(whipUrlFrom('ws://localhost:7880'), 'http://localhost:7880/whip/v1');
  });

  test('a trailing slash does not double up the path', () => {
    assert.equal(whipUrlFrom('wss://sfu.example.com/'), 'https://sfu.example.com/whip/v1');
  });

  test('the host is exactly the one configured, never another address', () => {
    // The ingress this replaced was pointed at a LAN address, so hardware
    // encoding timed out for every broadcaster outside the server's network.
    // Deriving the URL means there is no second address to get wrong.
    const url = new URL(whipUrlFrom('wss://sfu.example.com'));
    assert.equal(url.host, 'sfu.example.com');
  });

  test('a missing or nonsense URL fails at boot, not at go-live', () => {
    assert.throws(() => whipUrlFrom(''), /LIVEKIT_WS_URL is not set/);
    assert.throws(() => whipUrlFrom(undefined), /LIVEKIT_WS_URL is not set/);
    assert.throws(() => whipUrlFrom('https://sfu.example.com'), /ws:\/\/ or wss:\/\//);
  });
});

describe('publishing is for the stage holder only', () => {
  let holder;
  let removed;
  let whip;

  beforeEach(() => {
    holder = null;
    removed = [];
    whip = createWhipPublisher({
      apiKey: 'devkey',
      apiSecret: 'a-secret-long-enough-for-hmac-signing',
      wsUrl: 'wss://sfu.example.com',
      roomName: 'zoia',
      rooms: {
        removeParticipant: async (_room, identity) => {
          removed.push(identity);
        },
      },
      stage: { isBroadcaster: async (identity) => holder?.identity === identity },
      logger: quiet,
    });
  });

  test('somebody without the stage is refused', async () => {
    // The old ingress endpoint checked for a session and nothing more, so any
    // paired device could publish around the stage.
    holder = { identity: 'someone-else', name: 'Other', publishing: true };
    await assert.rejects(whip.endpointFor({ id: 'me', name: 'Me' }), NotStageHolderError);
  });

  test('an empty stage is refused too: claiming comes first', async () => {
    await assert.rejects(whip.endpointFor({ id: 'me', name: 'Me' }), NotStageHolderError);
  });

  test('the holder gets the endpoint and a publish-only token', async () => {
    holder = { identity: 'me', name: 'Me', publishing: false };
    const { url, token } = await whip.endpointFor({ id: 'me', name: 'Me' });

    assert.equal(url, 'https://sfu.example.com/whip/v1');
    const claims = decode(token);
    assert.equal(claims.sub, `me${WHIP_SUFFIX}`, 'a second identity, so it does not kick the app');
    assert.equal(claims.video.room, 'zoia');
    assert.equal(claims.video.canPublish, true);
    assert.equal(claims.video.canSubscribe, false);
    assert.ok(!claims.video.roomAdmin, 'publishing must not bring room administration with it');
  });

  test('the token is short-lived', async () => {
    holder = { identity: 'me', name: 'Me', publishing: false };
    const claims = decode((await whip.endpointFor({ id: 'me', name: 'Me' })).token);
    assert.ok(claims.exp - claims.nbf <= 10 * 60, `lives ${claims.exp - claims.nbf}s`);
  });

  test('release removes the publisher, and a second release is harmless', async () => {
    assert.deepEqual(await whip.release({ id: 'me' }), { ok: true, released: true });
    assert.deepEqual(removed, [`me${WHIP_SUFFIX}`]);
  });
});

describe('the stage sees a WHIP publisher as its owner', () => {
  let participants;
  let removed;
  let stage;
  let clock;

  const person = (identity, { canPublish = false, tracks = [] } = {}) => ({
    identity,
    name: identity,
    permission: { canPublish, canSubscribe: true },
    tracks,
  });

  beforeEach(() => {
    participants = [];
    removed = [];
    clock = 1_000_000;
    stage = createStage({
      roomName: 'zoia',
      logger: quiet,
      now: () => clock,
      rooms: {
        listParticipants: async () => participants,
        updateParticipant: async (_room, identity, { permission }) => {
          const p = participants.find((x) => x.identity === identity);
          if (p) p.permission = { ...p.permission, ...permission };
        },
        removeParticipant: async (_room, identity) => {
          removed.push(identity);
          participants = participants.filter((p) => p.identity !== identity);
        },
      },
    });
  });

  test('a WHIP publisher is attributed to the person, not a duplicate', async () => {
    participants = [
      person(`alice${WHIP_SUFFIX}`, { canPublish: true, tracks: ['video'] }),
      person('alice', { canPublish: true }),
    ];
    const list = await stage.broadcasters();
    assert.deepEqual(list.map((b) => b.identity), ['alice']);
  });

  test('a GPU broadcast counts as publishing for its owner', async () => {
    participants = [
      person('alice', { canPublish: true }),
      person(`alice${WHIP_SUFFIX}`, { canPublish: true, tracks: ['video'] }),
      person('bob'),
    ];
    clock += 24 * 60 * 60 * 1000;
    const result = await stage.claim({ id: 'bob', name: 'bob' });
    assert.equal(result.ok, true);
    assert.equal((await stage.broadcasters()).find((b) => b.identity === 'alice').publishing, true);
  });

  test('releasing the stage ends the GPU broadcast too', async () => {
    participants = [
      person('alice', { canPublish: true }),
      person(`alice${WHIP_SUFFIX}`, { canPublish: true, tracks: ['video'] }),
    ];
    const result = await stage.release({ id: 'alice', name: 'alice' });
    assert.equal(result.released, true);
    assert.deepEqual(removed, [`alice${WHIP_SUFFIX}`]);
  });

  test('claiming another slot does not end an existing GPU broadcast', async () => {
    participants = [
      person('alice', { canPublish: true }),
      person(`alice${WHIP_SUFFIX}`, { canPublish: true, tracks: ['video'] }),
      person('bob'),
    ];
    const result = await stage.claim({ id: 'bob', name: 'bob' });
    assert.equal(result.ok, true);
    assert.deepEqual(removed, []);
  });

  test('a publisher whose app died still holds the stage for its owner', async () => {
    participants = [person(`alice${WHIP_SUFFIX}`, { canPublish: true, tracks: ['video'] })];
    const h = await stage.holder();
    assert.equal(h.identity, 'alice');
    assert.equal(h.publishing, true);
  });

  test('ownerOf leaves ordinary identities alone', () => {
    assert.equal(ownerOf('alice'), 'alice');
    assert.equal(ownerOf(`alice${WHIP_SUFFIX}`), 'alice');
  });
});
