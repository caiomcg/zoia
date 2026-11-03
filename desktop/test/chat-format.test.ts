/**
 * Formatting in chat messages, as Discord writes it: what each marker does,
 * how they nest, and what is left as written.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseExcerpt,
  parseInline,
  parseMessage,
  shortcutMarker,
  toggleMarker,
  type Inline,
} from '../src/renderer/chat/format.ts';

const text = (t: string): Inline => ({ kind: 'text', text: t });

describe('parseInline', () => {
  test('bold, italic, underline, strikethrough and spoilers', () => {
    assert.deepEqual(parseInline('a **b** c'), [
      text('a '),
      { kind: 'bold', children: [text('b')] },
      text(' c'),
    ]);
    assert.deepEqual(parseInline('*i*'), [{ kind: 'italic', children: [text('i')] }]);
    assert.deepEqual(parseInline('_i_'), [{ kind: 'italic', children: [text('i')] }]);
    assert.deepEqual(parseInline('__u__'), [{ kind: 'underline', children: [text('u')] }]);
    assert.deepEqual(parseInline('~~s~~'), [{ kind: 'strike', children: [text('s')] }]);
    assert.deepEqual(parseInline('||x||'), [{ kind: 'spoiler', children: [text('x')] }]);
  });

  test('nests: three stars are bold around italics', () => {
    assert.deepEqual(parseInline('***both***'), [
      { kind: 'bold', children: [{ kind: 'italic', children: [text('both')] }] },
    ]);
    assert.deepEqual(parseInline('__*ui*__'), [
      { kind: 'underline', children: [{ kind: 'italic', children: [text('ui')] }] },
    ]);
    assert.deepEqual(parseInline('*a **b** c*'), [
      {
        kind: 'italic',
        children: [text('a '), { kind: 'bold', children: [text('b')] }, text(' c')],
      },
    ]);
    assert.deepEqual(parseInline('~~**x**~~'), [
      { kind: 'strike', children: [{ kind: 'bold', children: [text('x')] }] },
    ]);
  });

  test('bold spans words with spaces and line breaks', () => {
    assert.deepEqual(parseInline('**um dois\ntrês**'), [
      { kind: 'bold', children: [text('um dois\ntrês')] },
    ]);
  });

  test('leaves unmatched and loose markers as written', () => {
    assert.deepEqual(parseInline('**sem fim'), [text('**sem fim')]);
    assert.deepEqual(parseInline('2 * 3 * 4'), [text('2 * 3 * 4')]);
    assert.deepEqual(parseInline('snake_case_name'), [text('snake_case_name')]);
    assert.deepEqual(parseInline('a ~ b | c'), [text('a ~ b | c')]);
    assert.deepEqual(parseInline('****'), [text('****')]);
  });

  test('a backslash keeps a marker as written', () => {
    assert.deepEqual(parseInline('\\*not\\*'), [text('*not*')]);
    assert.deepEqual(parseInline('\\*\\*no\\*\\*'), [text('**no**')]);
    assert.deepEqual(parseInline('C:\\Users'), [text('C:\\Users')]);
  });

  test('code is taken as written, formatting and all', () => {
    assert.deepEqual(parseInline('use `**x**` now'), [
      text('use '),
      { kind: 'code', text: '**x**' },
      text(' now'),
    ]);
    assert.deepEqual(parseInline('`` a`b ``'), [{ kind: 'code', text: 'a`b' }]);
    assert.deepEqual(parseInline('**a `*` b**'), [
      { kind: 'bold', children: [text('a '), { kind: 'code', text: '*' }, text(' b')] },
    ]);
  });

  test('addresses are links, and their underscores stay theirs', () => {
    assert.deepEqual(parseInline('_see https://a.com/x_y_z_'), [
      {
        kind: 'italic',
        children: [
          text('see '),
          {
            kind: 'link',
            href: 'https://a.com/x_y_z',
            children: [text('https://a.com/x_y_z')],
          },
        ],
      },
    ]);
    assert.deepEqual(parseInline('**https://a.com**'), [
      {
        kind: 'bold',
        children: [{ kind: 'link', href: 'https://a.com/', children: [text('https://a.com')] }],
      },
    ]);
    assert.deepEqual(parseInline('||https://a.com||'), [
      {
        kind: 'spoiler',
        children: [{ kind: 'link', href: 'https://a.com/', children: [text('https://a.com')] }],
      },
    ]);
  });

  test('masked links go only to the web, and never under a different address', () => {
    assert.deepEqual(parseInline('[o **site**](https://zoia.im/a)'), [
      {
        kind: 'link',
        href: 'https://zoia.im/a',
        children: [text('o '), { kind: 'bold', children: [text('site')] }],
      },
    ]);
    assert.deepEqual(parseInline('[x](javascript:alert(1))'), [text('[x](javascript:alert(1))')]);
    const spoofed = parseInline('[https://bank.com](https://evil.com)');
    assert.ok(
      !spoofed.some(
        (n) =>
          n.kind === 'link' &&
          n.href === 'https://evil.com/' &&
          n.children.some((c) => c.kind === 'text' && c.text.includes('bank')),
      ),
    );
  });

  test('mentions are read whole, inside formatting too', () => {
    const ana = { id: 'a1', name: 'ana_paula' };
    assert.deepEqual(parseInline('oi _@ana_paula_', [ana]), [
      text('oi '),
      { kind: 'italic', children: [{ kind: 'mention', text: '@ana_paula', mention: ana }] },
    ]);
    assert.deepEqual(parseInline('**@ana_paula**', [ana]), [
      { kind: 'bold', children: [{ kind: 'mention', text: '@ana_paula', mention: ana }] },
    ]);
    assert.deepEqual(parseInline('x@ana_paula', [ana]), [text('x@ana_paula')]);
  });
});

describe('parseMessage', () => {
  test('plain lines are one paragraph, line breaks kept', () => {
    assert.deepEqual(parseMessage('a\n\nb'), [{ kind: 'paragraph', children: [text('a\n\nb')] }]);
  });

  test('headings and small text', () => {
    assert.deepEqual(parseMessage('# Um\n## Dois\n### Três\n#### quatro\n-# nota'), [
      { kind: 'heading', level: 1, children: [text('Um')] },
      { kind: 'heading', level: 2, children: [text('Dois')] },
      { kind: 'heading', level: 3, children: [text('Três')] },
      { kind: 'paragraph', children: [text('#### quatro')] },
      { kind: 'subtext', children: [text('nota')] },
    ]);
    assert.deepEqual(parseMessage('#tag'), [{ kind: 'paragraph', children: [text('#tag')] }]);
  });

  test('quotes: a line, consecutive lines, and the rest of the message', () => {
    assert.deepEqual(parseMessage('> a\n> **b**\nc'), [
      {
        kind: 'quote',
        blocks: [
          {
            kind: 'paragraph',
            children: [text('a\n'), { kind: 'bold', children: [text('b')] }],
          },
        ],
      },
      { kind: 'paragraph', children: [text('c')] },
    ]);
    assert.deepEqual(parseMessage('x\n>>> a\nb'), [
      { kind: 'paragraph', children: [text('x')] },
      { kind: 'quote', blocks: [{ kind: 'paragraph', children: [text('a\nb')] }] },
    ]);
    assert.deepEqual(parseMessage('>sem espaço'), [
      { kind: 'paragraph', children: [text('>sem espaço')] },
    ]);
  });

  test('lists, numbered and nested', () => {
    assert.deepEqual(parseMessage('- a\n  - b\n- c\n3. d\n4. e'), [
      {
        kind: 'list',
        ordered: false,
        start: 1,
        items: [
          {
            children: [text('a')],
            lists: [
              {
                kind: 'list',
                ordered: false,
                start: 1,
                items: [{ children: [text('b')], lists: [] }],
              },
            ],
          },
          { children: [text('c')], lists: [] },
        ],
      },
      {
        kind: 'list',
        ordered: true,
        start: 3,
        items: [
          { children: [text('d')], lists: [] },
          { children: [text('e')], lists: [] },
        ],
      },
    ]);
  });

  test('code blocks keep their text, with or without a language', () => {
    assert.deepEqual(parseMessage('antes\n```js\nconst a = **1**;\n```\ndepois'), [
      { kind: 'paragraph', children: [text('antes')] },
      { kind: 'codeBlock', text: 'const a = **1**;', language: 'js' },
      { kind: 'paragraph', children: [text('depois')] },
    ]);
    assert.deepEqual(parseMessage('```só isso```'), [{ kind: 'codeBlock', text: 'só isso' }]);
    assert.deepEqual(parseMessage('```\n# não é título\n> nem citação\n```'), [
      { kind: 'codeBlock', text: '# não é título\n> nem citação' },
    ]);
    assert.deepEqual(parseMessage('```word\n```'), [{ kind: 'codeBlock', text: 'word' }]);
  });

  test('an unclosed fence stays as written', () => {
    assert.equal(parseMessage('```nada')[0]?.kind, 'paragraph');
  });
});

describe('parseExcerpt', () => {
  test('puts every block on one line', () => {
    assert.deepEqual(parseExcerpt('# T\n> **q**'), [
      text('T'),
      text(' '),
      { kind: 'bold', children: [text('q')] },
    ]);
  });
});

describe('toggleMarker', () => {
  test('wraps the selection and keeps it selected', () => {
    assert.deepEqual(toggleMarker('a b c', 2, 3, '**', 100), {
      text: 'a **b** c',
      start: 4,
      end: 5,
    });
  });

  test('with nothing selected, puts the caret between a pair', () => {
    assert.deepEqual(toggleMarker('ab', 1, 1, '*', 100), { text: 'a**b', start: 2, end: 2 });
  });

  test('takes markers off, outside or inside the selection', () => {
    assert.deepEqual(toggleMarker('a **b** c', 4, 5, '**', 100), {
      text: 'a b c',
      start: 2,
      end: 3,
    });
    assert.deepEqual(toggleMarker('a **b** c', 2, 7, '**', 100), {
      text: 'a b c',
      start: 2,
      end: 3,
    });
  });

  test('tells italics from bold in a run of stars', () => {
    // Italics on bold text adds a star rather than taking bold's off.
    assert.deepEqual(toggleMarker('**b**', 2, 3, '*', 100), { text: '***b***', start: 3, end: 4 });
    assert.deepEqual(toggleMarker('***b***', 3, 4, '*', 100), { text: '**b**', start: 2, end: 3 });
    assert.deepEqual(toggleMarker('***b***', 3, 4, '**', 100), { text: '*b*', start: 1, end: 2 });
  });

  test('refuses to go past the limit', () => {
    assert.equal(toggleMarker('abc', 0, 3, '**', 5), null);
  });
});

describe('shortcutMarker', () => {
  const key = (
    k: string,
    extra: Partial<Record<'shiftKey' | 'altKey' | 'metaKey', boolean>> = {},
  ) => ({
    key: k,
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...extra,
  });
  test('Ctrl+B, I, U and Shift+X', () => {
    assert.equal(shortcutMarker(key('b')), '**');
    assert.equal(shortcutMarker(key('I')), '*');
    assert.equal(shortcutMarker(key('u')), '__');
    assert.equal(shortcutMarker(key('X', { shiftKey: true })), '~~');
    assert.equal(shortcutMarker(key('c')), null);
    assert.equal(shortcutMarker(key('b', { altKey: true })), null);
    assert.equal(shortcutMarker({ ...key('b'), ctrlKey: false }), null);
  });
});
