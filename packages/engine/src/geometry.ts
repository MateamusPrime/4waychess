/**
 * Board geometry and the army-local frame.
 *
 * The board is 14x14 with the four 3x3 corners removed: 160 playable squares.
 * Files a-n map to x = 0..13; ranks 1-14 map to y = 0..13 (y = 0 is rank 1).
 *
 * THE KEY ABSTRACTION (RULES.md §3): every army sees an identical board in its own frame,
 * where ownFile runs 1..8 from that army's own left and ownRank runs 1..14 forward from its
 * own back line. In that frame every army's back line is exactly standard chess shifted
 * three files, and all four kings sit at own(5,1) — the e1 square.
 *
 * Consequence: pawn direction, promotion distance and castling are ordinary chess rules in
 * the local frame. Transform once, then apply conventional logic — rather than special-casing
 * four directions through every rule, which is where four-way engines usually go wrong.
 */

import type { Army, Square } from './types.ts';

export const W = 14;
export const NSQ = W * W;

/** Turn order: Red -> Blue -> Yellow -> Green, clockwise. (RULES.md §2) */
export const ARMIES: readonly Army[] = ['red', 'blue', 'yellow', 'green'];

export const ARMY_INDEX: Readonly<Record<Army, number>> = {
  red: 0,
  blue: 1,
  yellow: 2,
  green: 3,
};

export const FILES = 'abcdefghijklmn';

export const idx = (x: number, y: number): Square => y * W + x;
export const fileOf = (s: Square): number => s % W;
export const rankOf = (s: Square): number => (s / W) | 0;

/** A square is playable unless it falls in one of the four 3x3 corner blocks. */
export function isPlayableXY(x: number, y: number): boolean {
  if (x < 0 || x > 13 || y < 0 || y > 13) return false;
  return !((x < 3 || x > 10) && (y < 3 || y > 10));
}

/** Precomputed playability, indexed by square. Off-board squares are `false`. */
export const PLAYABLE: readonly boolean[] = (() => {
  const t = new Array<boolean>(NSQ).fill(false);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) t[idx(x, y)] = isPlayableXY(x, y);
  return t;
})();

/** Every playable square, ascending. Length 160. */
export const SQUARES: readonly Square[] = (() => {
  const out: Square[] = [];
  for (let s = 0; s < NSQ; s++) if (PLAYABLE[s]) out.push(s);
  return out;
})();

export function isPlayable(s: Square): boolean {
  return s >= 0 && s < NSQ && PLAYABLE[s];
}

/** Square colour. `a1` is dark, as in standard chess. */
export function isDarkSquare(s: Square): boolean {
  return (fileOf(s) + rankOf(s)) % 2 === 0;
}

/* ------------------------------------------------------------------ *
 * Direction vectors
 * ------------------------------------------------------------------ */

/** Board-space direction each army's pawns advance. */
export const FORWARD: Readonly<Record<Army, readonly [number, number]>> = {
  red: [0, 1],
  blue: [1, 0],
  yellow: [0, -1],
  green: [-1, 0],
};

/** Board-space direction of increasing ownFile, i.e. each army's own right. */
export const RIGHT: Readonly<Record<Army, readonly [number, number]>> = {
  red: [1, 0],
  blue: [0, -1],
  yellow: [-1, 0],
  green: [0, 1],
};

/**
 * The two board-space directions in which an army's pawns capture: forward ± right.
 * Because armies face perpendicular directions, one army's capture diagonal can cover
 * squares another army's pawns pass over — see the en passant handling in movegen.
 */
export const PAWN_CAPTURES: Readonly<Record<Army, readonly (readonly [number, number])[]>> =
  (() => {
    const out = {} as Record<Army, readonly (readonly [number, number])[]>;
    for (const a of ARMIES) {
      const [fx, fy] = FORWARD[a];
      const [rx, ry] = RIGHT[a];
      out[a] = [
        [fx + rx, fy + ry],
        [fx - rx, fy - ry],
      ];
    }
    return out;
  })();

/* ------------------------------------------------------------------ *
 * Army-local frame
 * ------------------------------------------------------------------ */

/** Convert a board square into that army's local (ownFile 1..8, ownRank 1..14) frame. */
export function toOwn(army: Army, s: Square): readonly [number, number] {
  const x = fileOf(s);
  const y = rankOf(s);
  switch (army) {
    case 'red':
      return [x - 2, y + 1];
    case 'blue':
      return [11 - y, x + 1];
    case 'yellow':
      return [11 - x, 14 - y];
    case 'green':
      return [y - 2, 14 - x];
  }
}

/** Inverse of `toOwn`. */
export function fromOwn(army: Army, ownFile: number, ownRank: number): Square {
  switch (army) {
    case 'red':
      return idx(ownFile + 2, ownRank - 1);
    case 'blue':
      return idx(ownRank - 1, 11 - ownFile);
    case 'yellow':
      return idx(11 - ownFile, 14 - ownRank);
    case 'green':
      return idx(14 - ownRank, ownFile + 2);
  }
}

/* ------------------------------------------------------------------ *
 * Square names
 * ------------------------------------------------------------------ */

export function squareName(s: Square): string {
  return FILES[fileOf(s)] + String(rankOf(s) + 1);
}

export function parseSquare(name: string): Square {
  const x = FILES.indexOf(name[0]);
  const y = Number(name.slice(1)) - 1;
  if (x < 0 || !Number.isInteger(y) || y < 0 || y > 13) {
    throw new Error(`Invalid square name: ${name}`);
  }
  return idx(x, y);
}

/* ------------------------------------------------------------------ *
 * Move offsets (board-space deltas as [dx, dy])
 * ------------------------------------------------------------------ */

export const KNIGHT_DELTAS: readonly (readonly [number, number])[] = [
  [1, 2], [2, 1], [2, -1], [1, -2],
  [-1, -2], [-2, -1], [-2, 1], [-1, 2],
];

export const ROOK_DIRS: readonly (readonly [number, number])[] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
];

export const BISHOP_DIRS: readonly (readonly [number, number])[] = [
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

export const QUEEN_DIRS: readonly (readonly [number, number])[] = [
  ...ROOK_DIRS,
  ...BISHOP_DIRS,
];

export const KING_DELTAS = QUEEN_DIRS;

/**
 * Step from a square by a delta, returning -1 if the result leaves the board.
 *
 * Note this uses x/y arithmetic rather than flat index arithmetic on purpose: the corner
 * cutouts create genuine interior edges, and flat-index offsets would silently wrap a
 * sliding piece around them.
 */
export function step(s: Square, dx: number, dy: number): Square {
  const x = fileOf(s) + dx;
  const y = rankOf(s) + dy;
  if (!isPlayableXY(x, y)) return -1;
  return idx(x, y);
}
