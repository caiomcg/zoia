/**
 * An admin renaming someone. The server decides whether they may and whether
 * the name is free; the dialog only skips asking for nothing, and keeps to
 * the server's length so the field never takes a name that will be refused.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_NAME_LENGTH, nameToSend, renameError } from '../src/renderer/rename.ts';
import { MAX_NAME_LENGTH as SERVER_MAX } from '../../server/src/names.js';
import { format } from '../src/shared/i18n/core.ts';
import { en, type MessageKey } from '../src/shared/i18n/en.ts';

const t = (key: MessageKey, vars?: Record<string, string | number>) => format(en[key], vars);

describe('renaming someone', () => {
  test('the field is as long as the server allows, no longer', () => {
    assert.equal(MAX_NAME_LENGTH, SERVER_MAX);
  });

  test('sends the trimmed name, and nothing for an empty or unchanged one', () => {
    assert.equal(nameToSend('  Robert ', 'Bob'), 'Robert');
    assert.equal(nameToSend('   ', 'Bob'), null);
    assert.equal(nameToSend(' Bob ', 'Bob'), null);
    // Recasing is a change: the server lets someone keep their own name recased.
    assert.equal(nameToSend('BOB', 'Bob'), 'BOB');
  });

  test('a taken name says so; anything else names its code', () => {
    assert.equal(renameError(t, 'name_taken'), en['profile.nameTaken']);
    assert.equal(renameError(t, 'forbidden'), 'That did not work (forbidden).');
  });
});
