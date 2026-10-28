/**
 * Voice settings are read back from storage on every start, and an
 * unreadable one must still give a working microphone (ADR 0039).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { captureOptions, parseVoiceSettings } from '../src/renderer/voice/settings.ts';

describe('parseVoiceSettings', () => {
  test('nothing stored gives the defaults: suppression, echo cancellation and gain on', () => {
    assert.deepEqual(parseVoiceSettings(null, null), {
      microphoneId: '',
      noiseSuppression: 'standard',
      echoCancellation: true,
      autoGainControl: true,
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
    });
    assert.deepEqual(parseVoiceSettings(stored, ''), {
      microphoneId: '',
      noiseSuppression: 'off',
      echoCancellation: false,
      autoGainControl: false,
    });
  });

  test('garbage and unknown values fall back, one field at a time', () => {
    assert.equal(parseVoiceSettings('not json', null).noiseSuppression, 'standard');
    const odd = parseVoiceSettings(
      JSON.stringify({
        noiseSuppression: 'krisp',
        echoCancellation: 'yes',
        autoGainControl: false,
      }),
      null,
    );
    assert.equal(odd.noiseSuppression, 'standard');
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

  test('suppression off turns off Chromium suppression', () => {
    const settings = parseVoiceSettings(JSON.stringify({ noiseSuppression: 'off' }), null);
    assert.equal(captureOptions(settings).noiseSuppression, false);
  });
});
