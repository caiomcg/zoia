/**
 * Smart App Control can refuse a native module outright. The app has to open
 * anyway, with that module's feature off.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { optionalModule } from '../src/main/optional-module.ts';

describe('optionalModule', () => {
  test('a module that loads is loaded once and reused', () => {
    let calls = 0;
    const module = { name: 'window manager' };
    const get = optionalModule('wm', () => {
      calls += 1;
      return module;
    });
    assert.equal(get(), module);
    assert.equal(get(), module);
    assert.equal(calls, 1);
  });

  test('a blocked module is null, not a crash, and is warned about once', () => {
    let calls = 0;
    const warnings: string[] = [];
    const get = optionalModule(
      'wm',
      () => {
        calls += 1;
        throw new Error('An Application Control policy has blocked this file.');
      },
      (message) => warnings.push(message),
    );
    assert.equal(get(), null);
    assert.equal(get(), null);
    assert.equal(calls, 1);
    assert.deepEqual(warnings, [
      '[wm] unavailable: An Application Control policy has blocked this file.',
    ]);
  });
});
