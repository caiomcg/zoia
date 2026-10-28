/**
 * Whoever sits in a channel neither sharing nor watching is kicked, and told
 * why first. See ADR 0037.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createStage } from '../src/stage.js';
import { fixedChannels } from '../src/channels.js';
import { createIdleSweeper, kick } from '../src/idle.js';

const MINUTE = 60_000;
const quiet = { info() {}, warn() {} };

let room;
let clock;
let sweeper;

function fakeRoom() {
  const r = {
    participants: [],
    sent: [],
    removed: [],
    listParticipants: async () => r.participants,
    updateParticipant: async () => {},
    removeParticipant: async (_name, identity) => {
      r.removed.push(identity);
      r.participants = r.participants.filter((p) => p.identity !== identity);
    },
    sendData: async (_name, data, _kind, options) => {
      r.sent.push({ to: options.destinationIdentities, topic: options.topic });
    },
  };
  return r;
}

/** TrackSource.MICROPHONE: a voice, which is no share. */
function microphone({ muted = false } = {}) {
  return { source: 2, muted };
}

function enter(identity, { watching = '', tracks = [], voice = false } = {}) {
  room.participants.push({
    identity,
    name: identity,
    permission: {},
    tracks,
    attributes: {
      ...(watching ? { 'zoia.watching': watching } : {}),
      ...(voice ? { 'zoia.voice': '1' } : {}),
    },
  });
}

beforeEach(() => {
  room = fakeRoom();
  clock = 0;
  sweeper = createIdleSweeper({
    channels: fixedChannels([
      {
        id: 'zoia',
        name: 'Lobby',
        stage: createStage({ rooms: room, roomName: 'zoia', logger: quiet }),
      },
    ]),
    idleMs: 10 * MINUTE,
    graceMs: 0,
    logger: quiet,
    now: () => clock,
  });
});

async function at(minutes) {
  clock = minutes * MINUTE;
  await sweeper.sweep();
}

describe('the idle sweep', () => {
  test('kicks someone who has done nothing for ten minutes, and nobody sooner', async () => {
    enter('idle');
    await at(0);
    await at(9);
    assert.deepEqual(room.removed, []);
    await at(10);
    assert.deepEqual(room.sent, [{ to: ['idle'], topic: 'zoia.kick' }]);
    assert.deepEqual(room.removed, ['idle', 'idle-gpu']);
  });

  test('sharing or watching keeps someone, and stopping starts the clock', async () => {
    enter('sharer', { tracks: [{}] });
    enter('watcher', { watching: 'sharer' });
    enter('gpu');
    enter('gpu-gpu', { tracks: [{}] });
    await at(0);
    await at(30);
    assert.deepEqual(room.removed, []);

    room.participants.find((p) => p.identity === 'watcher').attributes = {};
    await at(39);
    assert.deepEqual(room.removed, []);
    await at(40);
    assert.deepEqual(room.removed, ['watcher', 'watcher-gpu']);
  });

  test('talking to someone keeps the talker; being in voice alone keeps nobody', async () => {
    enter('talker', { voice: true, tracks: [microphone()] });
    enter('listener', { voice: true, tracks: [microphone({ muted: true })] });
    await at(0);
    await at(10);
    assert.deepEqual(room.removed, ['listener', 'listener-gpu']);

    // Nobody left to hear: the microphone on is no longer activity.
    room.participants = room.participants.filter((p) => p.identity === 'talker');
    await at(19);
    assert.deepEqual(room.removed, ['listener', 'listener-gpu']);
    await at(20);
    assert.deepEqual(room.removed, ['listener', 'listener-gpu', 'talker', 'talker-gpu']);
  });

  test('leaving and coming back starts afresh', async () => {
    enter('bob');
    await at(0);
    room.participants = [];
    await at(5);
    enter('bob');
    await at(9);
    await at(18);
    assert.deepEqual(room.removed, []);
    await at(19);
    assert.deepEqual(room.removed, ['bob', 'bob-gpu']);
  });
});

describe('a kick', () => {
  test('is removed even when the message cannot be sent', async () => {
    room.sendData = async () => {
      throw new Error('gone');
    };
    enter('bob');
    await kick(createStage({ rooms: room, roomName: 'zoia', logger: quiet }), 'bob', 'admin', {
      graceMs: 0,
    });
    assert.deepEqual(room.removed, ['bob', 'bob-gpu']);
  });
});
