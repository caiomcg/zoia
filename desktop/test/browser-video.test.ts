/**
 * Whether a browser's command line carries the flags that keep its videos
 * out of DirectComposition, and so visible in a broadcast. The command lines
 * are the shapes Chrome's processes arrive in from WMI.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIREFOX_PREFS,
  argumentsWithVideoFlags,
  argumentsWithoutVideoFlags,
  defaultFirefoxProfiles,
  isMainProcess,
  missingFirefoxPrefs,
  missingVideoFlags,
  prefsJsWith,
  prefsJsWithout,
  splitCommandLine,
} from '../src/shared/browser-video.ts';

const EXE = '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"';

describe('splitCommandLine', () => {
  test('quotes group a path with spaces', () => {
    assert.deepEqual(splitCommandLine(`${EXE} --a  --b="x y"`), [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      '--a',
      '--b=x y',
    ]);
  });
});

describe('isMainProcess', () => {
  test('the browser started from a shortcut is the main process', () => {
    assert.equal(isMainProcess(`${EXE} --source-shortcut-location=taskbar`), true);
  });

  test('helpers carry a --type= and are not', () => {
    assert.equal(isMainProcess(`${EXE} --type=gpu-process --gpu-preferences=WAAA`), false);
    assert.equal(isMainProcess(`${EXE} --type=renderer --renderer-client-id=7`), false);
  });
});

describe('missingVideoFlags', () => {
  test('a plain start lacks both', () => {
    assert.deepEqual(missingVideoFlags(`${EXE} --source-shortcut-location=taskbar`), [
      '--disable-direct-composition-video-overlays',
      '--disable-direct-composition',
    ]);
  });

  test('the overlays flag alone does not pass for the other', () => {
    assert.deepEqual(missingVideoFlags(`${EXE} --disable-direct-composition-video-overlays`), [
      '--disable-direct-composition',
    ]);
  });

  test('both, in any order, are enough', () => {
    assert.deepEqual(
      missingVideoFlags(
        `${EXE} --disable-direct-composition --disable-direct-composition-video-overlays`,
      ),
      [],
    );
  });
});

describe('argumentsWithVideoFlags', () => {
  test('appends what a shortcut lacks and keeps what it had', () => {
    assert.equal(
      argumentsWithVideoFlags('--profile-directory="Default"'),
      '--profile-directory="Default" --disable-direct-composition-video-overlays --disable-direct-composition',
    );
  });

  test('an empty shortcut gets just the flags', () => {
    assert.equal(
      argumentsWithVideoFlags(''),
      '--disable-direct-composition-video-overlays --disable-direct-composition',
    );
  });

  test('a shortcut that already has them is left alone', () => {
    assert.equal(
      argumentsWithVideoFlags(
        '--disable-direct-composition-video-overlays --disable-direct-composition',
      ),
      null,
    );
  });
});

describe('isMainProcess for Firefox', () => {
  test('content processes carry -contentproc and are not', () => {
    const ff = '"C:\\Program Files\\Mozilla Firefox\\firefox.exe"';
    assert.equal(isMainProcess(`${ff} -first-startup`, 'firefox'), true);
    assert.equal(
      isMainProcess(`${ff} -contentproc -isForBrowser -prefsHandle 1`, 'firefox'),
      false,
    );
  });
});

describe('defaultFirefoxProfiles', () => {
  test('the installation names its default profile', () => {
    const ini = [
      '[Profile1]',
      'Name=default',
      'IsRelative=1',
      'Path=Profiles/niof8ly2.default',
      'Default=1',
      '',
      '[Profile0]',
      'Name=default-release',
      'IsRelative=1',
      'Path=Profiles/iwyhw0dh.default-release',
      '',
      '[Install308046B0AF4A39CB]',
      'Default=Profiles/iwyhw0dh.default-release',
      'Locked=1',
    ].join('\r\n');
    assert.deepEqual(defaultFirefoxProfiles(ini), [
      { path: 'Profiles/iwyhw0dh.default-release', relative: true },
    ]);
  });

  test('without an installation section, the profile marked Default=1', () => {
    const ini = '[Profile0]\nIsRelative=0\nPath=D:\\ff\\p\nDefault=1\n';
    assert.deepEqual(defaultFirefoxProfiles(ini), [{ path: 'D:\\ff\\p', relative: false }]);
  });
});

describe('Firefox prefs', () => {
  const header = '// Mozilla User Preferences\n\nuser_pref("browser.startup.page", 3);\n';

  test('a profile that never set them lacks all three', () => {
    assert.equal(missingFirefoxPrefs(header).length, 3);
  });

  test('written, they are all in place and nothing else changes', () => {
    const written = prefsJsWith(header, { ...FIREFOX_PREFS });
    assert.deepEqual(missingFirefoxPrefs(written), []);
    assert.ok(written.startsWith(header));
  });

  test('an existing line is replaced, not repeated', () => {
    const before = `${header}user_pref("gfx.webrender.dcomp-win.enabled", true);\n`;
    const after = prefsJsWith(before, { ...FIREFOX_PREFS });
    assert.equal(after.match(/dcomp-win\.enabled/g)?.length, 1);
    assert.match(after, /user_pref\("gfx\.webrender\.dcomp-win\.enabled", false\);/);
  });
});

describe('undoing the fix', () => {
  test('a shortcut loses just the video flags', () => {
    assert.equal(
      argumentsWithoutVideoFlags(
        '--profile-directory="Default" --disable-direct-composition-video-overlays --disable-direct-composition',
      ),
      '--profile-directory="Default"',
    );
  });

  test('a shortcut without them is left alone', () => {
    assert.equal(argumentsWithoutVideoFlags('--source-shortcut-location=taskbar'), null);
  });

  test('a fixed then undone shortcut is as it was', () => {
    const original = '--source-shortcut-location=taskbar';
    assert.equal(argumentsWithoutVideoFlags(argumentsWithVideoFlags(original)!), original);
  });

  test('prefs.js loses the three lines and keeps the rest', () => {
    const header = '// Mozilla User Preferences\n\nuser_pref("browser.startup.page", 3);\n';
    const fixed = prefsJsWith(header, { ...FIREFOX_PREFS });
    const undone = prefsJsWithout(fixed, Object.keys(FIREFOX_PREFS));
    assert.equal(undone, header);
    assert.equal(missingFirefoxPrefs(undone).length, 3);
  });
});
