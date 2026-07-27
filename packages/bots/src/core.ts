/**
 * Shared search primitives — used by the classic engine, the capture rollout, and the
 * experimental deep engine. Split out so search.ts and rollout.ts need not import each other.
 */

import { ARMIES, PIECE_VALUES, captureValue } from '@4wc/engine';
import type { Army, Move, Position } from '@4wc/engine';
import type { Rng } from './rng.ts';

export const MATE_PENALTY = 800;
export const STALEMATE_CREDIT = 20;

/**
 * Race-aware utility: own score minus the mean of the enemies'.
 *
 * Max-n over ABSOLUTE own score misses half the game: capturing an enemy queen lowers THEIR
 * component, not yours, so a bot maximising only its own number shrugs at free material. FFA
 * is a race — being ahead is what wins — so each node compares children by relative standing.
 * Partners (Teams) are excluded from the enemy mean; evaluate() already folds them into the
 * own-score side.
 */
export function utility(v: Record<Army, number>, mover: Army, pos: Position): number {
  let sum = 0;
  let n = 0;
  for (const a of ARMIES) {
    if (!pos.areEnemies(mover, a)) continue;
    sum += v[a];
    n++;
  }
  return n === 0 ? v[mover] : v[mover] - sum / n;
}

/**
 * Make a move with its FFA capture points credited to the mover.
 *
 * Position.makeMove deliberately does NOT bank points — that is the Game layer's job — so a
 * search that only makes moves never sees the single most important term in the score race.
 * This was found live: a bot offered a hanging queen scored the capture a mere +0.5 over a
 * king shuffle, because only the victim's material term moved. Crediting captureValue here
 * (and un-crediting on unmake) lets the evaluation see points exactly as the Game will award
 * them — including dead pieces worth zero, 1-point promoted queens, and the +20 king.
 */
export function makeScored(pos: Position, m: Move): number {
  const gained = captureValue(pos, m);
  pos.points[pos.turn] += gained;
  pos.makeMove(m);
  return gained;
}

export function unmakeScored(pos: Position, gained: number): void {
  pos.unmakeMove();
  pos.points[pos.turn] -= gained;
}

/** Cheap MVV ordering: big captures first, quiet moves keep generation order. */
export function orderMoves(moves: Move[]): Move[] {
  return moves
    .map((m, i) => ({
      m,
      key: (m.captured !== null ? (m.capturedPromoted ? 1 : PIECE_VALUES[m.captured]) * 100 : 0) - i * 0.001,
    }))
    .sort((a, b) => b.key - a.key)
    .map((e) => e.m);
}

/**
 * Root candidate selection, shared by every engine. Scores must be sorted descending; returns
 * the chosen index.
 *
 * Softmax over the top few candidates — but only those within a fixed window of the best.
 * Temperature exists to VARY play, never to blunder: without the window, a 9-point-worse move
 * (declining a free queen) still received ~2% of the mass at easy-tier temperature, and a miss
 * like that reads as a bug rather than a weak opponent (Phase 2 gate).
 */
export function selectFromScored(scores: number[], temperature: number, rng: Rng): number {
  if (temperature <= 0 || scores.length < 2) return 0;
  const WINDOW = 2.5; // points
  const top = scores.slice(0, 5).filter((s) => scores[0] - s <= WINDOW);
  const ws = top.map((s) => Math.exp((s - top[0]) / temperature));
  const total = ws.reduce((a, b) => a + b, 0);
  let roll = rng() * total;
  for (let i = 0; i < top.length; i++) {
    roll -= ws[i];
    if (roll <= 0) return i;
  }
  return 0;
}
