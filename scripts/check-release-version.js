#!/usr/bin/env node
/**
 * Refuses a release tag that disagrees with the package versions.
 *
 * electron-builder names its artifacts from `desktop/package.json`, not from
 * the git tag. Tagging v0.2.0 while package.json still says 0.1.0 therefore
 * publishes `Zoia-0.1.0-portable.exe` under a release called v0.2.0, and
 * nobody notices until somebody reports the wrong version in a bug report.
 *
 * Deliberately a check rather than a fix: deriving the version from the tag
 * inside CI would mutate package.json and the lockfile mid-build, so the tree
 * the artifact came from would no longer be the tree at the tag. For an
 * unsigned binary people download from the internet, being able to rebuild it
 * from the tag is the only provenance story there is.
 */

import { readFileSync } from 'node:fs';

const tag = process.argv[2] ?? '';
const expected = tag.replace(/^v/, '');

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expected)) {
  console.error(`Not a release tag: "${tag}". Expected vMAJOR.MINOR.PATCH.`);
  process.exit(1);
}

let ok = true;
for (const file of ['package.json', 'desktop/package.json']) {
  const { version } = JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
  if (version !== expected) {
    console.error(`${file} says ${version}, but the tag says ${expected}.`);
    ok = false;
  }
}

if (!ok) {
  console.error(
    `\nBump both, commit, then re-tag:\n` +
      `  npm version ${expected} --no-git-tag-version\n` +
      `  npm version ${expected} --no-git-tag-version --prefix desktop\n`,
  );
  process.exit(1);
}

console.log(`Version ${expected} agrees across package.json and desktop/package.json.`);
