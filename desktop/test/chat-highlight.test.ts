/** The message box: which @mentions and !command are accented while writing. */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { composerHighlights, splitHighlights } from '../src/renderer/chat/highlight.ts';

const people = [{ name: 'Ana' }, { name: 'Ana Paula' }, { name: 'Bia Souza' }];
const commands = [{ name: 'play' }, { name: 'skip' }];

const marked = (text: string, who = people, what = commands) =>
  composerHighlights(text, who, what).map((h) => [text.slice(h.start, h.end), h.kind]);

describe('mentions', () => {
  test('accents a known name after an @', () => {
    assert.deepEqual(marked('oi @Bia Souza, tudo bem?'), [['@Bia Souza', 'mention']]);
  });

  test('takes the longer name first', () => {
    assert.deepEqual(marked('@Ana Paula e @Ana'), [
      ['@Ana Paula', 'mention'],
      ['@Ana', 'mention'],
    ]);
  });

  test('leaves an unknown name, a bare @ and an email plain', () => {
    assert.deepEqual(marked('@Carla @ ana@Ana.com'), []);
  });

  test('does not accent a name that is only the start of a longer word', () => {
    assert.deepEqual(marked('@Anabela'), []);
    assert.deepEqual(marked('@Ana2'), []);
  });

  test('ends at punctuation, a line break or the end of the text', () => {
    assert.deepEqual(marked('@Ana!\n@Ana'), [
      ['@Ana', 'mention'],
      ['@Ana', 'mention'],
    ]);
  });

  test('is case-sensitive, as sending a mention is', () => {
    assert.deepEqual(marked('@ana'), []);
  });

  test('accents nobody when nobody is known', () => {
    assert.deepEqual(marked('@Ana', []), []);
  });
});

describe('commands', () => {
  test('accents a command of this chat that starts the message', () => {
    assert.deepEqual(marked('!play never gonna'), [['!play', 'command']]);
    assert.deepEqual(marked('!skip'), [['!skip', 'command']]);
  });

  test('ignores case and leading space, as the server does', () => {
    assert.deepEqual(marked('  !PLAY x'), [['!PLAY', 'command']]);
  });

  test('leaves an unknown command, a partial one and a ! later on plain', () => {
    assert.deepEqual(marked('!pla'), []);
    assert.deepEqual(marked('!playlist'), []);
    assert.deepEqual(marked('oi !play'), []);
    assert.deepEqual(marked('!play', people, []), []);
  });

  test('accents mentions in its arguments too', () => {
    assert.deepEqual(marked('!play @Ana'), [
      ['!play', 'command'],
      ['@Ana', 'mention'],
    ]);
  });
});

describe('splitting the text', () => {
  test('keeps every character, in order, in exactly one part', () => {
    const text = '!play for @Ana Paula!';
    const parts = splitHighlights(text, composerHighlights(text, people, commands));
    assert.deepEqual(parts, [
      { text: '!play', kind: 'command' },
      { text: ' for ' },
      { text: '@Ana Paula', kind: 'mention' },
      { text: '!' },
    ]);
    assert.equal(parts.map((p) => p.text).join(''), text);
  });

  test('is the whole text when nothing is accented', () => {
    assert.deepEqual(splitHighlights('oi', []), [{ text: 'oi' }]);
    assert.deepEqual(splitHighlights('', []), []);
  });
});
