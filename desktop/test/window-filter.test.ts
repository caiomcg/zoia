/**
 * The share picker offered windows nobody could see: tray apps minimized
 * off-screen and tiny helper windows. These are the shapes they arrive in.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isShareableWindow } from '../src/main/window-filter.ts';

describe('isShareableWindow', () => {
  test('an ordinary window on a monitor is shareable', () => {
    assert.equal(isShareableWindow({ x: 640, y: 120, width: 1280, height: 820 }), true);
  });

  test('a window partly off the left edge still is', () => {
    assert.equal(isShareableWindow({ x: -7, y: -7, width: 2575, height: 1407 }), true);
  });

  test('a minimized window, parked off-screen, is not', () => {
    // Discord minimized to the tray on a 175% display.
    assert.equal(isShareableWindow({ x: -17920, y: -17920, width: 135, height: 22 }), false);
    assert.equal(isShareableWindow({ x: -32000, y: -32000, width: 160, height: 28 }), false);
  });

  test('tiny helper windows are not', () => {
    assert.equal(isShareableWindow({ x: 0, y: 0, width: 1, height: 1 }), false);
    assert.equal(isShareableWindow({ x: 76, y: 0, width: 0, height: 0 }), false);
  });

  test('no bounds at all is not', () => {
    assert.equal(isShareableWindow(null), false);
  });
});
