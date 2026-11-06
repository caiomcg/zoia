import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isGifMessage } from '../src/renderer/chat/gif.ts';

describe('isGifMessage', () => {
  test('a lone KLIPY address is a GIF', () => {
    assert.equal(isGifMessage('https://static.klipy.com/ii/abc/hello.gif'), true);
    assert.equal(isGifMessage('  https://static.klipy.com/a.webp  '), true);
  });

  test('anything else is text', () => {
    assert.equal(isGifMessage('look https://static.klipy.com/a.gif'), false);
    assert.equal(isGifMessage('https://klipy.com.evil.example/a.gif'), false);
    assert.equal(isGifMessage('http://static.klipy.com/a.gif'), false);
    assert.equal(isGifMessage('https://media.giphy.com/a.gif'), false);
    assert.equal(isGifMessage(''), false);
    assert.equal(isGifMessage(null), false);
  });
});
