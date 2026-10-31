/**
 * Whether Zoia runs as administrator, where Windows refuses window capture,
 * and the script that reopens it unelevated (src/main/elevation.ts).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isElevatedGroups, unelevatedRestartScript } from '../src/main/elevation.ts';

describe('isElevatedGroups', () => {
  test('a High or System mandatory level is elevated', () => {
    assert.equal(
      isElevatedGroups('Mandatory Label\\High Mandatory Level  Label  S-1-16-12288'),
      true,
    );
    assert.equal(
      isElevatedGroups('Mandatory Label\\System Mandatory Level  Label  S-1-16-16384'),
      true,
    );
  });

  test('a Medium level, or no answer, is not', () => {
    assert.equal(
      isElevatedGroups('Mandatory Label\\Medium Mandatory Level  Label  S-1-16-8192'),
      false,
    );
    assert.equal(isElevatedGroups(''), false);
    // A longer SID that only starts like one is not it.
    assert.equal(isElevatedGroups('S-1-16-122880'), false);
  });
});

describe('unelevatedRestartScript', () => {
  test('waits for this Zoia, then opens it through Explorer', () => {
    const script = unelevatedRestartScript(4242, 'C:\\Program Files\\Zoia\\Zoia.exe');
    assert.match(script, /^Wait-Process -Id 4242 /);
    assert.match(
      script,
      /Start-Process -FilePath explorer\.exe -ArgumentList '"C:\\Program Files\\Zoia\\Zoia\.exe"'$/,
    );
  });

  test('a quote in the path cannot end the argument early', () => {
    const script = unelevatedRestartScript(1, "C:\\Users\\O'Brien\\Zoia.exe");
    assert.match(script, /O''Brien/);
  });
});
