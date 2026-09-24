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
 * budget to nodes — measured at ~25-30 nodes/ms on a desktop core, dominated by evaluate()
 * (~37µs) and legal move generation (~44µs per interior node). An earlier "~1k nodes/ms"
 * rule of thumb here was off by more than an order of magnitude.
 */

import { generateLegal, isInCheck } from '@4wc/engine';
import type { Army, Move, Position } from '@4wc/engine';
import { evaluate } from './eval.ts';
import type { WeightsByArmy } from './eval.ts';
import {
  MATE_PENALTY, STALEMATE_CREDIT, makeScored, orderByThreat, orderMoves, selectFromScored,
  unmakeScored, utility,
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
  /**
   * When true, `depth` is a ceiling: search deepens 1, 2, … and stops when the node budget
   * runs out, so the budget — not a fixed depth — decides how far the bot sees. Each
   * iteration searches the previous one's best moves first.
   */
  iterative?: boolean;
  /**
   * Move ordering before `branchCap` cuts. 'threat' (default) ranks by captures, rescues and
   * attacked squares, and the root ranks every legal move by static evaluation; 'mvv' is the
   * pre-2026 ordering (captures, then generation order), kept for arena comparisons.
   */
  ordering?: 'threat' | 'mvv';
}

export interface SearchResult {
  move: Move | null;
  /** Score vector of the chosen line. */
  scores: Record<Army, number>;
  nodes: number;
  /** Root candidates actually considered, best first — surfaced for tests and debugging. */
  considered: { move: Move; score: number }[];
  /** Deepest root iteration whose scores were used (equals `depth` when not iterative). */
  depthReached: number;
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

  const ordered = (ctx.opts.ordering === 'mvv' ? orderMoves(moves) : orderByThreat(pos, moves))
    .slice(0, ctx.opts.branchCap);
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

/**
 * Rank root moves by one-ply static utility. The root is the one node where a wrong cut is
 * unrecoverable — a move dropped here is never played, however deep the search — and it is
 * visited once per decision, so every legal move gets a real evaluation before `branchCap`.
 */
function rankRoot(pos: Position, moves: Move[], ctx: Ctx): Move[] {
  const mover = pos.turn;
  const scored = moves.map((m) => {
    const gained = makeScored(pos, m);
    ctx.nodes++;
    const u = utility(evaluate(pos, ctx.opts.weights), mover, pos);
    unmakeScored(pos, gained);
    return { m, u };
  });
  scored.sort((a, b) => b.u - a.u);
  return scored.map((e) => e.m);
}

type Scored = { move: Move; score: number; vector: Record<Army, number> };

/** Choose a move for the side to move. Returns null only if there is no legal move. */
export function pickMove(pos: Position, opts: SearchOptions): SearchResult {
  const mover: Army = pos.turn;
  const moves = generateLegal(pos, mover);
  const ctx: Ctx = { nodes: 0, budget: opts.nodeBudget, opts };

  if (moves.length === 0) {
    return {
      move: null, scores: evaluate(pos, opts.weights), nodes: 0, considered: [], depthReached: 0,
    };
  }

  const cap = Math.max(opts.branchCap, 8);
  const ordered = (opts.ordering === 'mvv' ? orderMoves(moves) : rankRoot(pos, moves, ctx))
    .slice(0, cap);

  let scored: Scored[] = [];
  let depthReached = 0;
  if (opts.iterative !== true) {
    for (const m of ordered) {
      const gained = makeScored(pos, m);
      const v = maxn(pos, Math.max(0, opts.depth - 1), ctx);
      unmakeScored(pos, gained);
      scored.push({ move: m, score: utility(v, mover, pos), vector: v });
      if (ctx.nodes >= ctx.budget && scored.length >= 4) break;
    }
    scored.sort((a, b) => b.score - a.score);
    depthReached = opts.depth;
  } else {
    // Iterative deepening. A root move's score counts only if its subtree finished inside the
    // budget: a subtree cut short returns shallower leaves, which are not comparable with its
    // siblings'. Each iteration searches the last one's ranking first, so when the budget runs
    // out mid-iteration the moves already finished are the previous best candidates — and
    // their deeper scores are preferred over the shallower complete ranking, the standard
    // iterative-deepening rule.
    for (let depth = 1; depth <= Math.max(1, opts.depth); depth++) {
      const order = scored.length > 0 ? scored.map((c) => c.move) : ordered;
      const iteration: Scored[] = [];
      for (const m of order) {
        const gained = makeScored(pos, m);
        const v = maxn(pos, depth - 1, ctx);
        unmakeScored(pos, gained);
        if (ctx.nodes >= ctx.budget) break;
        iteration.push({ move: m, score: utility(v, mover, pos), vector: v });
      }
      if (iteration.length === 0) break;
      iteration.sort((a, b) => b.score - a.score);
      scored = iteration;
      depthReached = depth;
      if (iteration.length < order.length || ctx.nodes >= ctx.budget) break;
    }
    if (scored.length === 0) {
      // Budget smaller than one full depth-1 pass: fall back to the ranked order.
      scored = [{ move: ordered[0], score: 0, vector: evaluate(pos, opts.weights) }];
    }
  }

  const chosen = scored[selectFromScored(scored.map((c) => c.score), opts.temperature, opts.rng)];

  return {
    move: chosen.move,
    scores: chosen.vector,
    nodes: ctx.nodes,
    considered: scored.map((c) => ({ move: c.move, score: c.score })),
    depthReached,
  };
}

export {
  MATE_PENALTY, STALEMATE_CREDIT, makeScored, orderMoves, selectFromScored, unmakeScored,
  utility,
};
