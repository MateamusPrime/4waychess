/**
 * Seat orientation — projecting board squares onto screen cells and back.
 *
 * The viewing player is always at the bottom of the screen (ARCHITECTURE.md D12). Each seat's
 * transform is a pure ROTATION of the default view, never a reflection: all four have
 * determinant -1, matching the default (which is itself -1 because screen rows grow downward
 * while ranks grow upward). If any transform had determinant +1 the board would be mirrored
 * for that seat and piece handedness would silently flip.
 *
 * The inverse transform matters as much as the forward one: a canvas has no DOM, so hit-testing
 * a tap is entirely our responsibility.
 */

import { ARMIES, W, fileOf, idx, isPlayable, isPlayableXY, rankOf } from '@4wc/engine';
import { normalizeZero } from './num.ts';
import type { Army, Square } from '@4wc/engine';

export interface Cell {
  col: number;
  row: number;
}

/** screenCol = a*x + b*y + c ; screenRow = d*x + e*y + f */
export interface ViewTransform {
  a: number; b: number; c: number;
  d: number; e: number; f: number;
}

export const VIEW: Readonly<Record<Army, ViewTransform>> = {
  red: { a: 1, b: 0, c: 0, d: 0, e: -1, f: 13 },
  blue: { a: 0, b: -1, c: 13, d: -1, e: 0, f: 13 },
  yellow: { a: -1, b: 0, c: 13, d: 0, e: 1, f: 0 },
  green: { a: 0, b: 1, c: 0, d: 1, e: 0, f: 0 },
};

export function determinant(v: ViewTransform): number {
  return v.a * v.e - v.b * v.d;
}

/**
 * Normalise negative zero.
 *
 * `-1 * 0` is `-0`, which is numerically fine but stringifies as "-0" — enough to break cell
 * keys, map lookups and serialised scenes in ways that are painful to trace. Kill it at source.
 */
const z = normalizeZero;

/** Board square -> screen cell for the given viewing seat. */
export function toCell(seat: Army, sq: Square): Cell {
  const v = VIEW[seat];
  const x = fileOf(sq);
  const y = rankOf(sq);
  return { col: z(v.a * x + v.b * y + v.c), row: z(v.d * x + v.e * y + v.f) };
}

/** Screen cell -> board square, or -1 if that cell is not a playable square. */
export function toSquare(seat: Army, col: number, row: number): Square {
  if (col < 0 || col > 13 || row < 0 || row > 13) return -1;
  let x: number;
  let y: number;
  switch (seat) {
    case 'red': x = col; y = 13 - row; break;
    case 'blue': x = 13 - row; y = 13 - col; break;
    case 'yellow': x = 13 - col; y = row; break;
    case 'green': x = row; y = col; break;
  }
  if (!isPlayableXY(x, y)) return -1;
  return idx(x, y);
}

/**
 * Board-space direction rotated into screen space, as a unit-ish cell delta.
 * Used for pawn-direction overlays and for animating along the board's own axes.
 */
export function directionToScreen(seat: Army, dx: number, dy: number): Cell {
  const v = VIEW[seat];
  return { col: z(v.a * dx + v.b * dy), row: z(v.d * dx + v.e * dy) };
}

/**
 * Signed quarter-turns of the board IMAGE that carry `from`'s view onto `to`'s view.
 * Positive is clockwise on screen; the result always takes the short way round.
 *
 * The sign is the OPPOSITE of the seat-order direction, and getting this wrong is a visible
 * bug: seats advance clockwise around the table (Red bottom → Blue left → Yellow top → Green
 * right), but carrying the NEXT seat to the bottom of the screen rotates the board image
 * ANTICLOCKWISE — Blue sits on the left edge, and it is the anticlockwise turn that brings the
 * left edge to the bottom. Shipping the naive sign made the board spin +90° and then snap to
 * the −90° view: a 180° flash at the end of every hand-off.
 *
 * Verified algebraically: mapping Red-view cells (c,r) to Blue-view cells gives (r, 13−c),
 * which is a 90° anticlockwise rotation of the image. The continuity test in scene.test.ts
 * pins the animated end frame to the settled view so this cannot regress silently.
 */
export function rotationSteps(from: Army, to: Army): number {
  const order: readonly Army[] = ARMIES;
  const delta = (order.indexOf(to) - order.indexOf(from) + 4) % 4;
  if (delta === 0) return 0;
  if (delta === 1) return -1; // next seat: one quarter-turn anticlockwise
  if (delta === 2) return -2; // opposite seat: half turn (direction kept consistent)
  return 1;                   // previous seat: one quarter-turn clockwise
}

/** Total board-image rotation in degrees for a seat's view, relative to Red's. */
export function seatAngle(seat: Army): number {
  return z(-ARMIES.indexOf(seat) * 90);
}

/** Screen cells that are playable for this seat, in row-major order. */
export function visibleCells(seat: Army): { cell: Cell; square: Square }[] {
  const out: { cell: Cell; square: Square }[] = [];
  for (let row = 0; row < W; row++) {
    for (let col = 0; col < W; col++) {
      const sq = toSquare(seat, col, row);
      if (sq >= 0) out.push({ cell: { col, row }, square: sq });
    }
  }
  return out;
}

/**
 * Where coordinate labels belong for this seat: the bottom-most visible cell in each column
 * gets a file label, the left-most visible cell in each row gets a rank label. Computed rather
 * than hard-coded because the corner cutouts make the visible edge ragged, and it moves with
 * every rotation.
 */
export interface CoordLabels {
  files: { cell: Cell; square: Square }[];
  ranks: { cell: Cell; square: Square }[];
}

export function coordLabels(seat: Army): CoordLabels {
  const files: { cell: Cell; square: Square }[] = [];
  const ranks: { cell: Cell; square: Square }[] = [];

  for (let col = 0; col < W; col++) {
    for (let row = W - 1; row >= 0; row--) {
      const sq = toSquare(seat, col, row);
      if (sq >= 0) { files.push({ cell: { col, row }, square: sq }); break; }
    }
  }
  for (let row = 0; row < W; row++) {
    for (let col = 0; col < W; col++) {
      const sq = toSquare(seat, col, row);
      if (sq >= 0) { ranks.push({ cell: { col, row }, square: sq }); break; }
    }
  }
  return { files, ranks };
}

/** Sanity guard used by tests and by the renderer in development builds. */
export function assertViewIsRotation(seat: Army): void {
  const det = determinant(VIEW[seat]);
  if (det !== -1) {
    throw new Error(
      `View transform for ${seat} has determinant ${det}; expected -1. ` +
      'A different sign means the board is mirrored for this seat.',
    );
  }
}

export { isPlayable };
