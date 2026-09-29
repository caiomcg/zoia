/**
 * The broadcast strip can be dragged to any edge. Where a point lands decides
 * the edge, so a wrong answer here parks the thumbnails over the picture the
 * person was trying to uncover.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { dockDragPosition, stripEdgeAt } from '../src/renderer/strip-dock.ts';

describe('stripEdgeAt', () => {
  test('picks the edge a point is nearest, on a square', () => {
    assert.equal(stripEdgeAt(50, 10, 100, 100), 'top');
    assert.equal(stripEdgeAt(50, 90, 100, 100), 'bottom');
    assert.equal(stripEdgeAt(10, 50, 100, 100), 'left');
    assert.equal(stripEdgeAt(90, 50, 100, 100), 'right');
  });

  test('a short drag up still hits the top on a wide stage', () => {
    // 20px from the top, 300px from the left: the picture is wide, the drag was up.
    assert.equal(stripEdgeAt(400, 20, 800, 200), 'top');
  });

  test('a drag toward a side hits that side even on a short stage', () => {
    assert.equal(stripEdgeAt(30, 100, 800, 200), 'left');
    assert.equal(stripEdgeAt(770, 100, 800, 200), 'right');
  });

  test('a tie between two edges goes to the top or the bottom', () => {
    assert.equal(stripEdgeAt(0, 0, 100, 100), 'top');
    assert.equal(stripEdgeAt(100, 100, 100, 100), 'bottom');
  });

  test('the centre, and a stage with no size, stay on the bottom', () => {
    assert.equal(stripEdgeAt(50, 50, 100, 100), 'bottom');
    assert.equal(stripEdgeAt(0, 0, 0, 100), 'bottom');
    assert.equal(stripEdgeAt(0, 0, 100, 0), 'bottom');
  });

  test('a point outside the stage still belongs to the nearest edge', () => {
    assert.equal(stripEdgeAt(-20, 50, 100, 100), 'left');
    assert.equal(stripEdgeAt(50, 140, 100, 100), 'bottom');
  });
});

describe('dockDragPosition', () => {
  const area = { left: 10, top: 20, width: 200, height: 100 };

  test('centres the strip on the pointer', () => {
    assert.deepEqual(dockDragPosition(110, 70, area, { width: 40, height: 20 }), {
      left: 80,
      top: 40,
    });
  });

  test('keeps the strip inside the stage', () => {
    assert.deepEqual(dockDragPosition(0, 0, area, { width: 40, height: 20 }), {
      left: 8,
      top: 8,
    });
    assert.deepEqual(dockDragPosition(400, 400, area, { width: 40, height: 20 }), {
      left: 152,
      top: 72,
    });
  });

  test('a strip larger than the stage stays on the margin', () => {
    assert.deepEqual(dockDragPosition(50, 50, area, { width: 400, height: 400 }), {
      left: 8,
      top: 8,
    });
  });
});
