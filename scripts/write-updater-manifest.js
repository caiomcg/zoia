#!/usr/bin/env node
/**
 * Writes desktop/updater-manifest.json for a published release.
 *
 *   node scripts/write-updater-manifest.js v0.4.1 <assets-dir> <update-type> [minimum-version]
 *
 * <assets-dir> holds the files downloaded back from the GitHub release, so the
 * checksums are of what people will actually download. <update-type> and
 * [minimum-version] are what scripts/classify-desktop-update.js printed for
 * the tag. The notes are the `summary` of changelog/<version>.md.
 *
 * Leaves the manifest alone, and says so, for a `none` release or when it
 * already announces a newer version. Prints the manifest it wrote.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEntry } from './lib/changelog.js';
import { git } from './lib/desktop-update.js';
import { buildManifest, compareVersions } from './lib/updater-manifest.js';

const [tag, dir, updateType, minimumVersion] = process.argv.slice(2);
if (!tag || !dir || !updateType) {
  console.error(
    'usage: node scripts/write-updater-manifest.js <tag> <assets-dir> <update-type> [minimum-version]',
  );
  process.exit(2);
}

function repository() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const origin = git(['remote', 'get-url', 'origin']);
  const match = /github\.com[:/](.+?)(?:\.git)?$/.exec(origin);
  if (!match) throw new Error(`origin is not a GitHub remote: ${origin}`);
  return match[1];
}

const version = tag.replace(/^v/, '');
const manifestFile = new URL('../desktop/updater-manifest.json', import.meta.url);

if (updateType === 'none') {
  console.log(`${tag} changes nothing in the desktop app; the manifest stays as it is.`);
  process.exit(0);
}

if (existsSync(manifestFile)) {
  const current = JSON.parse(readFileSync(manifestFile, 'utf8')).version;
  if (current && compareVersions(current, version) > 0) {
    console.log(`The manifest already announces ${current}, newer than ${version}; left alone.`);
    process.exit(0);
  }
}

const assets = {};
for (const name of readdirSync(dir)) {
  assets[name] = createHash('sha256')
    .update(readFileSync(join(dir, name)))
    .digest('hex');
}

const entryFile = new URL(`../changelog/${version}.md`, import.meta.url);
const notes = existsSync(entryFile) ? parseEntry(readFileSync(entryFile, 'utf8')).summary : null;

const manifest = buildManifest({
  version,
  repository: repository(),
  updateType,
  minimumVersion: minimumVersion || null,
  assets,
  notes,
});

const json = `${JSON.stringify(manifest, null, 2)}\n`;
writeFileSync(manifestFile, json);
process.stdout.write(json);
