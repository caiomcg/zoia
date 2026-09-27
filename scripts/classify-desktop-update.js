import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const ref = process.argv[2] ?? 'HEAD';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function previousTag() {
  try {
    return git(['describe', '--tags', '--abbrev=0', `${ref}^`]);
  } catch {
    return null;
  }
}

function changedFiles(base) {
  if (!base) return [];
  const output = git(['diff', '--name-only', `${base}...${ref}`]);
  return output ? output.split(/\r?\n/).filter(Boolean) : [];
}

function packageContentChanged(path, base) {
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

function lockfileContentChanged(path, base) {
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
  [/^desktop\/electron-builder\.yml$/, 'packaging layout changed'],
  [/^desktop\/electron\.vite\.config\.ts$/, 'Electron bundling configuration changed'],
  [/^desktop\/build\//, 'application icon/resource changed'],
];

const base = previousTag();
const files = changedFiles(base);
let updateType = base ? 'none' : 'full';
const reasons = base ? [] : ['no previous release tag is available'];

for (const file of files) {
  const rule = fullReleaseReasons.find(([pattern]) => pattern.test(file));
  if (rule) {
    updateType = 'full';
    reasons.push(rule[1]);
  }
  if (file === 'desktop/package.json' && packageContentChanged(file, base)) {
    updateType = 'full';
    reasons.push('desktop package metadata/dependencies changed');
  }
  if (file === 'desktop/package-lock.json' && lockfileContentChanged(file, base)) {
    updateType = 'full';
    reasons.push('desktop dependency lockfile changed');
  }

  const isAsarChange =
    file.startsWith('desktop/src/') ||
    file === 'desktop/updater-config.json' ||
    (file === 'desktop/package.json' && !packageContentChanged(file, base));
  if (isAsarChange && updateType !== 'full') updateType = 'asar';
}

const uniqueReasons = [...new Set(reasons)];
console.log(`Desktop update classification: ${updateType}`);
console.log(`Comparison base: ${base ?? 'none'}`);
console.log(`Changed files: ${files.length}`);
if (uniqueReasons.length) console.log(`Full-release reasons: ${uniqueReasons.join('; ')}`);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `update_type=${updateType}\nbase_tag=${base ?? ''}\n`);
}
