/**
 * The emoji beside the message box: where one goes in what is being
 * written, and which were used last.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EMOJI_GROUPS, insertText, pushRecent } from '../src/renderer/chat/emoji.ts';

describe('insertText', () => {
  test('goes at the caret, which moves past it', () => {
    assert.deepEqual(insertText('oi tudo', '👋', 2, 2, 100), { text: 'oi👋 tudo', caret: 4 });
  });

  test('replaces what is selected', () => {
    assert.deepEqual(insertText('bom dia', '☀️', 4, 7, 100), { text: 'bom ☀️', caret: 6 });
  });

  test('not when the message would be too long', () => {
    assert.equal(insertText('abc', '🎉', 3, 3, 4), null);
  });
});

describe('pushRecent', () => {
  test('the newest first, each once, up to the most kept', () => {
    assert.deepEqual(pushRecent(['😂', '👍'], '👍'), ['👍', '😂']);
    assert.deepEqual(pushRecent(['a', 'b', 'c'], 'd', 3), ['d', 'a', 'b']);
  });
});

describe('EMOJI_GROUPS', () => {
  test('no emoji twice in a group, and none empty', () => {
    for (const group of EMOJI_GROUPS) {
      assert.equal(new Set(group.emoji).size, group.emoji.length, group.id);
      assert.ok(
        group.emoji.every((e) => e.length > 0),
        group.id,
      );
    }
  });
});
