/**
 * Accessibility.
 *
 * A canvas has no DOM, so choosing Skia means keyboard navigation, focus order and
 * screen-reader text are OURS TO BUILD rather than inherited (ARCHITECTURE.md §7). This file is
 * that obligation being met in Phase 1 rather than retrofitted later, which is far worse.
 *
 * Cursor movement happens in SCREEN space, not board space: arrow keys must feel correct
 * whichever seat is at the bottom, so "right" always means right on screen. Unplayable cells in
 * the corner cutouts are skipped over rather than blocking movement.
 */

import { ARMIES, W, squareName } from '@4wc/engine';
import type { Army, Move, PieceType, Position, Square } from '@4wc/engine';
import { toCell, toSquare } from './view.ts';

export type Direction = 'up' | 'down' | 'left' | 'right';

const DELTAS: Readonly<Record<Direction, readonly [number, number]>> = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

/**
 * Step the cursor one playable square in a screen direction.
 *
 * Keeps stepping past cut corners so the board never feels blocked; returns the original square
 * if the whole line runs off the board.
 */
export function moveCursor(seat: Army, from: Square, dir: Direction): Square {
  const [dc, dr] = DELTAS[dir];
  const start = toCell(seat, from);
  let col = start.col + dc;
  let row = start.row + dr;
  for (let i = 0; i < W; i++) {
    if (col < 0 || col > 13 || row < 0 || row > 13) return from;
    const sq = toSquare(seat, col, row);
    if (sq >= 0) return sq;
    col += dc;
    row += dr;
  }
  return from;
}

/** Where the cursor should land when the board first receives focus. */
export function defaultCursor(pos: Position, seat: Army): Square {
  const king = pos.kingSquare(seat);
  if (king >= 0) return king;
  for (let s = 0; s < pos.board.length; s++) {
    const p = pos.at(s);
    if (p !== null && p.army === seat) return s;
  }
  return -1;
}

/* ------------------------------------------------------------------ *
 * Spoken descriptions
 * ------------------------------------------------------------------ */

const PIECE_NAMES: Readonly<Record<PieceType, string>> = {
  p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king',
};

export function pieceName(type: PieceType, promoted = false): string {
  if (type === 'q' && promoted) return 'promoted queen';
  return PIECE_NAMES[type];
}

/** "red rook on d1", or "d1, empty". */
export function describeSquare(pos: Position, sq: Square): string {
  const name = squareName(sq);
  const p = pos.at(sq);
  if (p === null) return `${name}, empty`;
  const dead = pos.isActive(p.army) ? '' : ', eliminated';
  return `${p.army} ${pieceName(p.type, p.promoted)} on ${name}${dead}`;
}

/** Spoken form of a move, including what it captures and how it promotes. */
export function describeMove(pos: Position, move: Move): string {
  const mover = pos.at(move.from);
  const who = mover === null ? '' : `${mover.army} `;
  const what = pieceName(move.piece);
  let text: string;

  if (move.castle === 'short') text = `${who}castles short`;
  else if (move.castle === 'long') text = `${who}castles long`;
  else text = `${who}${what} ${squareName(move.from)} to ${squareName(move.to)}`;

  if (move.captured !== null && move.capturedArmy !== null) {
    const ep = move.capturedSq !== null && move.capturedSq !== move.to;
    const victim = pieceName(move.captured, move.capturedPromoted);
    text += `, capturing ${move.capturedArmy} ${victim}${ep ? ' en passant' : ''}`;
  }
  if (move.promotion !== null) {
    text += `, promoting to ${PIECE_NAMES[move.promotion as PieceType]}`;
  }
  return text;
}

/** Announcement for the start of a turn, including standing checks. */
export function describeTurn(pos: Position, checkedArmies: readonly Army[] = []): string {
  const parts = [`${pos.turn} to move`];
  if (checkedArmies.includes(pos.turn)) parts.push('you are in check');
  const others = checkedArmies.filter((a) => a !== pos.turn);
  if (others.length > 0) parts.push(`${others.join(' and ')} in check`);
  return parts.join('. ');
}

/** Running score line, ordered highest first — the FFA win condition made audible. */
export function describeScores(pos: Position): string {
  return [...ARMIES]
    .sort((a, b) => pos.points[b] - pos.points[a])
    .map((a) => `${a} ${pos.points[a]}`)
    .join(', ');
}

/** Which armies are still playing, and which are out. */
export function describeArmies(pos: Position): string {
  const active = ARMIES.filter((a) => pos.isActive(a));
  const out = ARMIES.filter((a) => !pos.isActive(a));
  const parts = [`${active.length} armies playing: ${active.join(', ')}`];
  if (out.length > 0) {
    parts.push(out.map((a) => `${a} ${pos.status[a]}`).join(', '));
  }
  return parts.join('. ');
}

/** Everything a screen-reader user needs on first landing on the board. */
export function describeBoard(pos: Position, seat: Army): string {
  return [
    `Four-way chess. 14 by 14 board, 160 squares, corners removed.`,
    `You are ${seat}.`,
    describeArmies(pos),
    describeTurn(pos),
    `Scores: ${describeScores(pos)}.`,
  ].join(' ');
}

/** Legal destinations from a square, spoken. */
export function describeTargets(pos: Position, moves: readonly Move[]): string {
  if (moves.length === 0) return 'no legal moves';
  const dests = moves.map((m) => squareName(m.to) + (m.captured === null ? '' : ' capture'));
  return `${moves.length} moves: ${dests.join(', ')}`;
}
