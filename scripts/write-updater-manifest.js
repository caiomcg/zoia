#!/usr/bin/env node
/**
 * Writes what a release says about itself as an update: its type, the
 * checksum of its OTA archive, the oldest install it may be applied to, and a
 * line for the update prompt.
 *
 *   node scripts/write-updater-manifest.js <tag> <assets-dir> <update-type> [minimum-version] [--out <file>]
 *
 * <assets-dir> holds the files the release publishes, so the checksums are of
 * what people will actually download. <update-type> and [minimum-version] are
 * what scripts/classify-desktop-update.js printed for the tag. The notes are
 * the `summary` of changelog/<version>.md.
 *
 * With --out, the release workflow writes the release's own update.json, which
 * apps from 0.4.4 on read from the latest release. Without it, the file is
 * desktop/updater-manifest.json on main, which older apps read; that is left
 * alone if it already announces a newer version.
 *
 * A `none` release gets nothing, and says so. Prints what it wrote.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEntry } from './lib/changelog.js';
import { git } from './lib/desktop-update.js';
import { buildManifest, compareVersions } from './lib/updater-manifest.js';

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const out = outAt >= 0 ? args.splice(outAt, 2)[1] : null;
const [tag, dir, updateType, minimumVersion] = args;
if (!tag || !dir || !updateType || (outAt >= 0 && !out)) {
  console.error(
    'usage: node scripts/write-updater-manifest.js <tag> <assets-dir> <update-type> [minimum-version] [--out <file>]',
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
const target = out
  ? resolve(out)
  : fileURLToPath(new URL('../desktop/updater-manifest.json', import.meta.url));

if (updateType === 'none') {
  console.log(`${tag} changes nothing in the desktop app; no update is written.`);
  process.exit(0);
}

if (!out && existsSync(target)) {
  const current = JSON.parse(readFileSync(target, 'utf8')).version;
  if (current && compareVersions(current, version) > 0) {
    console.log(`The manifest already announces ${current}, newer than ${version}; left alone.`);
    process.exit(0);
  }
}

// Files only: a folder beside them, or the output itself, is not an asset.
const assets = {};
for (const name of readdirSync(dir)) {
  const path = join(dir, name);
  if (!statSync(path).isFile() || resolve(path) === target) continue;
  assets[name] = createHash('sha256').update(readFileSync(path)).digest('hex');
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
writeFileSync(target, json);
process.stdout.write(json);
