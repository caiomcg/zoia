/**
 * What a desktop release changes, judged from git: whether it can ship as an
 * app.asar-only OTA, and what an OTA needs already installed. Shared by the
 * CI classifier and the release-notes generator, so both tell the same story.
 */

import { execFileSync } from 'node:child_process';

export function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

export function previousTag(ref) {
  try {
    return git(['describe', '--tags', '--abbrev=0', '--match', 'v*', `${ref}^`]);
  } catch {
    return null;
  }
}

function changedFiles(ref, base) {
  if (!base) return [];
  const output = git(['diff', '--name-only', `${base}...${ref}`]);
  return output ? output.split(/\r?\n/).filter(Boolean) : [];
}

function packageContentChanged(ref, path, base) {
  if (!base) return true;
  try {
    const before = JSON.parse(git(['show', `${base}:${path}`]));
    const after = JSON.parse(git(['show', `${ref}:${path}`]));
    if (path === 'desktop/package.json') {
      delete before.version;
      delete after.version;
    }
    return JSON.stringify(before) !== JSON.stringify(after);
  } catch {
    return true;
  }
}

function lockfileContentChanged(ref, path, base) {
  if (!base) return true;
  try {
    const diff = git(['diff', '--unified=0', `${base}...${ref}`, '--', path]);
    return diff
      .split(/\r?\n/)
      .filter(
        (line) =>
          (line.startsWith('+') || line.startsWith('-')) &&
          !line.startsWith('+++') &&
          !line.startsWith('---'),
      )
      .some((line) => !/^[-+]\s*"version":\s*"[^"\r\n]+",?\s*$/.test(line));
  } catch {
    return true;
  }
}

const fullReleaseReasons = [
  [/^desktop\/native\//, 'native addon changed'],
  [/^desktop\/vendor\//, 'bundled native/runtime asset changed'],
  [/^desktop\/ffmpeg\.json$/, 'FFmpeg pin changed'],
  // The Dockerfile and patches the shipped ffmpeg.exe is built from.
  [/^desktop\/ffmpeg\//, 'FFmpeg build changed'],
  [/^desktop\/electron-builder\.yml$/, 'packaging layout changed'],
  [/^desktop\/electron\.vite\.config\.ts$/, 'Electron bundling configuration changed'],
  [/^desktop\/build\//, 'application icon/resource changed'],
];

export function classify(ref) {
  const base = previousTag(ref);
  const files = changedFiles(ref, base);
  let updateType = base ? 'none' : 'full';
  const reasons = base ? [] : ['no previous release tag is available'];

  for (const file of files) {
    const rule = fullReleaseReasons.find(([pattern]) => pattern.test(file));
    if (rule) {
      updateType = 'full';
      reasons.push(rule[1]);
    }
    if (file === 'desktop/package.json' && packageContentChanged(ref, file, base)) {
      updateType = 'full';
      reasons.push('desktop package metadata/dependencies changed');
    }
    if (file === 'desktop/package-lock.json' && lockfileContentChanged(ref, file, base)) {
      updateType = 'full';
      reasons.push('desktop dependency lockfile changed');
    }

    const isAsarChange =
      file.startsWith('desktop/src/') ||
      file === 'desktop/updater-config.json' ||
      (file === 'desktop/package.json' && !packageContentChanged(ref, file, base));
    if (isAsarChange && updateType !== 'full') updateType = 'asar';
  }
  return { base, files, updateType, reasons };
}

/**
 * The version an `asar` update needs already installed: the newest full
 * release at or before `ref`. Anything older has an Electron, FFmpeg or native
 * addon the new app.asar was not built for. Published as `minimumVersion` in
 * the updater manifest.
 */
export function minimumVersion(ref) {
  let tag = git(['describe', '--tags', '--abbrev=0', '--match', 'v*', ref]);
  while (tag) {
    if (classify(tag).updateType === 'full') return tag.replace(/^v/, '');
    tag = previousTag(tag);
  }
  return null;
}
