/**
 * Release notes come from the network. What matters most is that nothing in
 * them becomes markup or a script link; the rest is legibility.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseInline, parseMarkdown } from '../src/renderer/markdown.ts';

describe('parseMarkdown', () => {
  test('headings, lists and paragraphs', () => {
    const blocks = parseMarkdown('### Fixed\n\n- One\n- Two\n\nA line\nwrapped.');
    assert.deepEqual(
      blocks.map((block) => block.kind),
      ['heading', 'list', 'paragraph'],
    );
    assert.equal(blocks[1].kind === 'list' && blocks[1].items.length, 2);
    assert.deepEqual(blocks[2], {
      kind: 'paragraph',
      children: [{ kind: 'text', text: 'A line wrapped.' }],
    });
  });

  test("reads GitHub's generated notes, which use * bullets", () => {
    const blocks = parseMarkdown(
      "## What's Changed\n* Fix by @someone in https://github.com/o/r/pull/1",
    );
    assert.equal(blocks[1].kind, 'list');
  });
});

describe('parseInline', () => {
  test('bold, code and links', () => {
    assert.deepEqual(parseInline('**server:** Free `seat` ([abc](https://github.com/x))'), [
      { kind: 'bold', children: [{ kind: 'text', text: 'server:' }] },
      { kind: 'text', text: ' Free ' },
      { kind: 'code', text: 'seat' },
      { kind: 'text', text: ' (' },
      { kind: 'link', href: 'https://github.com/x', children: [{ kind: 'text', text: 'abc' }] },
      { kind: 'text', text: ')' },
    ]);
  });

  test('a bare URL becomes a link', () => {
    const [, link] = parseInline('See https://github.com/o/r/compare/a...b');
    assert.equal(link.kind === 'link' && link.href, 'https://github.com/o/r/compare/a...b');
  });

  test('a script link is shown as text, not followed', () => {
    assert.deepEqual(parseInline('[click](javascript:alert(1))'), [
      { kind: 'text', text: 'click' },
      { kind: 'text', text: ')' },
    ]);
  });

  test('markup stays text', () => {
    assert.deepEqual(parseInline('<img src=x onerror=alert(1)>'), [
      { kind: 'text', text: '<img src=x onerror=alert(1)>' },
    ]);
  });
});
