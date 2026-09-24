/**
 * Coaching: move suggestions and post-game review, built on the same search the bots play with.
 *
 * Both answer a human's question rather than choosing a bot's move, so both judge with the
 * NEUTRAL default weights at temperature 0 — no personality, no variance. A hint that changed
 * with the seat's bot temperament, or a review that graded the same move differently on two
 * runs, would read as arbitrary.
 */

import type { Move, Position } from '@4wc/engine';
import { uniformWeights } from './eval.ts';
import { makeRng } from './rng.ts';
import { pickMove, scoreRootMove } from './search.ts';
import type { SearchOptions } from './search.ts';

export type Grade = 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder';

export interface Verdict {
  grade: Grade;
  /** How much worse the played move scored than the best one, in points (never negative). */
  loss: number;
  /** The engine's preferred move in the position. Equals the played move when it was best. */
  best: Move;
  bestScore: number;
  playedScore: number;
}

/**
 * Review search settings: fixed depth 4 — one full round, every opponent replies once — so
 * every move in a game is judged on the same scale, and the judge sees the three-plies-away
 * recapture that shallower searches miss. ~130ms per move on a desktop core, off the UI thread.
 *
 * Calibrated on bot games before choosing: a depth-3 judge graded 5 of 66 Hard-bot moves as
 * blunders — really the judge's shorter horizon disagreeing with a deeper player, which would
 * teach humans to distrust the review. At depth 4 (cap 8) the same moves drew 1 blunder, while
 * random moves still lost a median 2.0 points and Medium moves 0.5: clean separation.
 */
export const REVIEW_SEARCH = { depth: 4, branchCap: 8, nodeBudget: 60_000 } as const;

/**
 * Loss thresholds, in points of relative standing (the search's utility unit). A pawn is 1,
 * so an inaccuracy gives away roughly a pawn's worth and a blunder a minor piece or more.
 */
export const GRADE_THRESHOLDS = { good: 0.6, inaccuracy: 1.5, mistake: 3.5 } as const;

export function gradeLoss(loss: number, isBest: boolean): Grade {
  if (isBest) return 'best';
  if (loss < GRADE_THRESHOLDS.good) return 'good';
  if (loss < GRADE_THRESHOLDS.inaccuracy) return 'inaccuracy';
  if (loss < GRADE_THRESHOLDS.mistake) return 'mistake';
  return 'blunder';
}

const sameMove = (a: Move, b: Move): boolean =>
  a.from === b.from && a.to === b.to && a.promotion === b.promotion;

function reviewOptions(): SearchOptions {
  return {
    ...REVIEW_SEARCH, temperature: 0, weights: uniformWeights(), rng: makeRng(1),
  };
}

/**
 * Grade the move `played` in `pos` (the position BEFORE it was played, side to move = mover).
 * Returns null only when the position has no legal moves.
 */
export function reviewMove(pos: Position, played: Move): Verdict | null {
  const opts = reviewOptions();
  const result = pickMove(pos, opts);
  if (result.move === null) return null;

  const bestScore = result.considered[0].score;
  const listed = result.considered.find((c) => sameMove(c.move, played));
  const playedScore = listed !== undefined ? listed.score : scoreRootMove(pos, played, opts).score;

  // The played move can outscore the "best" when it was outside the root's candidate list
  // (the static ranking undervalued it). Then the human found something the shortlist missed.
  if (playedScore >= bestScore - 1e-9) {
    return { grade: 'best', loss: 0, best: played, bestScore: playedScore, playedScore };
  }
  const loss = bestScore - playedScore;
  return {
    grade: gradeLoss(loss, sameMove(result.considered[0].move, played)),
    loss,
    best: result.considered[0].move,
    bestScore,
    playedScore,
  };
}

/**
 * A hint: the move the engine would play for the side to move. Uses iterative deepening to
 * depth 4 within `nodeBudget` — the Hard tier's search — so a hint is at least as good as the
 * strongest regular opponent's move. Callers size the budget to the device (see apps/web).
 */
export function suggestMove(pos: Position, nodeBudget = 30_000): Move | null {
  return pickMove(pos, {
    depth: 4, iterative: true, branchCap: 10, nodeBudget,
    temperature: 0, weights: uniformWeights(), rng: makeRng(1),
  }).move;
}
