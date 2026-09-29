/**
 * Every installed app takes its next update from what these checks let
 * through, so an update.json is believed only about its own release.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkUpdateFile, updateAssetUrl } from '../src/main/update-release.ts';

const repo = { owner: 'owner', name: 'zoia' };
const download = (name: string) => `https://github.com/owner/zoia/releases/download/v1.2.3/${name}`;
const release = {
  tag_name: 'v1.2.3',
  assets: [
    {
      name: 'Zoia-Setup-1.2.3-x64.exe',
      browser_download_url: download('Zoia-Setup-1.2.3-x64.exe'),
    },
    { name: 'update.json', browser_download_url: download('update.json') },
  ],
};
const update = {
  version: '1.2.3',
  updateType: 'asar',
  artifactUrl: download('Zoia-OTA-1.2.3.asar'),
  installerUrl: download('Zoia-Setup-1.2.3-x64.exe'),
};

test('finds the release’s update.json', () => {
  assert.equal(updateAssetUrl(release), download('update.json'));
});

test('a release without one says so, rather than offering nothing silently', () => {
  assert.throws(
    () => updateAssetUrl({ tag_name: 'v1.2.3', assets: [] }),
    /\(v1\.2\.3\) has no update\.json/,
  );
  assert.throws(() => updateAssetUrl({ tag_name: 'v1.2.3' }), /update\.json/);
});

test('an update.json about its own release is accepted as it is', () => {
  assert.deepEqual(checkUpdateFile(release, repo, update), update);
});

test('one describing another version is refused', () => {
  assert.throws(
    () => checkUpdateFile(release, repo, { ...update, version: '1.2.4' }),
    /does not match/,
  );
  assert.throws(
    () => checkUpdateFile(release, repo, { ...update, version: undefined }),
    /does not match/,
  );
});

test('files from another release, repository or host are refused', () => {
  for (const artifactUrl of [
    'https://github.com/owner/zoia/releases/download/v1.2.2/Zoia-OTA-1.2.2.asar',
    'https://github.com/someone/zoia/releases/download/v1.2.3/Zoia-OTA-1.2.3.asar',
    'https://example.com/Zoia-OTA-1.2.3.asar',
  ]) {
    assert.throws(
      () => checkUpdateFile(release, repo, { ...update, artifactUrl }),
      /outside its release/,
    );
  }
  assert.throws(
    () =>
      checkUpdateFile(release, repo, { ...update, installerUrl: 'https://example.com/setup.exe' }),
    /outside its release/,
  );
});

test('a full release, with no OTA archive, passes', () => {
  const full = { version: '1.2.3', updateType: 'full', installerUrl: update.installerUrl };
  assert.deepEqual(checkUpdateFile(release, repo, full), full);
});
