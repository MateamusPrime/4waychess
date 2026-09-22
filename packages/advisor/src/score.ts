/**
 * Pure score arithmetic: perspectives, win probability, move classification, accuracy.
 *
 * The win-probability curve and the classification / accuracy formulas follow the ones
 * Lichess publishes for its computer analysis, so the verdicts here line up with what a
 * player already knows from lichess.org. Centipawns are a poor training signal on their own:
 * dropping 100cp from +8 to +7 is nothing, dropping 100cp from +0.5 to -0.5 is the game.
 * Win probability makes those two cases look as different as they are.
 */

import type { Score } from './uci.ts';

export type Color = 'w' | 'b';

export type Classification = 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder';

/** Flip a score to the other side's perspective. */
export function negate(score: Score): Score {
  return { type: score.type, value: score.value === 0 ? 0 : -score.value };
}

/** UCI scores are for the side to move; convert one to White's point of view. */
export function toWhite(score: Score, sideToMove: Color): Score {
  return sideToMove === 'w' ? score : negate(score);
}

/**
 * Winning chances in [-1, 1] for the side the score belongs to. Mate is ±1. This is the Lichess
 * curve: `2 / (1 + exp(-0.00368208 * cp)) - 1`.
 */
export function winningChances(score: Score): number {
  if (score.type === 'mate') return score.value > 0 ? 1 : -1;
  const cp = Math.max(-1000, Math.min(1000, score.value));
  return 2 / (1 + Math.exp(-0.00368208 * cp)) - 1;
}

/** Win probability as a percentage in [0, 100] for the side the score belongs to. */
export function winPct(score: Score): number {
  return 50 + 50 * winningChances(score);
}

/**
 * Classify a move from the mover's win percentage before and after it. Thresholds are the
 * Lichess ones (winning-chance drops of 0.1 / 0.2 / 0.3, i.e. 5 / 10 / 15 points).
 */
export function classify(pctBefore: number, pctAfter: number, playedBest: boolean): Classification {
  if (playedBest) return 'best';
  const drop = pctBefore - pctAfter;
  if (drop >= 15) return 'blunder';
  if (drop >= 10) return 'mistake';
  if (drop >= 5) return 'inaccuracy';
  return 'good';
}

/**
 * Per-move accuracy in [0, 100] from the mover's win percentage before and after. Lichess:
 * `103.1668 * exp(-0.04354 * drop) - 3.1669`, clamped.
 */
export function moveAccuracy(pctBefore: number, pctAfter: number): number {
  const drop = Math.max(0, pctBefore - pctAfter);
  const raw = 103.1668 * Math.exp(-0.04354 * drop) - 3.1669;
  return Math.round(Math.max(0, Math.min(100, raw)) * 100) / 100;
}

/** Centipawn loss of a move; mates are mapped to ±10000 so the number stays finite. */
export function cpLoss(before: Score, after: Score): number {
  const toCp = (s: Score): number => (s.type === 'cp' ? s.value : (s.value > 0 ? 10000 : -10000));
  return Math.max(0, toCp(before) - toCp(after));
}

/** `+0.35`, `-1.20`, `#3`, `-#2`. Mate-in-0 (already mated) prints as `#0`. */
export function formatScore(score: Score): string {
  if (score.type === 'mate') return score.value < 0 ? `-#${-score.value}` : `#${score.value}`;
  const pawns = score.value / 100;
  return (pawns >= 0 ? '+' : '') + pawns.toFixed(2);
}

/** Terminal score for a side to move with no legal moves. */
export function terminalScore(inCheck: boolean): Score {
  return inCheck ? { type: 'mate', value: 0 } : { type: 'cp', value: 0 };
}
