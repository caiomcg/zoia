/**
 * These notes are what people read in the app before updating, so the
 * install instructions in them must match what the updater will really do.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { formatReleaseNotes, parseCommit } from '../lib/release-notes.js';

const hash = (n) => String(n).repeat(40);
const release = (overrides) => ({
  tag: 'v1.2.3',
  base: 'v1.2.2',
  repository: 'owner/zoia',
  commits: [],
  updateType: 'asar',
  minimumVersion: null,
  reasons: [],
  ...overrides,
});

describe('parseCommit', () => {
  test('reads type, scope and breaking marker', () => {
    assert.deepEqual(parseCommit({ hash: 'h', subject: 'feat(server)!: drop v1 tokens' }), {
      type: 'feat',
      scope: 'server',
      breaking: true,
      text: 'drop v1 tokens',
      hash: 'h',
    });
  });

  test('keeps a non-conventional subject as other', () => {
    assert.equal(
      parseCommit({ hash: 'h', subject: 'Fix/updates and league handoff' }).type,
      'other',
    );
  });
});

describe('formatReleaseNotes', () => {
  test('groups by meaning and leaves out release bookkeeping', () => {
    const notes = formatReleaseNotes(
      release({
        commits: [
          { hash: hash(1), subject: 'fix(desktop): stop the echo' },
          { hash: hash(2), subject: 'feat(desktop): add sounds' },
          { hash: hash(3), subject: 'chore: bump version to 1.2.3' },
          { hash: hash(4), subject: 'fix(server): free the seat' },
        ],
      }),
    );
    assert.ok(notes.indexOf('### New') < notes.indexOf('### Fixed'));
    assert.match(
      notes,
      /- Add sounds \(\[2222222\]\(https:\/\/github\.com\/owner\/zoia\/commit\/2{40}\)\)/,
    );
    assert.match(notes, /- \*\*server:\*\* Free the seat/);
    assert.doesNotMatch(notes, /bump version/);
    assert.doesNotMatch(notes, /\*\*desktop:\*\*/);
    assert.match(notes, /compare\/v1\.2\.2\.\.\.v1\.2\.3/);
  });

  test('an OTA names the version it needs', () => {
    const notes = formatReleaseNotes(release({ minimumVersion: '1.2.0' }));
    assert.match(notes, /In-app update/);
    assert.match(notes, /needs Zoia 1\.2\.0 or newer/);
  });

  test('a full release points at the installer and says why', () => {
    const notes = formatReleaseNotes(
      release({ updateType: 'full', reasons: ['native addon changed', 'native addon changed'] }),
    );
    assert.match(notes, /Installer required/);
    assert.match(notes, /\(native addon changed\)/);
    assert.match(notes, /Zoia-Setup-1\.2\.3-x64\.exe/);
  });

  test('a release of only bookkeeping still says something', () => {
    const notes = formatReleaseNotes(
      release({ commits: [{ hash: hash(5), subject: 'chore: bump version' }] }),
    );
    assert.match(notes, /Maintenance only/);
  });
});
