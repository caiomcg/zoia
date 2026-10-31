/**
 * A cue that fires on the wrong change is noise people learn to mute, so the
 * rules for which change earns which sound are pinned down here.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SOUND_SETTINGS,
  cuesBetween,
  isFixedCue,
  notesFor,
  parseSoundSettings,
  viewerCuesBetween,
  voiceFor,
  type CueMember,
} from '../src/renderer/sounds/cues.ts';

const me: CueMember = { identity: 'me', isLocal: true, isBroadcasting: false };
const ana: CueMember = { identity: 'ana', isLocal: false, isBroadcasting: false };
const live = (member: CueMember): CueMember => ({ ...member, isBroadcasting: true });

describe('cuesBetween', () => {
  test('nothing changed, nothing plays', () => {
    assert.deepEqual(cuesBetween([me, ana], [me, ana]), []);
  });

  test('someone arriving and leaving', () => {
    assert.deepEqual(cuesBetween([me], [me, ana]), ['join']);
    assert.deepEqual(cuesBetween([me, ana], [me]), ['leave']);
  });

  test('this device is never announced to itself as arriving or leaving', () => {
    assert.deepEqual(cuesBetween([], [me]), []);
    assert.deepEqual(cuesBetween([me], []), []);
  });

  test('someone else going live and stopping', () => {
    assert.deepEqual(cuesBetween([me, ana], [me, live(ana)]), ['streamStart']);
    assert.deepEqual(cuesBetween([me, live(ana)], [me, ana]), ['streamStop']);
  });

  test('this device going live is left to its broadcast state', () => {
    assert.deepEqual(cuesBetween([me], [live(me)]), []);
    assert.deepEqual(cuesBetween([live(me)], [me]), []);
  });

  test('leaving while live is only a leave', () => {
    assert.deepEqual(cuesBetween([me, live(ana)], [me]), ['leave']);
  });

  test('arriving already live is both', () => {
    assert.deepEqual(cuesBetween([me], [me, live(ana)]), ['join', 'streamStart']);
  });

  test('several people doing the same thing is one cue', () => {
    const bo = { ...ana, identity: 'bo' };
    assert.deepEqual(cuesBetween([me], [me, ana, bo]), ['join']);
  });
});

describe('parseSoundSettings', () => {
  test('nothing stored, or garbage, is the defaults', () => {
    assert.deepEqual(parseSoundSettings(null), DEFAULT_SOUND_SETTINGS);
    assert.deepEqual(parseSoundSettings('{not json'), DEFAULT_SOUND_SETTINGS);
    assert.deepEqual(parseSoundSettings('42'), DEFAULT_SOUND_SETTINGS);
  });

  test('keeps valid fields and repairs the rest', () => {
    const parsed = parseSoundSettings(
      JSON.stringify({
        volume: 3,
        cues: { join: { enabled: false, style: 'kazoo', pitch: 99 }, leave: { pitch: -2.4 } },
      }),
    );
    assert.equal(parsed.volume, 1);
    assert.deepEqual(parsed.cues.join, { enabled: false, style: 'chime', pitch: 6, volume: 1 });
    assert.deepEqual(parsed.cues.leave, { enabled: true, style: 'chime', pitch: -2, volume: 1 });
    assert.deepEqual(parsed.cues.streamStart, DEFAULT_SOUND_SETTINGS.cues.streamStart);
  });
});

describe('notesFor', () => {
  test('arrivals rise and departures fall', () => {
    const rise = notesFor('join', { style: 'chime', pitch: 0 });
    const fall = notesFor('leave', { style: 'chime', pitch: 0 });
    assert.ok(rise[0].frequency < rise[1].frequency);
    assert.ok(fall[0].frequency > fall[1].frequency);
  });

  test('pitch shifts every note by semitones', () => {
    const base = notesFor('streamStart', { style: 'pop', pitch: 0 });
    const octaveish = notesFor('streamStart', { style: 'pop', pitch: 6 });
    base.forEach((note, index) =>
      assert.ok(Math.abs(octaveish[index].frequency / note.frequency - Math.SQRT2) < 1e-9),
    );
  });

  test('a cue stays short', () => {
    for (const style of ['chime', 'pop', 'soft'] as const) {
      const notes = notesFor('streamStop', { style, pitch: 0 });
      const end = Math.max(...notes.map((note) => note.at + note.duration));
      assert.ok(end < 0.7, `${style} lasts ${end}s`);
    }
  });
});

describe('the mention cue', () => {
  test('is on for settings saved before it existed, keeping the others', () => {
    const saved = JSON.stringify({
      volume: 0.3,
      cues: { join: { enabled: false, style: 'soft', pitch: 2 } },
    });
    const settings = parseSoundSettings(saved);
    assert.deepEqual(settings.cues.mention, DEFAULT_SOUND_SETTINGS.cues.mention);
    assert.equal(settings.cues.mention.enabled, true);
    assert.deepEqual(settings.cues.join, { enabled: false, style: 'soft', pitch: 2, volume: 1 });
  });

  test('sounds unlike any channel cue', () => {
    const pattern = (event: Parameters<typeof notesFor>[0]) =>
      notesFor(event, { style: 'chime', pitch: 0 })
        .map((n) => n.frequency.toFixed(1))
        .join();
    const mention = pattern('mention');
    for (const other of ['join', 'leave', 'streamStart', 'streamStop'] as const) {
      assert.notEqual(mention, pattern(other));
    }
  });
});

describe('the mention bell', () => {
  test('is the same whatever style or pitch is set', () => {
    const plain = notesFor('mention', { style: 'chime', pitch: 0 });
    assert.deepEqual(notesFor('mention', { style: 'soft', pitch: 5 }), plain);
    assert.deepEqual(voiceFor('mention', 'pop'), voiceFor('mention', 'chime'));
    assert.ok(isFixedCue('mention'));
    assert.ok(!isFixedCue('join'));
  });

  test('has the uneven partials no channel cue has', () => {
    assert.ok((voiceFor('mention', 'chime').partials ?? []).length > 0);
    for (const style of ['chime', 'pop', 'soft'] as const) {
      assert.equal(voiceFor('join', style).partials, undefined);
    }
  });
});

describe("a cue's own volume", () => {
  test('is kept between 0 and 1, and full for settings saved before it', () => {
    const parsed = parseSoundSettings(
      JSON.stringify({ cues: { mention: { volume: 0.4 }, join: { volume: 3 }, leave: {} } }),
    );
    assert.equal(parsed.cues.mention.volume, 0.4);
    assert.equal(parsed.cues.join.volume, 1);
    assert.equal(parsed.cues.leave.volume, 1);
    assert.equal(
      parseSoundSettings(JSON.stringify({ cues: { join: { volume: -1 } } })).cues.join.volume,
      0,
    );
  });
});

describe('viewerCuesBetween', () => {
  test('someone starting and stopping watching you', () => {
    assert.deepEqual(viewerCuesBetween([], ['ana']), ['viewerJoin']);
    assert.deepEqual(viewerCuesBetween(['ana'], []), ['viewerLeave']);
    assert.deepEqual(viewerCuesBetween(['ana'], ['ana']), []);
  });

  test('going live, reconnecting or stopping is only a baseline, never a burst', () => {
    assert.deepEqual(viewerCuesBetween(null, ['ana', 'bo']), []);
    assert.deepEqual(viewerCuesBetween(['ana', 'bo'], null), []);
    assert.deepEqual(viewerCuesBetween(null, null), []);
  });

  test('several at once is one cue, and a swap is both', () => {
    assert.deepEqual(viewerCuesBetween([], ['ana', 'bo']), ['viewerJoin']);
    assert.deepEqual(viewerCuesBetween(['ana'], ['bo']), ['viewerJoin', 'viewerLeave']);
  });
});

describe('the viewer cues', () => {
  test('are on, and quieter, for settings saved before they existed', () => {
    const settings = parseSoundSettings(
      JSON.stringify({ volume: 0.3, cues: { join: { enabled: false } } }),
    );
    for (const event of ['viewerJoin', 'viewerLeave'] as const) {
      assert.deepEqual(settings.cues[event], DEFAULT_SOUND_SETTINGS.cues[event]);
      assert.equal(settings.cues[event].enabled, true);
      assert.ok(settings.cues[event].volume < 1);
    }
    assert.equal(settings.cues.join.enabled, false);
  });

  test('keep a lowered volume of their own', () => {
    const parsed = parseSoundSettings(JSON.stringify({ cues: { viewerLeave: { volume: 0.2 } } }));
    assert.equal(parsed.cues.viewerLeave.volume, 0.2);
    assert.equal(parsed.cues.viewerJoin.volume, DEFAULT_SOUND_SETTINGS.cues.viewerJoin.volume);
  });

  test('rise when someone starts and fall when they stop, briefly', () => {
    const rise = notesFor('viewerJoin', { style: 'chime', pitch: 0 });
    const fall = notesFor('viewerLeave', { style: 'chime', pitch: 0 });
    assert.ok(rise[0].frequency < rise[1].frequency);
    assert.ok(fall[0].frequency > fall[1].frequency);
    for (const notes of [rise, fall]) {
      assert.ok(Math.max(...notes.map((note) => note.at + note.duration)) < 0.4);
    }
  });

  test('sound unlike every other cue, whatever style is set', () => {
    assert.ok(isFixedCue('viewerJoin') && isFixedCue('viewerLeave'));
    const pattern = (event: Parameters<typeof notesFor>[0], style: 'chime' | 'pop' | 'soft') =>
      notesFor(event, { style, pitch: 0 })
        .map((n) => n.frequency.toFixed(1))
        .join();
    for (const style of ['chime', 'pop', 'soft'] as const) {
      for (const viewer of ['viewerJoin', 'viewerLeave'] as const) {
        for (const other of ['join', 'leave', 'streamStart', 'streamStop', 'mention'] as const) {
          assert.notEqual(pattern(viewer, style), pattern(other, style));
        }
      }
    }
  });
});
