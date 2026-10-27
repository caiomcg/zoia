/**
 * The name offered when saving a chat photo or video: the one it was sent
 * with when it is safe, else one from its id, always with an extension.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { saveName } from '../src/main/media-name.ts';

describe('saveName', () => {
  test('keeps the name it was sent with', () => {
    assert.equal(
      saveName('férias na praia.jpg', 'aaaaaaaaaaaaaaaa', 'image/jpeg'),
      'férias na praia.jpg',
    );
  });

  test('adds the extension its type has when the name has none', () => {
    assert.equal(saveName('print', 'aaaaaaaaaaaaaaaa', 'image/png'), 'print.png');
  });

  test('without a name, names it from its id', () => {
    assert.equal(saveName(null, 'aaaaaaaaaaaaaaaa', 'video/mp4'), 'zoia-aaaaaaaaaaaaaaaa.mp4');
    assert.equal(saveName('  ', 'aaaaaaaaaaaaaaaa', 'image/gif'), 'zoia-aaaaaaaaaaaaaaaa.gif');
  });

  test('never leaves a path or a character a file system refuses', () => {
    assert.equal(
      saveName('../../etc/passwd', 'aaaaaaaaaaaaaaaa', 'image/png'),
      '_.._etc_passwd.png',
    );
    assert.equal(saveName('a:b*c?.png', 'aaaaaaaaaaaaaaaa', 'image/png'), 'a_b_c_.png');
  });
});
