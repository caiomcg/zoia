/**
 * Finding links in messages: what becomes clickable, where it ends, and
 * that nothing but a web address ever does.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { splitLinks } from '../src/renderer/chat/links.ts';

describe('splitLinks', () => {
  test('finds web addresses among the words', () => {
    assert.deepEqual(splitLinks('olha https://example.com/a?b=1 e www.zoia.im ok'), [
      { text: 'olha ' },
      { text: 'https://example.com/a?b=1', href: 'https://example.com/a?b=1' },
      { text: ' e ' },
      { text: 'www.zoia.im', href: 'https://www.zoia.im/' },
      { text: ' ok' },
    ]);
  });

  test('leaves the punctuation that ends a sentence out', () => {
    assert.deepEqual(splitLinks('see https://example.com/x.'), [
      { text: 'see ' },
      { text: 'https://example.com/x', href: 'https://example.com/x' },
      { text: '.' },
    ]);
    assert.equal(splitLinks('(https://example.com/a)')[1]?.text, 'https://example.com/a');
  });

  test('keeps a bracket the address opened itself', () => {
    const wiki = 'https://en.wikipedia.org/wiki/Zoia_(film)';
    assert.equal(splitLinks(`${wiki}!`)[0]?.href, wiki);
  });

  test('nothing but http and https is a link', () => {
    for (const text of [
      'javascript:alert(1)',
      'file:///c:/x',
      'ftp://example.com',
      'http://intranet/',
    ]) {
      assert.deepEqual(splitLinks(text), [{ text }], text);
    }
  });

  test('plain text is one part, and an empty message none', () => {
    assert.deepEqual(splitLinks('só texto'), [{ text: 'só texto' }]);
    assert.deepEqual(splitLinks(''), []);
  });
});
