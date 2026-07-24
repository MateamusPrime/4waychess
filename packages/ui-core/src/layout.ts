/**
 * Pixel layout.
 *
 * Two things drive this: the board is 14x14 (so squares are small — about 24px at phone width,
 * RISKS.md R8), and a canvas has no DOM, so hit-testing taps is entirely ours to implement
 * (RISKS.md R7).
 *
 * Zoom and pan live here too. On mobile the primary interaction is tap-to-select then
 * tap-to-move, NOT drag, precisely so that one-finger drag can be unambiguously reserved for
 * panning the board.
 */

import { W } from '@4wc/engine';
import type { Army, Square } from '@4wc/engine';
import type { Theme } from './themes.ts';
import { toCell, toSquare } from './view.ts';
import { clamp } from './num.ts';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Viewport {
  width: number;
  height: number;
  /** Device pixel ratio. Layout works in CSS pixels; the renderer scales. */
  dpr?: number;
}

export interface Camera {
  /** 1 = board fits the viewport. Clamped to [MIN_ZOOM, MAX_ZOOM]. */
  zoom: number;
  /** Pan offset in CSS pixels, applied after zoom. */
  panX: number;
  panY: number;
}

export const IDENTITY_CAMERA: Camera = { zoom: 1, panX: 0, panY: 0 };
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

export interface BoardLayout {
  /** Outer board box including padding. */
  board: Rect;
  /** Inner grid box, excluding padding. */
  grid: Rect;
  square: number;
  gap: number;
  pad: number;
  radius: number;
  camera: Camera;
}

export function clampCamera(cam: Camera, layout?: BoardLayout): Camera {
  const zoom = clamp(cam.zoom, MIN_ZOOM, MAX_ZOOM);
  if (layout === undefined) return { zoom, panX: cam.panX, panY: cam.panY };
  // Never allow panning the board away from the viewport: at zoom 1 pan is pinned to 0, and
  // beyond that it is bounded by how much of the board is off-screen.
  const slackX = (layout.board.w * (zoom - 1)) / 2;
  const slackY = (layout.board.h * (zoom - 1)) / 2;
  return {
    zoom,
    panX: clamp(cam.panX, -slackX, slackX),
    panY: clamp(cam.panY, -slackY, slackY),
  };
}

export function computeLayout(
  viewport: Viewport,
  theme: Theme,
  camera: Camera = IDENTITY_CAMERA,
): BoardLayout {
  const cam = clampCamera(camera);
  const shortest = Math.max(1, Math.min(viewport.width, viewport.height));

  // Solve for square size: 14 squares + 13 gaps + 2 pads must fill the box, where gaps and
  // pads are expressed as ratios of the square itself.
  const units = W + (W - 1) * theme.gapRatio + 2 * theme.padRatio;
  const baseSquare = shortest / units;
  const square = baseSquare * cam.zoom;
  const gap = square * theme.gapRatio;
  const pad = square * theme.padRatio;
  const radius = square * theme.radiusRatio;

  const gridW = W * square + (W - 1) * gap;
  const boardW = gridW + 2 * pad;

  const bx = (viewport.width - boardW) / 2 + cam.panX;
  const by = (viewport.height - boardW) / 2 + cam.panY;

  return {
    board: { x: bx, y: by, w: boardW, h: boardW },
    grid: { x: bx + pad, y: by + pad, w: gridW, h: gridW },
    square,
    gap,
    pad,
    radius,
    camera: cam,
  };
}

/** Pixel rect of a screen cell. */
export function cellRect(layout: BoardLayout, col: number, row: number): Rect {
  const step = layout.square + layout.gap;
  return {
    x: layout.grid.x + col * step,
    y: layout.grid.y + row * step,
    w: layout.square,
    h: layout.square,
  };
}

/** Pixel rect of a board square, for the given viewing seat. */
export function squareRect(layout: BoardLayout, seat: Army, sq: Square): Rect {
  const { col, row } = toCell(seat, sq);
  return cellRect(layout, col, row);
}

export function rectCenter(r: Rect): { x: number; y: number } {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/**
 * Which board square is under this pixel, or -1.
 *
 * Taps land in the gap between squares surprisingly often on a 24px grid, so the gap is
 * attributed to the nearer square rather than rejected — a rejected tap reads as an
 * unresponsive board, which is much worse than a 1px ambiguity.
 */
export function hitTest(layout: BoardLayout, seat: Army, px: number, py: number): Square {
  const step = layout.square + layout.gap;
  if (step <= 0) return -1;
  const col = Math.floor((px - layout.grid.x) / step);
  const row = Math.floor((py - layout.grid.y) / step);
  if (col < 0 || col > 13 || row < 0 || row > 13) return -1;
  return toSquare(seat, col, row);
}

/** Interpolate between two squares in pixel space — the basis of move animation. */
export function lerpRect(from: Rect, to: Rect, t: number): Rect {
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    w: from.w + (to.w - from.w) * t,
    h: from.h + (to.h - from.h) * t,
  };
}

/** Inset a rect by a fraction of its own size, keeping it centred. */
export function insetRect(r: Rect, fraction: number): Rect {
  const dx = (r.w * (1 - fraction)) / 2;
  const dy = (r.h * (1 - fraction)) / 2;
  return { x: r.x + dx, y: r.y + dy, w: r.w * fraction, h: r.h * fraction };
}

/**
 * Is the board too small to be comfortably tapped?
 *
 * 44px is the widely used minimum touch target. On a 14x14 board that needs a ~620px viewport,
 * which no phone has in portrait — so this returning true is the NORMAL mobile case, and it is
 * what tells the UI to offer zoom rather than pretending the board is usable as-is.
 */
export const MIN_TOUCH_TARGET = 44;

export function needsZoomForTouch(layout: BoardLayout): boolean {
  return layout.square < MIN_TOUCH_TARGET;
}

/** Zoom level at which squares reach a comfortable touch size. */
export function zoomForComfortableTouch(viewport: Viewport, theme: Theme): number {
  const base = computeLayout(viewport, theme, IDENTITY_CAMERA);
  if (base.square <= 0) return MIN_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, MIN_TOUCH_TARGET / base.square));
}
