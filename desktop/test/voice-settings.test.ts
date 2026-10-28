/**
 * Voice settings are read back from storage on every start, and an
 * unreadable one must still give a working microphone (ADR 0039).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  captureOptions,
  AUTO_MARGIN_DB,
  AUTO_MAX_DB,
  AUTO_MIN_DB,
  dbFraction,
  levelToDb,
  NoiseFloor,
  parseVoiceSettings,
  SENSITIVITY_MIN,
} from '../src/renderer/voice/settings.ts';

describe('parseVoiceSettings', () => {
  test('nothing stored gives the defaults: RNNoise, echo cancellation and gain on, no gate', () => {
    assert.deepEqual(parseVoiceSettings(null, null), {
      microphoneId: '',
      noiseSuppression: 'enhanced',
      echoCancellation: true,
      autoGainControl: true,
      sensitivity: SENSITIVITY_MIN,
      autoSensitivity: true,
      inputMode: 'voiceActivity',
    });
  });

  test('the microphone comes from the key the camera shares', () => {
    assert.equal(parseVoiceSettings(null, 'usb-mic').microphoneId, 'usb-mic');
  });

  test('what was chosen is kept', () => {
    const stored = JSON.stringify({
      noiseSuppression: 'off',
      echoCancellation: false,
      autoGainControl: false,
      sensitivity: -40,
      autoSensitivity: false,
      inputMode: 'pushToTalk',
    });
    assert.deepEqual(parseVoiceSettings(stored, ''), {
      microphoneId: '',
      noiseSuppression: 'off',
      echoCancellation: false,
      autoGainControl: false,
      sensitivity: -40,
      autoSensitivity: false,
      inputMode: 'pushToTalk',
    });
  });

  test('a sensitivity off the slider is brought back onto it', () => {
    const at = (sensitivity: unknown) =>
      parseVoiceSettings(JSON.stringify({ sensitivity }), null).sensitivity;
    assert.equal(at(12), 0);
    assert.equal(at(-500), SENSITIVITY_MIN);
    assert.equal(at('loud'), SENSITIVITY_MIN);
  });

  test('garbage and unknown values fall back, one field at a time', () => {
    assert.equal(parseVoiceSettings('not json', null).noiseSuppression, 'enhanced');
    const odd = parseVoiceSettings(
      JSON.stringify({
        noiseSuppression: 'krisp',
        echoCancellation: 'yes',
        autoGainControl: false,
      }),
      null,
    );
    assert.equal(odd.noiseSuppression, 'enhanced');
    assert.equal(odd.echoCancellation, true);
    assert.equal(odd.autoGainControl, false);
  });
});

describe('captureOptions', () => {
  test('asks for mono, with exactly the chosen microphone', () => {
    const options = captureOptions(parseVoiceSettings(null, 'usb-mic'));
    assert.deepEqual(options.deviceId, { exact: 'usb-mic' });
    assert.equal(options.channelCount, 1);
  });

  test('no choice leaves the device to the system', () => {
    assert.equal(captureOptions(parseVoiceSettings(null, '')).deviceId, undefined);
  });

  test('only Standard asks Chromium to suppress: Enhanced replaces it, not stacks on it', () => {
    const chromium = (noiseSuppression: string) =>
      captureOptions(parseVoiceSettings(JSON.stringify({ noiseSuppression }), null))
        .noiseSuppression;
    assert.equal(chromium('off'), false);
    assert.equal(chromium('standard'), true);
    assert.equal(chromium('enhanced'), false);
  });
});

describe('the sensitivity scale', () => {
  test('a full-scale peak is 0 dB, the top of the slider', () => {
    assert.equal(levelToDb(1), 0);
    assert.equal(dbFraction(0), 1);
  });

  test('silence sits at the quiet end, not at minus infinity', () => {
    assert.equal(levelToDb(0), SENSITIVITY_MIN);
    assert.equal(dbFraction(levelToDb(0)), 0);
  });

  test('half the amplitude is about 6 dB down', () => {
    assert.ok(Math.abs(levelToDb(0.5) + 6.02) < 0.01);
  });
});

describe('automatic sensitivity', () => {
  /** Feeds `db` every 10 ms for `seconds`, as the gate does; returns the threshold. */
  function hold(floor: NoiseFloor, db: number, seconds: number, from = 0): number {
    let threshold = floor.threshold;
    for (let ms = from; ms <= from + seconds * 1000; ms += 10) threshold = floor.update(db, ms);
    return threshold;
  }

  test('settles a margin above a steady room', () => {
    const floor = new NoiseFloor();
    assert.ok(Math.abs(hold(floor, -45, 30) - (-45 + AUTO_MARGIN_DB)) < 0.5);
  });

  test('a sentence does not drag the threshold up to the voice', () => {
    const floor = new NoiseFloor();
    const quiet = hold(floor, -50, 30);
    const talking = hold(floor, -20, 3, 30_000);
    assert.ok(talking - quiet < 6, `rose ${talking - quiet} dB in 3 s of talking`);
    assert.ok(talking < -20, 'the voice stays above it');
  });

  test('a quieter room brings it back down within a pause', () => {
    const floor = new NoiseFloor();
    hold(floor, -35, 30);
    assert.ok(hold(floor, -55, 0.5, 30_000) <= -55 + AUTO_MARGIN_DB + 1);
  });

  test('stays inside its range, however loud or silent the room', () => {
    assert.equal(hold(new NoiseFloor(), -5, 60), AUTO_MAX_DB);
    assert.equal(hold(new NoiseFloor(), -90, 60), AUTO_MIN_DB);
  });
});
