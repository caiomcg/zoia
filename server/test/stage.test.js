/**
 * The stage is where single-producer is enforced. These tests cover the cases
 * that would otherwise be discovered by two people trying to broadcast at once.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createStage } from '../src/stage.js';

let participants;
let updates;
let rooms;
let stage;

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
  stage = createStage({ rooms, roomName: 'zoia', logger: { info() {}, warn() {} } });
});

describe('claiming', () => {
  test('an empty stage can be claimed', async () => {
    participants = [participant('alice')];
    const result = await stage.claim({ id: 'alice', name: 'Alice' });

    assert.equal(result.ok, true);
    assert.equal(updates.at(-1).identity, 'alice');
    assert.equal(updates.at(-1).permission.canPublish, true);
  });

  test('a second person is refused while someone holds it', async () => {
    participants = [participant('alice', { canPublish: true, name: 'Alice' }), participant('bob')];

    const result = await stage.claim({ id: 'bob', name: 'Bob' });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'busy');
    assert.equal(result.holder.name, 'Alice');
    assert.equal(updates.length, 0, 'a refused claim must not change any permission');
  });

  test('the holder re-claiming is allowed, so a retry is not a lockout', async () => {
    participants = [participant('alice', { canPublish: true })];
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
    assert.equal(result.ok, true);
  });
});

describe('releasing', () => {
  test('the holder can release, and permission is revoked', async () => {
    participants = [participant('alice', { canPublish: true })];
    const result = await stage.release({ id: 'alice', name: 'Alice' });

    assert.equal(result.released, true);
    assert.equal(updates.at(-1).permission.canPublish, false);
  });

  test('releasing when you do not hold it is a harmless no-op', async () => {
    participants = [participant('alice', { canPublish: true }), participant('bob')];
    const result = await stage.release({ id: 'bob', name: 'Bob' });

    assert.equal(result.ok, true);
    assert.equal(result.released, false);
    assert.equal(updates.length, 0, "must not revoke the real holder's permission");
  });

  test('release then claim by someone else succeeds', async () => {
    participants = [participant('alice', { canPublish: true }), participant('bob')];
    await stage.release({ id: 'alice', name: 'Alice' });
    const result = await stage.claim({ id: 'bob', name: 'Bob' });
    assert.equal(result.ok, true);
  });
});

describe('reporting', () => {
  test('holder reflects who may publish, and whether they are live', async () => {
    participants = [participant('alice', { canPublish: true, name: 'Alice', tracks: [{}] })];
    const holder = await stage.holder();
    assert.equal(holder.identity, 'alice');
    assert.equal(holder.publishing, true);
  });

  test('holder is null when nobody may publish', async () => {
    participants = [participant('alice'), participant('bob')];
    assert.equal(await stage.holder(), null);
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
