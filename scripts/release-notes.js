#!/usr/bin/env node
/**
 * Prints the release notes for a tag, for `gh release create --notes-file`.
 *
 *   node scripts/release-notes.js v0.3.16 > notes.md
 *
 * The body is changelog/<version>.md when it exists, and the commits since the
 * previous tag otherwise. The repository is GITHUB_REPOSITORY in CI, or read
 * from the origin remote.
 * Needs the tags in the checkout, like the classifier it shares logic with.
 */

import { existsSync, readFileSync } from 'node:fs';
import { classify, git, minimumVersion } from './lib/desktop-update.js';
import { formatReleaseNotes } from './lib/release-notes.js';

const tag = process.argv[2];
if (!tag) {
  console.error('usage: node scripts/release-notes.js <tag>');
  process.exit(2);
}

function repository() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const origin = git(['remote', 'get-url', 'origin']);
  const match = /github\.com[:/](.+?)(?:\.git)?$/.exec(origin);
  if (!match) throw new Error(`origin is not a GitHub remote: ${origin}`);
  return match[1];
}

const { base, updateType, reasons } = classify(tag);
const entryFile = new URL(`../changelog/${tag.replace(/^v/, '')}.md`, import.meta.url);
const entry = existsSync(entryFile) ? readFileSync(entryFile, 'utf8') : null;
// Releases from before the Mac build have no Mac section in their packaging.
let macos = false;
try {
  macos = /^mac:/m.test(git(['show', `${tag}:desktop/electron-builder.yml`]));
} catch {
  macos = false;
}
const range = base ? `${base}..${tag}` : tag;
const log = git(['log', '--no-merges', '--format=%H%x1f%s', range]);
const commits = log
  ? log.split(/\r?\n/).map((line) => {
      const [hash, subject] = line.split('\x1f');
      return { hash, subject };
    })
  : [];

process.stdout.write(
  formatReleaseNotes({
    tag,
    base,
    repository: repository(),
    commits,
    updateType,
    minimumVersion: updateType === 'asar' && base ? minimumVersion(base) : null,
    reasons,
    entry,
    macos,
  }),
);
