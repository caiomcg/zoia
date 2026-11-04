/**
 * Whether a desktop release can ship as an OTA: changing only the installer's
 * own options, or only the npm scripts, must not force everyone onto the full
 * installer.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { withoutInstallerOptions, withoutUnshippedPackageFields } from '../lib/desktop-update.js';

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

const pkg = {
  name: 'zoia-desktop',
  version: '0.14.4',
  main: 'out/main/index.js',
  scripts: { dev: 'electron-vite dev' },
  dependencies: { 'livekit-client': '^2.0.0' },
};
const json = (value) => JSON.stringify(value, null, 2);

describe('withoutUnshippedPackageFields', () => {
  test('a new version or npm script leaves the rest equal', () => {
    const after = {
      ...pkg,
      version: '0.14.5',
      scripts: { ...pkg.scripts, 'dev:demo': 'vite --config vite.demo.config.ts' },
    };
    assert.equal(
      withoutUnshippedPackageFields(json(after)),
      withoutUnshippedPackageFields(json(pkg)),
    );
  });

  test('a dependency or the entry point still counts', () => {
    const dependency = { ...pkg, dependencies: { 'livekit-client': '^2.1.0' } };
    assert.notEqual(
      withoutUnshippedPackageFields(json(dependency)),
      withoutUnshippedPackageFields(json(pkg)),
    );
    const main = { ...pkg, main: 'out/main/other.js' };
    assert.notEqual(
      withoutUnshippedPackageFields(json(main)),
      withoutUnshippedPackageFields(json(pkg)),
    );
  });
});
