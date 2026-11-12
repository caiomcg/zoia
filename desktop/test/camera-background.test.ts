/**
 * The camera's background is read from storage every time the camera starts,
 * so whatever is stored there, the camera must still start: a choice this
 * version does not know is no effect, never an error (ADR 0053).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  BLUR_RADIUS,
  CUSTOM_IMAGE,
  NO_BACKGROUND,
  PRESETS,
  fitWithin,
  parseBackground,
  sameBackground,
  serializeBackground,
  type CameraBackground,
} from '../src/renderer/livekit/camera-background.ts';

describe('the remembered background', () => {
  test('every choice survives being stored and read back', () => {
    const choices: CameraBackground[] = [
      NO_BACKGROUND,
      { kind: 'blur', strength: 'light' },
      { kind: 'blur', strength: 'strong' },
      { kind: 'image', image: CUSTOM_IMAGE },
      ...PRESETS.map((p) => ({ kind: 'image' as const, image: p.id })),
    ];
    for (const choice of choices) {
      assert.deepEqual(parseBackground(serializeBackground(choice)), choice);
    }
  });

  test('nothing stored, or anything unreadable, is no effect', () => {
    for (const raw of [null, undefined, '', 'not json', '42', 'null', '[]', '{}']) {
      assert.deepEqual(parseBackground(raw), NO_BACKGROUND, String(raw));
    }
  });

  test('a strength or a picture this version does not have is no effect', () => {
    assert.deepEqual(parseBackground('{"kind":"blur","strength":"extreme"}'), NO_BACKGROUND);
    assert.deepEqual(parseBackground('{"kind":"image","image":"removed-preset"}'), NO_BACKGROUND);
    assert.deepEqual(parseBackground('{"kind":"image","image":7}'), NO_BACKGROUND);
  });

  test('extra fields are dropped, not carried along', () => {
    assert.deepEqual(parseBackground('{"kind":"blur","strength":"light","radius":999}'), {
      kind: 'blur',
      strength: 'light',
    });
  });

  test('two choices are the same only when they would look the same', () => {
    assert.ok(
      sameBackground({ kind: 'blur', strength: 'light' }, { kind: 'blur', strength: 'light' }),
    );
    assert.ok(
      !sameBackground({ kind: 'blur', strength: 'light' }, { kind: 'blur', strength: 'strong' }),
    );
    assert.ok(!sameBackground(NO_BACKGROUND, { kind: 'image', image: 'dusk' }));
  });

  test('a strong blur is stronger than a light one', () => {
    assert.ok(BLUR_RADIUS.strong > BLUR_RADIUS.light);
  });
});

describe('an uploaded picture', () => {
  test('is scaled to fit 1280×720, keeping its shape', () => {
    assert.deepEqual(fitWithin(3840, 2160), { width: 1280, height: 720 });
    assert.deepEqual(fitWithin(4000, 3000), { width: 960, height: 720 });
    assert.deepEqual(fitWithin(3000, 1000), { width: 1280, height: 427 });
  });

  test('is never enlarged', () => {
    assert.deepEqual(fitWithin(640, 480), { width: 640, height: 480 });
  });

  test('with no size has none', () => {
    assert.deepEqual(fitWithin(0, 480), { width: 0, height: 0 });
  });
});
