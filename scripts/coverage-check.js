#!/usr/bin/env node
/**
 * Fails when line coverage drops below the floor.
 *
 * The README publishes a coverage figure, and a figure nobody enforces drifts
 * away from the truth. This is deliberately a floor rather than an exact
 * match: coverage moving up should never break a build.
 */

import { spawnSync } from 'node:child_process';

const FLOOR = Number(process.env.COVERAGE_FLOOR ?? 90);

const run = spawnSync(
  process.execPath,
  ['--test', '--experimental-test-coverage', 'server/test/**/*.test.js'],
  { encoding: 'utf8', shell: process.platform === 'win32' },
);

const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
if (run.status !== 0) {
  process.stdout.write(output);
  console.error('\nTests failed, so coverage was not assessed.');
  process.exit(run.status ?? 1);
}

// The summary line reads: "all files | 95.53 | 87.11 | 86.41 |"
const summary = output.match(/all files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/i);
if (!summary) {
  console.error('Could not find a coverage summary in the test output.');
  process.exit(1);
}

const [, lines, branches, functions] = summary.map(Number);
console.log(`lines ${lines}%  branches ${branches}%  functions ${functions}%`);

if (lines < FLOOR) {
  console.error(`Line coverage ${lines}% is below the ${FLOOR}% floor.`);
  process.exit(1);
}
console.log(`Above the ${FLOOR}% floor.`);
