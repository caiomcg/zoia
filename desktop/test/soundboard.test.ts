/**
 * The soundboard (ADR 0040). Whatever someone plays is fetched by everyone in
 * the channel, so what a message may point at is pinned down here, with what
 * is kept between sessions and how often one person may play.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeSoundMessage,
  encodeSoundMessage,
  isSoundUrl,
  parseSound,
  parseSoundList,
  parseSoundPage,
  addPad,
  clip,
  MAX_PAD_NAME,
  MAX_PADS,
  padEmoji,
  padSound,
  parsePads,
  removePad,
  renamePad,
  searchUrl,
  MAX_SOUND_SECONDS,
  type Sound,
} from '../src/shared/soundboard.ts';
import {
  addRecent,
  audibleRange,
  removeRecent,
  effectsGain,
  MAX_RECENTS,
  parseSoundboardSettings,
  sendBlock,
  setPersonMuted,
  SoundLock,
  lockMs,
  MAX_LOCK_MS,
  NETWORK_SLACK_MS,
  DEFAULT_SOUNDBOARD_SETTINGS,
} from '../src/renderer/soundboard/model.ts';
import { MAX_SOUND_SHORTCUTS } from '../src/shared/shortcuts.ts';

const FILES = 'https://www.myinstants.com/media/sounds/';

const sound = (slug: string): Sound => ({
  slug,
  name: slug.toUpperCase(),
  url: `${FILES}${slug}.mp3`,
  color: null,
});

describe('isSoundUrl', () => {
  test("Myinstants' own files, as its search names them", () => {
    assert.ok(isSoundUrl(`${FILES}movie_1.mp3`));
    assert.ok(isSoundUrl(`${FILES}fbi-open-up_dwLhIFf.mp3`));
    // Some uploads have no extension where it should be.
    assert.ok(isSoundUrl(`${FILES}.mp3_J6zB5jX`));
  });

  test('nothing else: another host, another folder, a query, a way out', () => {
    assert.ok(!isSoundUrl('https://evil.example/media/sounds/a.mp3'));
    assert.ok(!isSoundUrl('http://www.myinstants.com/media/sounds/a.mp3'));
    assert.ok(!isSoundUrl('https://www.myinstants.com.evil.example/media/sounds/a.mp3'));
    assert.ok(!isSoundUrl('https://www.myinstants.com/api/v1/instants/'));
    assert.ok(!isSoundUrl(`${FILES}a.mp3?x=1`));
    assert.ok(!isSoundUrl(`${FILES}../../admin`));
    assert.ok(!isSoundUrl(`${FILES}..`));
    assert.ok(!isSoundUrl(`${FILES}a%2F..%2Fb.mp3`));
    assert.ok(!isSoundUrl(FILES));
    assert.ok(!isSoundUrl(42));
  });
});

describe('parseSound', () => {
  test("reads Myinstants' answer and Zoia's own the same", () => {
    const fromSearch = parseSound({
      name: ' BRUH ',
      slug: 'bruh',
      sound: `${FILES}movie_1.mp3`,
      color: 'ffff33',
    });
    assert.deepEqual(fromSearch, {
      slug: 'bruh',
      name: 'BRUH',
      url: `${FILES}movie_1.mp3`,
      color: 'ffff33',
    });
    assert.deepEqual(parseSound(fromSearch), fromSearch);
  });

  test('a colour that is not six hex digits is no colour', () => {
    assert.equal(parseSound({ ...sound('a'), color: 'red' })?.color, null);
  });

  test('a bad slug, link or name is no sound', () => {
    assert.equal(parseSound({ ...sound('a'), slug: 'a b' }), null);
    assert.equal(parseSound({ ...sound('a'), url: 'https://evil.example/a.mp3' }), null);
    assert.equal(parseSound({ ...sound('a'), name: '   ' }), null);
    assert.equal(parseSound(null), null);
  });

  test('a long name is cut short', () => {
    assert.equal(parseSound({ ...sound('a'), name: 'x'.repeat(500) })?.name.length, 80);
  });
});

describe('search', () => {
  test('the query is trimmed and encoded, and only a later page is numbered', () => {
    const first = new URL(searchUrl(' faustão & cia ', 1));
    assert.equal(first.origin + first.pathname, 'https://www.myinstants.com/api/v1/instants/');
    assert.equal(first.searchParams.get('name'), 'faustão & cia');
    assert.equal(first.searchParams.get('format'), 'json');
    assert.equal(first.searchParams.get('page'), null);
    assert.equal(new URL(searchUrl('a', 3)).searchParams.get('page'), '3');
  });

  test('a page keeps what can be played, and says whether there is another', () => {
    const page = parseSoundPage(
      {
        next: 'https://www.myinstants.com/api/v1/instants/?page=3',
        results: [sound('a'), { slug: 'b', name: 'B', sound: 'https://evil.example/b.mp3' }],
      },
      2,
    );
    assert.deepEqual(
      page.sounds.map((s) => s.slug),
      ['a'],
    );
    assert.equal(page.next, 3);
    assert.equal(parseSoundPage({ next: null, results: [] }, 1).next, null);
    assert.deepEqual(parseSoundPage('nonsense', 1), { sounds: [], next: null });
  });
});

describe('messages', () => {
  test('a sound survives the trip through the room, colour left behind', () => {
    const played = { ...sound('bruh'), color: 'ff0000' };
    assert.deepEqual(decodeSoundMessage(encodeSoundMessage(played)), { ...played, color: null });
  });

  test('anything else from the room is nothing', () => {
    assert.equal(decodeSoundMessage(new TextEncoder().encode('{')), null);
    const elsewhere = { ...sound('a'), url: 'https://evil.example/a.mp3' };
    assert.equal(decodeSoundMessage(new TextEncoder().encode(JSON.stringify(elsewhere))), null);
  });
});

describe('the pad and recents', () => {
  test('as many pads as there may be shortcuts', () => {
    assert.equal(MAX_PADS, MAX_SOUND_SHORTCUTS);
  });

  test('a sound is added once, without an emoji, and not past the limit', () => {
    let list = addPad([], sound('a'));
    list = addPad(list, sound('a'));
    assert.deepEqual(list, [{ ...sound('a'), emoji: null }]);
    const full = Array.from({ length: MAX_PADS }, (_, i) => sound(`s${i}`));
    assert.equal(addPad(parsePads(JSON.stringify(full)), sound('more')).length, MAX_PADS);
    assert.deepEqual(removePad(list, 'a'), []);
  });

  test('a pad is renamed with emoji in its name, and given one of its own', () => {
    const list = renamePad(addPad([], sound('a')), 'a', { name: '  🎺 Toot 🎉 ', emoji: '📢' });
    assert.equal(list[0]?.name, '🎺 Toot 🎉');
    assert.equal(list[0]?.emoji, '📢');
    // What everyone else is told it is called.
    assert.equal(padSound(list[0]!).name, '📢 🎺 Toot 🎉');
    assert.equal(padSound({ ...list[0]!, emoji: null }).name, '🎺 Toot 🎉');
  });

  test('an empty name keeps the old one; a long one is cut by character, not through an emoji', () => {
    const list = addPad([], sound('a'));
    assert.equal(renamePad(list, 'a', { name: '   ', emoji: null })[0]?.name, 'A');
    const long = 'x'.repeat(MAX_PAD_NAME - 1) + '👍🏽👍🏽';
    assert.equal(renamePad(list, 'a', { name: long, emoji: null })[0]?.name, long.slice(0, -4));
    assert.equal(clip('👨‍👩‍👧 family', 1), '👨‍👩‍👧');
  });

  test("a pad's emoji is one emoji, the last one given, or none", () => {
    assert.equal(padEmoji('🔥'), '🔥');
    assert.equal(padEmoji('🔥🚀'), '🚀');
    assert.equal(padEmoji('👍🏽'), '👍🏽');
    assert.equal(padEmoji('🇧🇷'), '🇧🇷');
    assert.equal(padEmoji('a'), null);
    assert.equal(padEmoji(''), null);
    assert.equal(padEmoji(7), null);
  });

  test('a kept pad is read back with its emoji, and anything wrong in it left out', () => {
    const raw = JSON.stringify([
      { ...sound('a'), emoji: '🐐' },
      { ...sound('b'), emoji: 'not one' },
      { slug: 'x' },
      sound('a'),
    ]);
    assert.deepEqual(parsePads(raw), [
      { ...sound('a'), emoji: '🐐' },
      { ...sound('b'), emoji: null },
    ]);
    assert.deepEqual(parsePads('{'), []);
    assert.deepEqual(parsePads(null), []);
  });

  test('the latest sound comes first, once, and only the last four are kept', () => {
    let list: Sound[] = [];
    for (let i = 0; i < 12; i++) list = addRecent(list, sound(`s${i}`));
    list = addRecent(list, sound('s5'));
    assert.equal(list.length, MAX_RECENTS);
    assert.equal(list[0]?.slug, 's5');
    assert.equal(list.filter((s) => s.slug === 's5').length, 1);
    assert.deepEqual(
      removeRecent(list, 's5').map((s) => s.slug),
      list.slice(1).map((s) => s.slug),
    );
  });

  test('a sound on your pad is not recent', () => {
    const list = addRecent([sound('a')], sound('b'), [{ slug: 'b' }]);
    assert.deepEqual(
      list.map((s) => s.slug),
      ['a'],
    );
  });

  test('a stored list is read back, and anything wrong in it left out', () => {
    const raw = JSON.stringify([sound('a'), { slug: 'x' }, sound('a'), sound('b')]);
    assert.deepEqual(
      parseSoundList(raw, 10).map((s) => s.slug),
      ['a', 'b'],
    );
    assert.equal(parseSoundList(raw, 1).length, 1);
    assert.deepEqual(parseSoundList('{', 10), []);
    assert.deepEqual(parseSoundList(null, 10), []);
  });
});

describe('settings', () => {
  test('unreadable is the default, and the volume stays between 0 and 1', () => {
    assert.deepEqual(parseSoundboardSettings(null), DEFAULT_SOUNDBOARD_SETTINGS);
    assert.deepEqual(parseSoundboardSettings('nonsense'), DEFAULT_SOUNDBOARD_SETTINGS);
    assert.equal(parseSoundboardSettings('{"volume":3}').volume, 1);
    assert.equal(parseSoundboardSettings('{"volume":-1}').volume, 0);
    assert.deepEqual(parseSoundboardSettings('{"mutedPeople":["ana",4,"ana",""]}').mutedPeople, [
      'ana',
    ]);
  });

  test('muted plays nothing, whatever the volume', () => {
    assert.equal(effectsGain({ ...DEFAULT_SOUNDBOARD_SETTINGS, volume: 0.8 }), 0.8);
    assert.equal(effectsGain({ ...DEFAULT_SOUNDBOARD_SETTINGS, volume: 0.8, muted: true }), 0);
  });

  test('muting someone once, and hearing them again', () => {
    let settings = setPersonMuted(DEFAULT_SOUNDBOARD_SETTINGS, 'ana', true);
    settings = setPersonMuted(settings, 'ana', true);
    assert.deepEqual(settings.mutedPeople, ['ana']);
    assert.deepEqual(setPersonMuted(settings, 'ana', false).mutedPeople, []);
  });
});

describe('who may play', () => {
  test('only in voice, with the microphone on and the effects heard', () => {
    const on = DEFAULT_SOUNDBOARD_SETTINGS;
    assert.equal(sendBlock({ inVoice: true, muted: false }, on), null);
    assert.equal(sendBlock({ inVoice: false, muted: false }, on), 'notInVoice');
    assert.equal(sendBlock({ inVoice: true, muted: true }, on), 'micMuted');
    assert.equal(
      sendBlock({ inVoice: true, muted: false }, { ...on, muted: true }),
      'effectsMuted',
    );
  });

  test('the lock lasts exactly as long as the sound played, no more, no less', () => {
    assert.equal(lockMs(3.2), 3200);
    assert.equal(lockMs(1.5), 1500);
    assert.equal(lockMs(0.05), 50);
  });

  test('the lock is never longer than a sound may play', () => {
    assert.equal(lockMs(60), MAX_LOCK_MS);
    assert.equal(MAX_LOCK_MS, MAX_SOUND_SECONDS * 1000);
  });

  test('a sound of no length locks for nothing', () => {
    for (const nothing of [NaN, Infinity, 0, -1]) assert.equal(lockMs(nothing), 0);
  });

  test('a sound is held from when it starts until it ends, each person apart', () => {
    const lock = new SoundLock();
    assert.ok(lock.take('ana', 0));
    // Loaded and started 800 ms later, 3 s long.
    lock.hold('ana', 0, 800 + 3000);
    assert.ok(!lock.take('ana', 3799));
    assert.ok(lock.take('bia', 1000));
    assert.ok(lock.take('ana', 3800));
  });

  test('until it starts, a newer sound from the same person may replace it', () => {
    const lock = new SoundLock();
    assert.ok(lock.take('ana', 0));
    assert.ok(lock.take('ana', 100));
    // The first one's end arrives late: it was replaced, so it holds nothing.
    lock.hold('ana', 0, 10_000);
    assert.ok(lock.take('ana', 200));
  });

  test("a listener forgives the network's slack of the sender's lock", () => {
    const lock = new SoundLock(NETWORK_SLACK_MS);
    assert.ok(lock.take('ana', 0));
    lock.hold('ana', 0, 3000);
    assert.ok(!lock.take('ana', 3000 - NETWORK_SLACK_MS - 1));
    assert.ok(lock.take('ana', 3000 - NETWORK_SLACK_MS));
  });
});

describe('audibleRange', () => {
  const rate = 10;
  test('skips the silence before and after the sound', () => {
    const samples = [0, 0, 0.005, 0.5, -0.3, 0.2, 0, 0, 0, 0];
    assert.deepEqual(audibleRange([samples], rate), { from: 0.3, to: 0.6 });
  });

  test('a sound on any channel counts', () => {
    const left = [0, 0, 0, 0, 0.4, 0, 0, 0];
    const right = [0, 0.4, 0, 0, 0, 0, 0, 0];
    assert.deepEqual(audibleRange([left, right], rate), { from: 0.1, to: 0.5 });
  });

  test('silence throughout plays whole', () => {
    assert.deepEqual(audibleRange([[0, 0, 0, 0]], rate), { from: 0, to: 0.4 });
  });
});
