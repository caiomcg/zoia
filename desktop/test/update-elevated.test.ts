/**
 * An update to a Program Files install: the PowerShell that asks for the
 * elevated swap and waits on it, and whether a version already attempted is
 * installed on its own again (src/main/update-elevated.ts).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { askBeforeInstall, elevatedUpdateScript } from '../src/main/update-elevated.ts';

describe('elevatedUpdateScript', () => {
  const script = elevatedUpdateScript({
    pid: 4242,
    runner:
      'C:\\Users\\yure\\AppData\\Roaming\\zoia-desktop\\updates\\v0.14.2\\zoia-update-runner.bat',
    executable: 'C:\\Program Files\\Zoia\\Zoia.exe',
  });

  test('waits for the elevated swap itself, not for a fixed time', () => {
    assert.match(script, /-Verb RunAs -WindowStyle Hidden -Wait/);
    assert.doesNotMatch(script, /Start-Sleep/);
  });

  test('a refused prompt is caught, and Zoia reopens once this one is gone', () => {
    assert.match(script, /^try \{ Start-Process .* \} catch \{\}; /);
    assert.match(script, /Wait-Process -Id 4242 /);
    assert.match(script, /Start-Process -FilePath 'C:\\Program Files\\Zoia\\Zoia\.exe'$/);
  });

  test('a quote in a path cannot end its argument', () => {
    const odd = elevatedUpdateScript({
      pid: 1,
      runner: "C:\\O'Brien\\run.bat",
      executable: "C:\\O'Brien\\Zoia.exe",
    });
    assert.match(odd, /'\/c "C:\\O''Brien\\run\.bat"'/);
    assert.match(odd, /'C:\\O''Brien\\Zoia\.exe'$/);
  });
});

describe('askBeforeInstall', () => {
  test('automatic installs go ahead once per version', () => {
    assert.equal(askBeforeInstall(true, null, '0.14.2'), false);
    assert.equal(askBeforeInstall(true, '0.14.1', '0.14.2'), false);
  });

  test('a version already attempted is asked about, never retried on its own', () => {
    assert.equal(askBeforeInstall(true, '0.14.2', '0.14.2'), true);
  });

  test('without automatic installs, every update is asked about', () => {
    assert.equal(askBeforeInstall(false, null, '0.14.2'), true);
  });
});
