/**
 * The client looks elements up by id at module scope. When one is missing the
 * lookup yields undefined, and the first listener attached to it throws before
 * anything renders — a blank page with no visible cause.
 *
 * This has happened twice. These tests make the markup and the client agree.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const html = readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8');
const js = readFileSync(join(PUBLIC_DIR, 'app.js'), 'utf8');

const htmlIds = new Set([...html.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));

/** The id list the client builds its element map from. */
function expectedIds() {
  const block = js.match(/const el = Object\.fromEntries\(\s*\[([\s\S]*?)\]\.map/);
  assert.ok(block, 'could not find the element id list in app.js');
  return [...block[1].matchAll(/'([\w-]+)'/g)].map((m) => m[1]);
}

describe('markup and client agree', () => {
  test('every id the client looks up exists in the markup', () => {
    const missing = expectedIds().filter((id) => !htmlIds.has(id));
    assert.deepEqual(missing, [], `app.js expects ids that index.html does not define`);
  });

  test('the element map covers every id the client dereferences', () => {
    // Catches el.somethingNew added without extending the id list.
    const mapped = new Set(
      expectedIds().map((id) => id.replace(/-(\w)/g, (_, c) => c.toUpperCase())),
    );
    const used = new Set([...js.matchAll(/\bel\.(\w+)/g)].map((m) => m[1]));
    const undeclared = [...used].filter((name) => !mapped.has(name));
    assert.deepEqual(undeclared, [], 'el.<name> used without a matching id in the list');
  });

  test('no listener is attached directly to a possibly-missing element', () => {
    // Top-level `el.x.addEventListener` is what turns a missing id into a
    // blank page; `on(el.x, ...)` degrades instead.
    const direct = [...js.matchAll(/^el\.(\w+)\.addEventListener/gm)].map((m) => m[1]);
    assert.deepEqual(direct, [], 'use on(el.x, event, handler) instead');
  });
});
