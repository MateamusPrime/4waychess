import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ARMIES, SQUARES, squareName } from '@4wc/engine';
import { THEMES, THEME_IDS } from '../src/themes.ts';
import {
  IDENTITY_CAMERA, MAX_ZOOM, MIN_TOUCH_TARGET, MIN_ZOOM,
  cellRect, clampCamera, computeLayout, hitTest, insetRect, lerpRect,
  needsZoomForTouch, rectCenter, squareRect, zoomForComfortableTouch,
} from '../src/layout.ts';

const DESKTOP = { width: 1200, height: 900 };
const PHONE = { width: 390, height: 844 };

describe('layout geometry', () => {
  test('the board fits inside the viewport for every theme and both viewports', () => {
    for (const id of THEME_IDS) {
      for (const vp of [DESKTOP, PHONE]) {
        const l = computeLayout(vp, THEMES[id]);
        const shortest = Math.min(vp.width, vp.height);
        assert.ok(l.board.w <= shortest + 0.001, `${id} board too wide`);
        assert.ok(l.board.h <= shortest + 0.001, `${id} board too tall`);
        assert.ok(l.square > 0);
      }
    }
  });

  test('the grid is exactly 14 squares plus 13 gaps', () => {
    for (const id of THEME_IDS) {
      const l = computeLayout(DESKTOP, THEMES[id]);
      assert.ok(Math.abs(l.grid.w - (14 * l.square + 13 * l.gap)) < 1e-9, id);
      assert.ok(Math.abs(l.board.w - (l.grid.w + 2 * l.pad)) < 1e-9, id);
    }
  });

  test('the board is centred in the viewport at rest', () => {
    const l = computeLayout(DESKTOP, THEMES.midnight);
    const c = rectCenter(l.board);
    assert.ok(Math.abs(c.x - DESKTOP.width / 2) < 1e-9);
    assert.ok(Math.abs(c.y - DESKTOP.height / 2) < 1e-9);
  });

  test('gapless themes really are gapless, and Storybook really has gaps', () => {
    assert.equal(computeLayout(DESKTOP, THEMES.midnight).gap, 0);
    assert.equal(computeLayout(DESKTOP, THEMES.atelier).gap, 0);
    assert.ok(computeLayout(DESKTOP, THEMES.storybook).gap > 0, 'Storybook needs grid lines');
    assert.ok(computeLayout(DESKTOP, THEMES.storybook).radius > 0, 'and rounded squares');
  });

  test('adjacent cells are exactly one step apart', () => {
    const l = computeLayout(DESKTOP, THEMES.storybook);
    const a = cellRect(l, 3, 5);
    const b = cellRect(l, 4, 5);
    assert.ok(Math.abs(b.x - a.x - (l.square + l.gap)) < 1e-9);
    assert.equal(a.y, b.y);
  });

  test('degenerate viewports do not produce NaN or negative sizes', () => {
    for (const vp of [{ width: 0, height: 0 }, { width: 1, height: 1000 }]) {
      const l = computeLayout(vp, THEMES.midnight);
      assert.ok(Number.isFinite(l.square) && l.square > 0, JSON.stringify(vp));
      assert.ok(Number.isFinite(l.board.x) && Number.isFinite(l.board.y));
    }
  });
});

describe('hit testing', () => {
  test('the centre of every square hits that square, for every seat and theme', () => {
    for (const id of THEME_IDS) {
      const l = computeLayout(DESKTOP, THEMES[id]);
      for (const seat of ARMIES) {
        for (const sq of SQUARES) {
          const c = rectCenter(squareRect(l, seat, sq));
          assert.equal(hitTest(l, seat, c.x, c.y), sq, `${id} ${seat} ${squareName(sq)}`);
        }
      }
    }
  });

  test('all four corners inside a square still hit it', () => {
    const l = computeLayout(DESKTOP, THEMES.midnight);
    for (const sq of SQUARES) {
      const r = squareRect(l, 'red', sq);
      const e = 0.5;
      for (const [px, py] of [
        [r.x + e, r.y + e], [r.x + r.w - e, r.y + e],
        [r.x + e, r.y + r.h - e], [r.x + r.w - e, r.y + r.h - e],
      ]) {
        assert.equal(hitTest(l, 'red', px, py), sq, squareName(sq));
      }
    }
  });

  test('taps in the gap are attributed to a square, never rejected', () => {
    // On a 24px grid a rejected tap reads as an unresponsive board, which is far worse than
    // a one-pixel ambiguity at the boundary.
    const l = computeLayout(DESKTOP, THEMES.storybook);
    assert.ok(l.gap > 0);
    const a = cellRect(l, 5, 5);
    const inGap = a.x + a.w + l.gap / 2;
    assert.notEqual(hitTest(l, 'red', inGap, a.y + a.h / 2), -1);
  });

  test('taps outside the board and on cut corners return -1', () => {
    const l = computeLayout(DESKTOP, THEMES.midnight);
    assert.equal(hitTest(l, 'red', -50, -50), -1);
    assert.equal(hitTest(l, 'red', 5000, 5000), -1);
    // Grid cell (0,0) is always a cut corner.
    const corner = rectCenter(cellRect(l, 0, 0));
    assert.equal(hitTest(l, 'red', corner.x, corner.y), -1);
  });

  test('hit testing follows the board when it is panned and zoomed', () => {
    const l = computeLayout(DESKTOP, THEMES.midnight, { zoom: 2.5, panX: 120, panY: -80 });
    for (const seat of ARMIES) {
      for (const sq of SQUARES) {
        const c = rectCenter(squareRect(l, seat, sq));
        assert.equal(hitTest(l, seat, c.x, c.y), sq, `${seat} ${squareName(sq)}`);
      }
    }
  });
});

