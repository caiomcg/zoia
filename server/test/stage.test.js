/**
 * Broadcast slots are where runtime publish permission is enforced. Different
 * participants may publish at the same time, but nobody publishes by default.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createStage } from '../src/stage.js';

let participants;
let updates;
let rooms;
let stage;
let clock;

function participant(identity, { canPublish = false, name = identity, tracks = [] } = {}) {
  return { identity, name, permission: { canPublish, canSubscribe: true }, tracks };
}

beforeEach(() => {
  participants = [];
  updates = [];
  rooms = {
    listParticipants: async () => participants,
    updateParticipant: async (room, identity, options) => {
      updates.push({ identity, permission: options.permission });
      const p = participants.find((x) => x.identity === identity);
      if (p) p.permission = { ...p.permission, ...options.permission };
      return p;
    },
  };
  clock = 1_000_000;
  stage = createStage({
    rooms,
    roomName: 'zoia',
    logger: { info() {}, warn() {} },
    now: () => clock,
  });
});
describe('claiming', () => {
  test('an empty stage can be claimed', async () => {
    participants = [participant('alice')];
    const result = await stage.claim({ id: 'alice', name: 'Alice' });

    assert.equal(result.ok, true);
    assert.equal(updates.at(-1).identity, 'alice');
    assert.equal(updates.at(-1).permission.canPublish, true);
  });

  test('a second person gets an independent slot while someone is broadcasting', async () => {
    participants = [
      participant('alice', { canPublish: true, name: 'Alice', tracks: [{}] }),
      participant('bob'),
    ];

    const result = await stage.claim({ id: 'bob', name: 'Bob' });

    assert.equal(result.ok, true);
    assert.equal(result.broadcaster.identity, 'bob');
    assert.equal(updates.at(-1).identity, 'bob');
    assert.equal(updates.at(-1).permission.canPublish, true);
  });

  test('the holder re-claiming is allowed, so a retry is not a lockout', async () => {
    participants = [participant('alice', { canPublish: true, tracks: [{}] })];
    const result = await stage.claim({ id: 'alice', name: 'Alice' });
    assert.equal(result.ok, true);
  });

  test('a stage whose holder has left can be claimed', async () => {
    // Alice disconnected without releasing; she is simply gone from the room.
    participants = [participant('bob')];
    const result = await stage.claim({ id: 'bob', name: 'Bob' });
    assert.equal(result.ok, true, 'a departed holder must not lock the stage forever');
  });

  test('a room that does not exist yet behaves as empty', async () => {
    rooms.listParticipants = async () => {
      throw new Error('room not found');
    };
    const result = await stage.claim({ id: 'alice', name: 'Alice' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not_in_room');
  });
});

describe('independent slots', () => {
  test('one idle claimant does not block another claimant', async () => {
    participants = [participant('alice'), participant('bob')];
    await stage.claim({ id: 'alice', name: 'Alice' });
    const result = await stage.claim({ id: 'bob', name: 'Bob' });
    assert.equal(result.ok, true);
    assert.equal(participants.find((p) => p.identity === 'alice').permission.canPublish, true);
    assert.equal(participants.find((p) => p.identity === 'bob').permission.canPublish, true);
  });
});

describe('releasing', () => {
  test('the holder can release, and permission is revoked', async () => {
    participants = [participant('alice', { canPublish: true })];
    const result = await stage.release({ id: 'alice', name: 'Alice' });

    assert.equal(result.released, true);
    assert.equal(updates.at(-1).permission.canPublish, false);
  });

  test('release still drops permission when the room cannot be listed', async () => {
    participants = [participant('alice', { canPublish: true })];
    rooms.listParticipants = async () => {
      throw new Error('livekit unreachable');
    };

    const result = await stage.release({ id: 'alice', name: 'Alice' });
    assert.equal(result.released, true, 'a listing failure must not strand the stage');
    assert.equal(updates.at(-1).permission.canPublish, false);
  });

  test('releasing when you do not hold it is a harmless no-op', async () => {
    participants = [participant('alice', { canPublish: true, tracks: [{}] }), participant('bob')];
    const result = await stage.release({ id: 'bob', name: 'Bob' });

    assert.equal(result.ok, true);
    assert.equal(result.released, false);
    assert.equal(updates.length, 0, "must not revoke the real holder's permission");
  });

  test('release then claim by someone else succeeds', async () => {
    participants = [participant('alice', { canPublish: true, tracks: [{}] }), participant('bob')];
    await stage.release({ id: 'alice', name: 'Alice' });
    const result = await stage.claim({ id: 'bob', name: 'Bob' });
    assert.equal(result.ok, true);
  });
});

describe('reporting', () => {
  test('broadcasters lists everyone who may publish', async () => {
    participants = [
      participant('alice', { canPublish: true, name: 'Alice', tracks: [{}] }),
      participant('bob', { canPublish: true, name: 'Bob', tracks: [{}] }),
    ];
    const broadcasters = await stage.broadcasters();
    assert.deepEqual(
      broadcasters.map((b) => b.identity),
      ['alice', 'bob'],
    );
    assert.equal(broadcasters[0].publishing, true);
  });

  test('broadcasters is empty when nobody may publish', async () => {
    participants = [participant('alice'), participant('bob')];
    assert.deepEqual(await stage.broadcasters(), []);
  });

  test('participants lists everyone with their state', async () => {
    participants = [
      participant('alice', { canPublish: true, name: 'Alice', tracks: [{}] }),
      participant('bob', { name: 'Bob' }),
    ];
    const list = await stage.participants();

    assert.equal(list.length, 2);
    assert.deepEqual(
      list.map((p) => p.name),
      ['Alice', 'Bob'],
    );
    assert.equal(list[0].publishing, true);
    assert.equal(list[1].canPublish, false);
  });
});
