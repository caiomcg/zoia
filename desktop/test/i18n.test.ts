/**
 * Three languages kept in step by hand. The type checker already refuses a
 * missing key; these catch what it cannot: a placeholder dropped or misspelt
 * in a translation, which would show up as a raw {name} on someone's screen.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { format, resolveLanguage, isLanguagePreference } from '../src/shared/i18n/core.ts';
import { en } from '../src/shared/i18n/en.ts';
import { es } from '../src/shared/i18n/es.ts';
import { pt } from '../src/shared/i18n/pt.ts';

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('resolveLanguage', () => {
  test('an explicit choice wins over the OS', () => {
    assert.equal(resolveLanguage('es', ['pt-BR']), 'es');
  });

  test('system follows the first OS locale Zoia speaks, by its primary subtag', () => {
    assert.equal(resolveLanguage('system', ['pt-BR', 'en-US']), 'pt');
    assert.equal(resolveLanguage('system', ['es-419']), 'es');
    assert.equal(resolveLanguage('system', ['fr-FR', 'es_MX']), 'es');
  });

  test('falls back to English when nothing matches', () => {
    assert.equal(resolveLanguage('system', ['fr-FR', 'de']), 'en');
    assert.equal(resolveLanguage('system', []), 'en');
  });
});

describe('isLanguagePreference', () => {
  test('accepts the known choices and nothing else', () => {
    for (const value of ['system', 'en', 'es', 'pt'])
      assert.equal(isLanguagePreference(value), true);
    for (const value of ['fr', '', null, 3]) assert.equal(isLanguagePreference(value), false);
  });
});

describe('format', () => {
  test('fills placeholders and leaves unknown ones as written', () => {
    assert.equal(format('Hi {name}, {n} new', { name: 'Ana', n: 2 }), 'Hi Ana, 2 new');
    assert.equal(format('Click {button} at the top.'), 'Click {button} at the top.');
  });
});

describe('translations', () => {
  for (const [name, messages] of [
    ['es', es],
    ['pt', pt],
  ] as const) {
    test(`${name} has exactly the English keys`, () => {
      assert.deepEqual(Object.keys(messages).sort(), Object.keys(en).sort());
    });

    test(`${name} keeps every placeholder`, () => {
      for (const key of Object.keys(en) as (keyof typeof en)[]) {
        assert.deepEqual(placeholders(messages[key]), placeholders(en[key]), key);
      }
    });

    test(`${name} has no empty strings`, () => {
      for (const [key, value] of Object.entries(messages)) assert.ok(value.trim(), key);
    });
  }
});