describe('camera', () => {
  test('zoom is clamped to the allowed range', () => {
    assert.equal(clampCamera({ zoom: 0.1, panX: 0, panY: 0 }).zoom, MIN_ZOOM);
    assert.equal(clampCamera({ zoom: 99, panX: 0, panY: 0 }).zoom, MAX_ZOOM);
    assert.equal(clampCamera({ zoom: 2, panX: 0, panY: 0 }).zoom, 2);
  });

  test('at rest the board cannot be panned off screen at all', () => {
    const l = computeLayout(DESKTOP, THEMES.midnight);
    const cam = clampCamera({ zoom: 1, panX: 900, panY: -900 }, l);
    assert.equal(cam.panX, 0);
    assert.equal(cam.panY, 0);
  });

  test('panning is bounded by how much of the board is off screen', () => {
    const l = computeLayout(DESKTOP, THEMES.midnight, { zoom: 2, panX: 0, panY: 0 });
    const cam = clampCamera({ zoom: 2, panX: 1e6, panY: -1e6 }, l);
    const slack = (l.board.w * (2 - 1)) / 2;
    assert.ok(Math.abs(cam.panX - slack) < 1e-9);
    assert.ok(Math.abs(cam.panY + slack) < 1e-9);
  });

  test('zoom scales the square size proportionally', () => {
    const base = computeLayout(DESKTOP, THEMES.midnight);
    const zoomed = computeLayout(DESKTOP, THEMES.midnight, { zoom: 2, panX: 0, panY: 0 });
    assert.ok(Math.abs(zoomed.square - base.square * 2) < 1e-9);
  });
});

describe('touch targets (RISKS.md R7, R8)', () => {
  test('a phone in portrait CANNOT show comfortable touch targets unzoomed', () => {
    // This is the normal mobile case, not an edge case: 14 squares across a 390px screen is
    // about 26px each, well under the 44px minimum. It is why zoom exists.
    const l = computeLayout(PHONE, THEMES.midnight);
    assert.ok(l.square < MIN_TOUCH_TARGET, `square is ${l.square.toFixed(1)}px`);
    assert.equal(needsZoomForTouch(l), true);
  });

  test('a desktop viewport does not need zoom', () => {
    const l = computeLayout(DESKTOP, THEMES.midnight);
    assert.ok(l.square >= MIN_TOUCH_TARGET);
    assert.equal(needsZoomForTouch(l), false);
  });

  test('zoomForComfortableTouch reaches the 44px target where possible', () => {
    const zoom = zoomForComfortableTouch(PHONE, THEMES.midnight);
    assert.ok(zoom > 1, 'phone must need zoom');
    const l = computeLayout(PHONE, THEMES.midnight, { zoom, panX: 0, panY: 0 });
    assert.ok(l.square >= MIN_TOUCH_TARGET - 0.001, `got ${l.square.toFixed(1)}px`);
    assert.equal(zoomForComfortableTouch(DESKTOP, THEMES.midnight), MIN_ZOOM);
  });

  test('the required zoom stays within the allowed range on a very small screen', () => {
    const zoom = zoomForComfortableTouch({ width: 320, height: 568 }, THEMES.midnight);
    assert.ok(zoom >= MIN_ZOOM && zoom <= MAX_ZOOM, `got ${zoom}`);
  });
});

describe('rect helpers', () => {
  test('insetRect keeps the rect centred', () => {
    const r = { x: 10, y: 20, w: 100, h: 100 };
    const i = insetRect(r, 0.5);
    assert.deepEqual(i, { x: 35, y: 45, w: 50, h: 50 });
    assert.deepEqual(rectCenter(i), rectCenter(r));
  });

  test('lerpRect interpolates and hits both endpoints exactly', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    const b = { x: 100, y: 50, w: 10, h: 10 };
    assert.deepEqual(lerpRect(a, b, 0), a);
    assert.deepEqual(lerpRect(a, b, 1), b);
    assert.deepEqual(lerpRect(a, b, 0.5), { x: 50, y: 25, w: 10, h: 10 });
  });

  test('IDENTITY_CAMERA really is neutral', () => {
    assert.deepEqual(IDENTITY_CAMERA, { zoom: 1, panX: 0, panY: 0 });
  });
});
