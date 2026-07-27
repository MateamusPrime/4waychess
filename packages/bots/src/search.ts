/**
 * Max-n search, shallow by design.
 *
 * Classical deep minimax dies on this game: 160 squares, four movers, branching factor 30-60.
 * The product answer (ROADMAP Phase 2) is heuristic evaluation plus SHALLOW max-n — at each
 * node the army to move picks the child maximising its own component of the score vector.
 * Personality comes from the evaluation weights, variance from softmax at the root.
 *
 * Budgets are in NODES, not milliseconds: the package has no clock (enforced by the
 * architecture test), which keeps search deterministic under a seed. Callers map their time
 * budget to nodes — on current hardware ~1k nodes/ms is a safe rule of thumb.
 */

import { generateLegal, isInCheck } from '@4wc/engine';
import type { Army, Move, Position } from '@4wc/engine';
import { evaluate } from './eval.ts';
import type { WeightsByArmy } from './eval.ts';
import {
  MATE_PENALTY, STALEMATE_CREDIT, makeScored, orderMoves, selectFromScored, unmakeScored,
  utility,
} from './core.ts';
import { captureRollout } from './rollout.ts';
import type { Rng } from './rng.ts';

export interface SearchOptions {
  /** Plies to look ahead. One ply = one army's move. 2-3 is the practical range. */
  depth: number;
  /** Hard cap on positions evaluated. */
  nodeBudget: number;
  /** After ordering, only this many moves are searched per node. Tames the branching factor. */
  branchCap: number;
  weights: WeightsByArmy;
  /**
   * Root selection temperature. 0 = always the best move; higher values soften toward other
   * good moves, which is how difficulty tiers vary without playing outright blunders.
   */
  temperature: number;
  rng: Rng;
  /**
   * When > 0, leaves are settled by a capture rollout in true turn order instead of a bare
   * eval — the arena-validated piece of the deep-search experiment. 0 keeps bare evals.
   */
  rolloutPlies?: number;
}

export interface SearchResult {
  move: Move | null;
  /** Score vector of the chosen line. */
  scores: Record<Army, number>;
  nodes: number;
  /** Root candidates actually considered, best first — surfaced for tests and debugging. */
  considered: { move: Move; score: number }[];
}

interface Ctx {
  nodes: number;
  budget: number;
  opts: SearchOptions;
}

function leafEval(pos: Position, ctx: Ctx): Record<Army, number> {
  const plies = ctx.opts.rolloutPlies ?? 0;
  if (plies <= 0) return evaluate(pos, ctx.opts.weights);
  return captureRollout(pos, ctx.opts.weights, plies, ctx);
}

function maxn(pos: Position, depth: number, ctx: Ctx): Record<Army, number> {
  ctx.nodes++;
  if (depth === 0 || ctx.nodes >= ctx.budget) return leafEval(pos, ctx);

  const mover: Army = pos.turn;
  const moves = generateLegal(pos, mover);

  if (moves.length === 0) {
    // Terminal for this mover. The Game layer would eliminate them (RULES.md §8); at these
    // depths approximating elimination as a large score change is sufficient and much cheaper.
    const v = evaluate(pos, ctx.opts.weights);
    if (isInCheck(pos, mover)) v[mover] -= MATE_PENALTY;
    else v[mover] += STALEMATE_CREDIT * ctx.opts.weights[mover].points;
    return v;
  }

  const ordered = orderMoves(moves).slice(0, ctx.opts.branchCap);
  let best: Record<Army, number> | null = null;
  let bestU = -Infinity;
  for (const m of ordered) {
    const gained = makeScored(pos, m);
    const v = maxn(pos, depth - 1, ctx);
    unmakeScored(pos, gained);
    const u = utility(v, mover, pos);
    if (best === null || u > bestU) {
      best = v;
      bestU = u;
    }
    if (ctx.nodes >= ctx.budget) break;
  }
  return best ?? evaluate(pos, ctx.opts.weights);
}

/** Choose a move for the side to move. Returns null only if there is no legal move. */
export function pickMove(pos: Position, opts: SearchOptions): SearchResult {
  const mover: Army = pos.turn;
  const moves = generateLegal(pos, mover);
  const ctx: Ctx = { nodes: 0, budget: opts.nodeBudget, opts };

  if (moves.length === 0) {
    return { move: null, scores: evaluate(pos, opts.weights), nodes: 0, considered: [] };
  }

  const ordered = orderMoves(moves).slice(0, Math.max(opts.branchCap, 8));
  const scored: { move: Move; score: number; vector: Record<Army, number> }[] = [];

  for (const m of ordered) {
    const gained = makeScored(pos, m);
    const v = maxn(pos, Math.max(0, opts.depth - 1), ctx);
    unmakeScored(pos, gained);
    scored.push({ move: m, score: utility(v, mover, pos), vector: v });
    if (ctx.nodes >= ctx.budget && scored.length >= 4) break;
  }

  scored.sort((a, b) => b.score - a.score);
  const chosen = scored[selectFromScored(scored.map((c) => c.score), opts.temperature, opts.rng)];

  return {
    move: chosen.move,
    scores: chosen.vector,
    nodes: ctx.nodes,
    considered: scored.map((c) => ({ move: c.move, score: c.score })),
  };
}

export {
  MATE_PENALTY, STALEMATE_CREDIT, makeScored, orderMoves, selectFromScored, unmakeScored,
  utility,
};
