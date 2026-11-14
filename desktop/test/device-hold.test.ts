/**
 * Plugging in a headset mid-call must not move the call to it unasked, but a
 * device that is unplugged must still be replaced at once: the difference is
 * all in newDefault.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultDevice,
  deviceToUse,
  newDefault,
  type Listed,
} from '../src/renderer/voice/device-hold.ts';

const speakers: Listed = {
  kind: 'audiooutput',
  deviceId: 'spk',
  groupId: 'g-spk',
  label: 'Speakers',
};
const mic: Listed = { kind: 'audioinput', deviceId: 'mic', groupId: 'g-mic', label: 'Webcam mic' };
const headsetOut: Listed = {
  kind: 'audiooutput',
  deviceId: 'hs-out',
  groupId: 'g-hs',
  label: 'Headset',
};
const headsetIn: Listed = {
  kind: 'audioinput',
  deviceId: 'hs-in',
  groupId: 'g-hs',
  label: 'Headset',
};

/** Chromium's 'default' entry for a kind, pointing at a device by its group. */
function defaultTo(device: Listed): Listed {
  return { ...device, deviceId: 'default', label: `Default - ${device.label}` };
}

describe('the system default', () => {
  test('is the real device sharing the default entry’s group', () => {
    assert.equal(defaultDevice([defaultTo(speakers), speakers], 'audiooutput'), speakers);
  });

  test('is unknown without a default entry', () => {
    assert.equal(defaultDevice([speakers], 'audiooutput'), null);
  });
});

describe('a default that moves', () => {
  const before = [defaultTo(speakers), speakers, defaultTo(mic), mic];

  test('onto a headset just plugged in is held off, for both its parts', () => {
    const after = [
      defaultTo(headsetOut),
      speakers,
      headsetOut,
      defaultTo(headsetIn),
      mic,
      headsetIn,
    ];
    assert.deepEqual(newDefault(before, after, 'audiooutput'), { from: speakers, to: headsetOut });
    assert.deepEqual(newDefault(before, after, 'audioinput'), { from: mic, to: headsetIn });
  });

  test('because the device in use was unplugged is followed: nothing to keep', () => {
    const was = [defaultTo(headsetOut), speakers, headsetOut];
    const after = [defaultTo(speakers), speakers];
    assert.equal(newDefault(was, after, 'audiooutput'), null);
  });

  test('onto a device that was already there is the person’s own doing in Windows', () => {
    const was = [defaultTo(speakers), speakers, headsetOut];
    const after = [defaultTo(headsetOut), speakers, headsetOut];
    assert.equal(newDefault(was, after, 'audiooutput'), null);
  });

  test('on the first listing is nothing: there was no before', () => {
    assert.equal(newDefault(null, before, 'audiooutput'), null);
  });

  test('that did not move is nothing, whatever else was plugged in', () => {
    const after = [...before, headsetOut];
    assert.equal(newDefault(before, after, 'audiooutput'), null);
  });
});

describe('the device to use', () => {
  const devices = [defaultTo(headsetOut), speakers, headsetOut];

  test('is the chosen one while it is plugged in, whatever is held', () => {
    assert.equal(deviceToUse('hs-out', 'spk', devices, 'audiooutput'), 'hs-out');
  });

  test('is the default when the chosen one is unplugged', () => {
    assert.equal(deviceToUse('gone', 'spk', devices, 'audiooutput'), '');
  });

  test('is the held one when following the default', () => {
    assert.equal(deviceToUse('', 'spk', devices, 'audiooutput'), 'spk');
  });

  test('is the default when nothing is held, or the held one is gone', () => {
    assert.equal(deviceToUse('', '', devices, 'audiooutput'), '');
    assert.equal(deviceToUse('', 'gone', devices, 'audiooutput'), '');
  });

  test('only counts devices of its own kind', () => {
    assert.equal(deviceToUse('', 'hs-in', devices, 'audiooutput'), '');
  });
});
