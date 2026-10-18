/**
 * Everything the database has written to disk, as text, for tests asserting
 * that a secret never got there. With WAL, a fresh write is in the -wal file
 * before it reaches the database file, so both are read.
 */

import { readFile } from 'node:fs/promises';

export async function databaseOnDisk(file) {
  const parts = await Promise.all(
    [file, `${file}-wal`].map((path) => readFile(path).catch(() => Buffer.alloc(0))),
  );
  return Buffer.concat(parts).toString('latin1');
}
