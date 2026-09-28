/**
 * The notes open by themselves exactly once per update. Too often and they
 * are a nag; never, and nobody learns what changed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldShowReleaseNotes } from '../src/renderer/whats-new.ts';

test('after an update, once', () => {
  assert.equal(shouldShowReleaseNotes('0.3.16', '0.3.17', true), true);
  assert.equal(shouldShowReleaseNotes('0.3.17', '0.3.17', true), false);
});

test('a fresh install has nothing to catch up on', () => {
  assert.equal(shouldShowReleaseNotes(null, '0.3.17', false), false);
});

test('an update from before the version was recorded still counts', () => {
  assert.equal(shouldShowReleaseNotes(null, '0.3.17', true), true);
});
