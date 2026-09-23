#!/usr/bin/env node
/**
 * Fails when line coverage drops below the floor.
 *
 * The README publishes a coverage figure, and a figure nobody enforces drifts
 * away from the truth. This is deliberately a floor rather than an exact
 * match: coverage moving up should never break a build.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const FLOOR = Number(process.env.COVERAGE_FLOOR ?? 90);

// The files are listed explicitly rather than passed as a pattern. `--test`
// only learned to expand globs itself in Node 21, this spawn has no shell to
// expand one, and a positional path is loaded as a module rather than walked
// as a directory. Enumerating here is the one form that behaves the same on
// every Node the project supports.
const TEST_DIR = new URL('../server/test/', import.meta.url);
const files = readdirSync(TEST_DIR)
  .filter((name) => name.endsWith('.test.js'))
  .map((name) => join('server', 'test', name));

if (files.length === 0) {
  console.error('No test files found, which is not the same as everything passing.');
  process.exit(1);
}

// server/bin is excluded deliberately. keytool is a CLI, and keytool.test.js
// exercises it the way it is actually used — by spawning it — which the runner
// cannot attribute back to its lines. Counting it reported 54% for a file whose
// behaviour is tested, and pulled the figure for server/src down with it. This
// floor is about the application.
const run = spawnSync(
  process.execPath,
  [
    '--test',
    '--experimental-test-coverage',
    '--test-coverage-exclude=server/bin/**',
    '--test-coverage-exclude=server/test/**',
    ...files,
  ],
  { encoding: 'utf8', shell: false },
);

const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
if (run.status !== 0) {
  process.stdout.write(output);
  console.error('\nTests failed, so coverage was not assessed.');
  process.exit(run.status ?? 1);
}

// Colour codes sit between the pipes and the numbers whenever the runner emits
// them, and `\s*` does not match an escape sequence — so the summary appeared
// to vanish and this failed with a parse error instead of a figure.
// eslint-disable-next-line no-control-regex
const plain = output.replace(/\u001b\[[0-9;]*m/g, '');

// The summary line reads: "all files | 95.53 | 87.11 | 86.41 |"
const summary = plain.match(/all files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/i);
if (!summary) {
  console.error('Could not find a coverage summary in the test output.');
  process.exit(1);
}

const [, lines, branches, functions] = summary.map(Number);
console.log(`lines ${lines}%  branches ${branches}%  functions ${functions}%`);

// Only lines are gated. Branches and functions are printed because they are
// the honest picture — and they sit lower than lines — but gating three
// numbers at once turns every unreachable error path into a blocked merge.
if (lines < FLOOR) {
  console.error(`Line coverage ${lines}% is below the ${FLOOR}% floor.`);
  process.exit(1);
}
console.log(`Line coverage is above the ${FLOOR}% floor.`);
