/**
 * Away after the machine goes untouched (ADR 0038): the server is told on a
 * change only, at once on a locked screen, and again after a reconnect.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createIdleWatch } from '../src/main/idle-watch.ts';

function watch() {
  const state = { idleMs: 0, told: [] as boolean[] };
  const idle = createIdleWatch({
    idleMs: () => state.idleMs,
    report: async (value) => void state.told.push(value),
    thresholdMs: 1_000,
    // Checks are made by hand here, through setLocked and start.
    checkMs: 1_000_000,
  });
  return { state, idle };
}

describe('the idle watch', () => {
  test('says nothing while the machine is in use', () => {
    const { state, idle } = watch();
    idle.start();
    idle.connected();
    assert.deepEqual(state.told, []);
    idle.stop();
  });

  test('says idle once past the threshold, and back when used', () => {
    const { state, idle } = watch();
    state.idleMs = 2_000;
    idle.start();
    assert.deepEqual(state.told, [true]);
    idle.setLocked(false);
    assert.deepEqual(state.told, [true], 'no change, nothing said');
    state.idleMs = 0;
    idle.setLocked(false);
    assert.deepEqual(state.told, [true, false]);
    idle.stop();
  });

  test('a locked screen is idle at once', () => {
    const { state, idle } = watch();
    idle.start();
    idle.setLocked(true);
    assert.deepEqual(state.told, [true]);
    idle.setLocked(false);
    assert.deepEqual(state.told, [true, false]);
    idle.stop();
  });

  test('tells the server again after a reconnect, only while idle', () => {
    const { state, idle } = watch();
    state.idleMs = 2_000;
    idle.start();
    idle.connected();
    assert.deepEqual(state.told, [true, true]);
    idle.stop();
    idle.connected();
    assert.deepEqual(state.told, [true, true], 'stopped, it says nothing');
  });
});
