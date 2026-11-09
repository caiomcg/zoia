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
    // What each message said, beside `sent`, which only says where it went.
    messages: [],
    removed: [],
    listParticipants: async () => r.participants,
    updateParticipant: async () => {},
    removeParticipant: async (_name, identity) => {
      r.removed.push(identity);
      r.participants = r.participants.filter((p) => p.identity !== identity);
    },
    sendData: async (_name, data, _kind, options) => {
      r.sent.push({ to: options.destinationIdentities, topic: options.topic });
      r.messages.push(JSON.parse(Buffer.from(data).toString('utf8')));
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

  test('someone using their computer stays, and leaving it starts the clock', async () => {
    const using = new Set(['gamer']);
    sweeper = createIdleSweeper({
      channels: fixedChannels([
        {
          id: 'zoia',
          name: 'Lobby',
          stage: createStage({ rooms: room, roomName: 'zoia', logger: quiet }),
        },
      ]),
      idleMs: 10 * MINUTE,
      inUse: (identity) => using.has(identity),
      graceMs: 0,
      logger: quiet,
      now: () => clock,
    });
    enter('gamer', { voice: true, tracks: [microphone({ muted: true })] });
    await at(0);
    await at(120);
    assert.deepEqual(room.removed, []);

    using.delete('gamer');
    await at(129);
    assert.deepEqual(room.removed, []);
    await at(130);
    assert.deepEqual(room.removed, ['gamer', 'gamer-gpu']);
  });
});

describe('the away channel', () => {
  let away;

  /** A lobby in `room` and an away channel in `away`. */
  function withAway(options = {}) {
    away = fakeRoom();
    sweeper = createIdleSweeper({
      channels: fixedChannels([
        {
          id: 'zoia',
          name: 'Lobby',
          stage: createStage({ rooms: room, roomName: 'zoia', logger: quiet }),
        },
        {
          id: 'zoia-away',
          name: 'Away',
          away: true,
          stage: createStage({ rooms: away, roomName: 'zoia-away', logger: quiet }),
        },
      ]),
      idleMs: 10 * MINUTE,
      awayIdleMs: 60 * MINUTE,
      graceMs: 0,
      logger: quiet,
      now: () => clock,
      ...options,
    });
  }

  /** What the app does when told to move: leaves the lobby for the away channel. */
  function goAway(identity) {
    room.participants = room.participants.filter((p) => p.identity !== identity);
    away.participants.push({
      identity,
      name: identity,
      permission: {},
      tracks: [],
      attributes: {},
    });
  }

  test('the idle elsewhere are moved there, not disconnected', async () => {
    withAway();
    enter('here');
    await at(0);
    await at(9);
    assert.deepEqual(room.sent, []);
    await at(10);
    assert.deepEqual(room.sent, [{ to: ['here'], topic: 'zoia.move' }]);
    assert.deepEqual(room.messages, [{ channel: 'zoia-away', reason: 'idle' }]);
    assert.deepEqual(room.removed, []);

    goAway('here');
    await at(11);
    assert.deepEqual(room.removed, []);
    assert.deepEqual(away.removed, []);
  });

  test('keeps someone for its own limit, counted from arriving', async () => {
    withAway();
    enter('here');
    await at(0);
    await at(10);
    goAway('here');
    await at(11);
    await at(70);
    assert.deepEqual(away.removed, []);
    await at(71);
    assert.deepEqual(away.sent, [{ to: ['here'], topic: 'zoia.kick' }]);
    assert.deepEqual(away.removed, ['here', 'here-gpu']);
  });

  test('someone told to move who stays put is disconnected at the next sweep', async () => {
    withAway();
    enter('android');
    await at(0);
    await at(10);
    assert.deepEqual(room.removed, []);
    await at(11);
    assert.deepEqual(room.sent.at(-1), { to: ['android'], topic: 'zoia.kick' });
    assert.deepEqual(room.removed, ['android', 'android-gpu']);
  });

  test('someone told to move who is back before the next sweep stays', async () => {
    withAway();
    enter('back');
    await at(0);
    await at(10);
    room.participants[0].attributes = { 'zoia.watching': 'someone' };
    await at(11);
    assert.deepEqual(room.removed, []);
  });

  test('someone using their computer is not moved', async () => {
    withAway({ inUse: (identity) => identity === 'busy' });
    enter('busy');
    await at(0);
    await at(60);
    assert.deepEqual(room.sent, []);
  });

  test('a limit of 0 kicks nobody from the channels it covers', async () => {
    sweeper = createIdleSweeper({
      channels: fixedChannels([
        {
          id: 'zoia',
          name: 'Lobby',
          stage: createStage({ rooms: room, roomName: 'zoia', logger: quiet }),
        },
      ]),
      idleMs: 0,
      awayIdleMs: 60 * MINUTE,
      graceMs: 0,
      logger: quiet,
      now: () => clock,
    });
    enter('stays');
    await at(0);
    await at(600);
    assert.deepEqual(room.removed, []);
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
