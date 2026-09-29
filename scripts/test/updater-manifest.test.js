/**
 * The manifest is what tells every installed app there is an update, and CI
 * now writes it unattended. A wrong URL or checksum breaks updating for
 * everyone, so it is built only from assets the release really has.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseEntry } from '../lib/changelog.js';
import { buildManifest, compareVersions } from '../lib/updater-manifest.js';

const sha = (c) => c.repeat(64);
const base = {
  version: '1.2.3',
  repository: 'owner/zoia',
  assets: { 'Zoia-Setup-1.2.3-x64.exe': sha('a'), 'Zoia-OTA-1.2.3.asar': sha('b') },
};
const url = (name) => `https://github.com/owner/zoia/releases/download/v1.2.3/${name}`;

describe('buildManifest', () => {
  test('a full release points at the installer', () => {
    assert.deepEqual(buildManifest({ ...base, updateType: 'full', notes: 'Better.' }), {
      version: '1.2.3',
      updateType: 'full',
      installerUrl: url('Zoia-Setup-1.2.3-x64.exe'),
      notes: 'Better.',
    });
  });

  test('an asar release carries the OTA, its checksum and the installer fallback', () => {
    assert.deepEqual(buildManifest({ ...base, updateType: 'asar', minimumVersion: '1.2.0' }), {
      version: '1.2.3',
      updateType: 'asar',
      minimumVersion: '1.2.0',
      artifactUrl: url('Zoia-OTA-1.2.3.asar'),
      sha256: sha('b'),
      installerUrl: url('Zoia-Setup-1.2.3-x64.exe'),
    });
  });

  test('never includes a commit, which would stop matching as main moves', () => {
    assert.equal('commit' in buildManifest({ ...base, updateType: 'full' }), false);
  });

  test('refuses a release without its installer', () => {
    assert.throws(
      () => buildManifest({ ...base, assets: {}, updateType: 'full' }),
      /Zoia-Setup-1.2.3-x64.exe/,
    );
  });

  test('refuses an asar release without the OTA or a minimum version', () => {
    const assets = { 'Zoia-Setup-1.2.3-x64.exe': sha('a') };
    assert.throws(
      () => buildManifest({ ...base, assets, updateType: 'asar', minimumVersion: '1.2.0' }),
      /OTA/,
    );
    assert.throws(() => buildManifest({ ...base, updateType: 'asar' }), /minimum version/);
  });

  test('refuses a none release', () => {
    assert.throws(() => buildManifest({ ...base, updateType: 'none' }), /none/);
  });
});

describe('compareVersions', () => {
  test('compares numerically, not as text', () => {
    assert.ok(compareVersions('0.3.20', '0.4.0') < 0);
    assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
    assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  });
});

describe('parseEntry', () => {
  test('splits the summary from the body', () => {
    assert.deepEqual(parseEntry('---\nsummary: Faster sharing.\n---\n\n### New\n\n- A thing.\n'), {
      summary: 'Faster sharing.',
      body: '\n### New\n\n- A thing.\n',
    });
  });

  test('reads CRLF line endings', () => {
    assert.equal(parseEntry('---\r\nsummary: Hi.\r\n---\r\n### New\r\n').summary, 'Hi.');
  });

  test('an entry without front matter is all body', () => {
    assert.deepEqual(parseEntry('### New\n'), { summary: null, body: '### New\n' });
  });
});
