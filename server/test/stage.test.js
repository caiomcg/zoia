/**
 * Broadcast slots are where runtime publish permission is enforced. Different
 * participants may publish at the same time, but nobody publishes by default.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { TrackSource } from 'livekit-server-sdk';

import { createStage, VOICE_ATTRIBUTE } from '../src/stage.js';

let participants;
let updates;
let rooms;
let stage;
let clock;

function participant(
  identity,
  { canPublish = false, name = identity, tracks = [], sources, voice = false } = {},
) {
  return {
    identity,
    name,
    permission: {
      canPublish,
      canSubscribe: true,
      ...(sources ? { canPublishSources: sources } : {}),
    },
    tracks,
    attributes: voice ? { [VOICE_ATTRIBUTE]: '1' } : {},
  };
}

/** In voice and holding nothing else: what joinVoice leaves behind. */
function speaker(identity, options = {}) {
  return participant(identity, {
    canPublish: true,
    sources: [TrackSource.MICROPHONE],
    voice: true,
    ...options,
  });
}

const microphone = { source: TrackSource.MICROPHONE };

beforeEach(() => {
  participants = [];
  updates = [];
  rooms = {
    listParticipants: async () => participants,
    // As LiveKit does: a permission replaces the old one whole, while
    // attributes merge key by key and an empty value removes one.
    updateParticipant: async (room, identity, options) => {
      updates.push({ identity, permission: options.permission, attributes: options.attributes });
      const p = participants.find((x) => x.identity === identity);
      if (p && options.permission) p.permission = { ...options.permission };
      if (p && options.attributes) {
        p.attributes = { ...p.attributes, ...options.attributes };
        for (const [k, v] of Object.entries(p.attributes)) if (v === '') delete p.attributes[k];
      }
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

describe('metadata rights', () => {
  // LiveKit replaces the whole permission, so anything not restated is lost.
  // Losing canUpdateMetadata breaks the source label and renames mid-broadcast.
  test('claiming keeps the right to update your own metadata', async () => {
    participants = [participant('alice')];
    await stage.claim({ id: 'alice', name: 'Alice' });
    assert.equal(updates.at(-1).permission.canUpdateMetadata, true);
  });

  test('releasing keeps it too', async () => {
    participants = [participant('alice', { canPublish: true })];
    await stage.release({ id: 'alice', name: 'Alice' });
    assert.equal(updates.at(-1).permission.canUpdateMetadata, true);
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

describe('voice', () => {
  test('joining grants the microphone and nothing else', async () => {
    participants = [participant('alice')];
    const result = await stage.joinVoice({ id: 'alice', name: 'Alice' });

    assert.equal(result.ok, true);
    const { permission, attributes } = updates.at(-1);
    assert.equal(permission.canPublish, true);
    assert.deepEqual(permission.canPublishSources, [TrackSource.MICROPHONE]);
    assert.equal(permission.canUpdateMetadata, true, 'renames must survive joining voice');
    assert.equal(attributes[VOICE_ATTRIBUTE], '1');
  });

  test('joining from outside the room is refused', async () => {
    participants = [];
    const result = await stage.joinVoice({ id: 'alice', name: 'Alice' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not_in_room');
    assert.equal(updates.length, 0);
  });

  test('someone in voice does not hold a broadcast slot', async () => {
    participants = [speaker('alice', { tracks: [microphone] })];
    assert.deepEqual(await stage.broadcasters(), []);
    assert.equal(await stage.isBroadcaster('alice'), false);

    const [alice] = await stage.participants();
    assert.equal(alice.canPublish, false);
    assert.equal(alice.publishing, false, 'a voice is not a broadcast');
    assert.equal(alice.voice, true);
  });

  test('claiming from voice lifts the source limit', async () => {
    participants = [speaker('alice', { tracks: [microphone] })];
    const result = await stage.claim({ id: 'alice', name: 'Alice' });

    assert.equal(result.ok, true);
    assert.equal(updates.at(-1).permission.canPublish, true);
    assert.deepEqual(updates.at(-1).permission.canPublishSources ?? [], []);
    assert.equal(await stage.isBroadcaster('alice'), true);
  });

  test('releasing the stage keeps the microphone of someone in voice', async () => {
    participants = [participant('alice', { canPublish: true, voice: true, tracks: [{}] })];
    const result = await stage.release({ id: 'alice', name: 'Alice' });

    assert.equal(result.released, true);
    assert.equal(updates.at(-1).permission.canPublish, true);
    assert.deepEqual(updates.at(-1).permission.canPublishSources, [TrackSource.MICROPHONE]);
  });

  test('releasing the stage outside voice still revokes everything', async () => {
    participants = [participant('alice', { canPublish: true, tracks: [{}] })];
    await stage.release({ id: 'alice', name: 'Alice' });
    assert.equal(updates.at(-1).permission.canPublish, false);
  });

  test('joining voice mid-broadcast does not narrow the broadcast', async () => {
    participants = [participant('alice', { canPublish: true, tracks: [{}] })];
    await stage.joinVoice({ id: 'alice', name: 'Alice' });

    assert.equal(updates.at(-1).permission, undefined, 'the broadcast permission must stand');
    assert.equal(updates.at(-1).attributes[VOICE_ATTRIBUTE], '1');
  });

  test('leaving voice takes the microphone away', async () => {
    participants = [speaker('alice')];
    await stage.leaveVoice({ id: 'alice', name: 'Alice' });

    assert.equal(updates.at(-1).permission.canPublish, false);
    assert.equal(updates.at(-1).attributes[VOICE_ATTRIBUTE], '');
    assert.equal((await stage.participants())[0].voice, false);
  });

  test('leaving voice mid-broadcast leaves the broadcast alone', async () => {
    participants = [participant('alice', { canPublish: true, voice: true, tracks: [{}] })];
    await stage.leaveVoice({ id: 'alice', name: 'Alice' });

    assert.equal(updates.at(-1).permission, undefined);
    assert.equal(await stage.isBroadcaster('alice'), true);
  });

  test('a camera with its microphone is still a broadcast', async () => {
    participants = [
      participant('alice', {
        canPublish: true,
        tracks: [{ source: TrackSource.CAMERA }, microphone],
      }),
    ];
    const [alice] = await stage.broadcasters();
    assert.equal(alice.publishing, true);
  });
});
