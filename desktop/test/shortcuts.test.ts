/**
 * Voice's global shortcuts (ADR 0039): what counts as pressed, what a
 * recording takes, and that a saved binding survives being read back.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  assign,
  bindingLabel,
  BindingRecorder,
  ChordTracker,
  isShortcutAction,
  keyCode,
  keyName,
  MAX_SOUND_SHORTCUTS,
  mouseCode,
  parseBindings,
  shortcutSound,
  soundShortcut,
} from '../src/shared/shortcuts.ts';

const CTRL = keyCode(29);
const SHIFT = keyCode(42);
const M = keyCode(50);
const ESC = keyCode(1);
const MOUSE4 = mouseCode(4);

const none = parseBindings({});

describe('ChordTracker', () => {
  test('push to talk is down while held and up when let go', () => {
    const tracker = new ChordTracker({ ...none, pushToTalk: [MOUSE4] });
    assert.deepEqual(tracker.down(MOUSE4), [{ action: 'pushToTalk', pressed: true }]);
    assert.deepEqual(tracker.up(MOUSE4), [{ action: 'pushToTalk', pressed: false }]);
  });

  test('a combination fires once all of it is held, and key repeat changes nothing', () => {
    const tracker = new ChordTracker({ ...none, toggleMute: [CTRL, SHIFT, M] });
    assert.deepEqual(tracker.down(CTRL), []);
    assert.deepEqual(tracker.down(SHIFT), []);
    assert.deepEqual(tracker.down(M), [{ action: 'toggleMute', pressed: true }]);
    assert.deepEqual(tracker.down(M), []);
    assert.deepEqual(tracker.up(CTRL), [{ action: 'toggleMute', pressed: false }]);
  });

  test('stopping lets go of a held push to talk', () => {
    const tracker = new ChordTracker({ ...none, pushToTalk: [MOUSE4] });
    tracker.down(MOUSE4);
    assert.deepEqual(tracker.reset(), [{ action: 'pushToTalk', pressed: false }]);
  });
});

describe('BindingRecorder', () => {
  test('takes everything held together once it is all let go, modifiers first', () => {
    const recorder = new BindingRecorder();
    recorder.down(M);
    recorder.down(CTRL);
    assert.equal(recorder.up(M), undefined);
    assert.deepEqual(recorder.up(CTRL), [CTRL, M]);
  });

  test('a mouse side button is a binding; the left and right buttons are not', () => {
    const recorder = new BindingRecorder();
    assert.equal(recorder.down(mouseCode(1)), undefined);
    assert.equal(recorder.up(mouseCode(1)), undefined);
    recorder.down(MOUSE4);
    assert.deepEqual(recorder.up(MOUSE4), [MOUSE4]);
  });

  test('Escape on its own cancels; with something else it is a key', () => {
    const alone = new BindingRecorder();
    alone.down(ESC);
    assert.equal(alone.up(ESC), null);

    const combined = new BindingRecorder();
    combined.down(CTRL);
    combined.down(ESC);
    combined.up(ESC);
    assert.deepEqual(combined.up(CTRL), [CTRL, ESC]);
  });
});

describe('bindings', () => {
  test('one binding does one thing: taking it clears it elsewhere', () => {
    const next = assign({ ...none, toggleMute: [MOUSE4] }, 'pushToTalk', [MOUSE4]);
    assert.deepEqual(next.pushToTalk, [MOUSE4]);
    assert.equal(next.toggleMute, null);
  });

  test('what was saved is read back; anything odd is as never set', () => {
    assert.deepEqual(
      parseBindings({ pushToTalk: [M, CTRL], toggleMute: 'x', toggleDeafen: [mouseCode(1)] }),
      { pushToTalk: [CTRL, M], toggleMute: null, toggleDeafen: null },
    );
    assert.deepEqual(parseBindings(null), none);
  });

  test('a favourite has a binding of its own, which voice can take from it', () => {
    const bruh = soundShortcut('bruh');
    let next = assign(none, bruh, [CTRL, M]);
    assert.deepEqual(next[bruh], [CTRL, M]);
    next = assign(next, 'toggleMute', [CTRL, M]);
    assert.deepEqual(next.toggleMute, [CTRL, M]);
    assert.ok(!(bruh in next));
    // And a sound with nothing bound is no entry at all.
    assert.ok(!(bruh in assign(assign(none, bruh, [M]), bruh, null)));
  });

  test('favourites are read back, at most as many as there may be', () => {
    const stored: Record<string, unknown> = { 'sound:bad slug': [M], 'other:x': [M] };
    for (let i = 0; i < MAX_SOUND_SHORTCUTS + 5; i++) stored[`sound:s${i}`] = [keyCode(2 + i)];
    const parsed = parseBindings(stored);
    const sounds = Object.keys(parsed).filter((action) => action.startsWith('sound:'));
    assert.equal(sounds.length, MAX_SOUND_SHORTCUTS);
    assert.ok(!('sound:bad slug' in parsed));
    assert.ok(!('other:x' in parsed));
  });

  test('a favourite fires like any shortcut, and lets go when it is unbound', () => {
    const bruh = soundShortcut('bruh');
    const tracker = new ChordTracker({ ...none, [bruh]: [MOUSE4] });
    assert.deepEqual(tracker.down(MOUSE4), [{ action: bruh, pressed: true }]);
    assert.deepEqual(tracker.setBindings(none), [{ action: bruh, pressed: false }]);
  });

  test('what may be bound: voice and sounds, nothing else', () => {
    assert.ok(isShortcutAction('toggleMute'));
    assert.ok(isShortcutAction('sound:fbi-open-up-491'));
    assert.ok(!isShortcutAction('sound:'));
    assert.ok(!isShortcutAction('sound:../x'));
    assert.ok(!isShortcutAction('quit'));
    assert.equal(shortcutSound('sound:bruh'), 'bruh');
    assert.equal(shortcutSound('pushToTalk'), null);
  });

  test('labels read as keys do', () => {
    const names = new Map([
      [29, 'Ctrl'],
      [50, 'M'],
      [3613, 'CtrlRight'],
    ]);
    assert.equal(bindingLabel([CTRL, M], names), 'Ctrl + M');
    assert.equal(bindingLabel([MOUSE4], names), 'Mouse 4');
    assert.equal(keyName('CtrlRight'), 'Right Ctrl');
    assert.equal(keyName('NumpadAdd'), 'Numpad Add');
  });
});
