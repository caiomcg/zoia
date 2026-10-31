/**
 * Whether a desktop release can ship as an OTA: changing only the installer's
 * own options must not force everyone onto the full installer.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { withoutInstallerOptions } from '../lib/desktop-update.js';

const before = `appId: im.zoia.desktop
win:
  target:
    - target: nsis
nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true

  createDesktopShortcut: true
# No auto-update feed configured.
publish: null
`;

describe('withoutInstallerOptions', () => {
  test('only the installer options changing leaves the rest equal', () => {
    const after = before
      .replace('oneClick: false', 'oneClick: true')
      .replace('  allowToChangeInstallationDirectory: true\n', '');
    assert.equal(withoutInstallerOptions(after), withoutInstallerOptions(before));
  });

  test('anything outside them still counts', () => {
    const after = before.replace('appId: im.zoia.desktop', 'appId: im.zoia.other');
    assert.notEqual(withoutInstallerOptions(after), withoutInstallerOptions(before));
    const resources = before.replace('publish: null', 'publish: github');
    assert.notEqual(withoutInstallerOptions(resources), withoutInstallerOptions(before));
  });

  test('the block ends at the next line on the margin, comment or key', () => {
    const kept = withoutInstallerOptions(before);
    assert.match(kept, /# No auto-update feed configured\./);
    assert.doesNotMatch(kept, /oneClick/);
  });
});
