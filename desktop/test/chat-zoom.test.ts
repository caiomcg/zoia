/**
 * The photo viewer's arithmetic: what fits, how far a click zooms, and that
 * a zoomed picture can be moved to any part of it but never out of sight.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FIT, MAX_SCALE, clamp, clickScale, fitted, zoomAt } from '../src/renderer/chat/zoom.ts';

const stage = { width: 1000, height: 800 };

describe('fitting', () => {
  test('a large picture shrinks to fit, keeping its shape', () => {
    assert.deepEqual(fitted({ width: 4000, height: 2000 }, stage), { width: 1000, height: 500 });
    assert.deepEqual(fitted({ width: 1000, height: 4000 }, stage), { width: 200, height: 800 });
  });

  test('a small one is never blown up', () => {
    assert.deepEqual(fitted({ width: 300, height: 200 }, stage), { width: 300, height: 200 });
  });

  test('a picture not loaded yet has no size', () => {
    assert.deepEqual(fitted({ width: 0, height: 0 }, stage), { width: 0, height: 0 });
  });
});

describe('a click', () => {
  test("zooms to the picture's own pixels, at least twice, at most the limit", () => {
    assert.equal(clickScale({ width: 4000, height: 2000 }, { width: 1000, height: 500 }), 4);
    assert.equal(clickScale({ width: 300, height: 200 }, { width: 300, height: 200 }), 2);
    assert.equal(
      clickScale({ width: 40000, height: 2000 }, { width: 1000, height: 50 }),
      MAX_SCALE,
    );
  });
});

describe('zooming and dragging', () => {
  const shown = { width: 1000, height: 500 };

  test('the point clicked stays under the pointer', () => {
    const at = { x: 200, y: 100 };
    const view = zoomAt(FIT, 2, at, shown, stage);
    // On screen a point of the picture is at view + point × scale; at 1x it was at `at`.
    assert.equal(view.x + at.x * view.scale, at.x);
    assert.equal(view.y + at.y * view.scale, at.y);
    assert.deepEqual(view, { scale: 2, x: -200, y: -100 });
  });

  test('never out of sight: the edge stops at the edge of the screen', () => {
    // At 2x the picture is 2000 x 1000: it may move 500 either way, and 100 up or down.
    assert.deepEqual(clamp({ scale: 2, x: 9000, y: -9000 }, shown, stage), {
      scale: 2,
      x: 500,
      y: -100,
    });
  });

  test('a picture smaller than the screen stays centred', () => {
    assert.deepEqual(clamp({ scale: 1, x: 50, y: 50 }, shown, stage), { scale: 1, x: 0, y: 0 });
  });

  test('zooming is kept between fitted and the limit', () => {
    assert.equal(zoomAt(FIT, 0.2, { x: 0, y: 0 }, shown, stage).scale, 1);
    assert.equal(zoomAt(FIT, 99, { x: 0, y: 0 }, shown, stage).scale, MAX_SCALE);
  });
});
