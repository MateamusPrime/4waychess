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

import { ARMIES, PIECE_VALUES, captureValue, generateLegal, isInCheck } from '@4wc/engine';
import type { Army, Move, Position } from '@4wc/engine';
import { evaluate } from './eval.ts';
import type { WeightsByArmy } from './eval.ts';
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
}

export interface SearchResult {
  move: Move | null;
  /** Score vector of the chosen line. */
  scores: Record<Army, number>;
  nodes: number;
  /** Root candidates actually considered, best first — surfaced for tests and debugging. */
  considered: { move: Move; score: number }[];
}

const MATE_PENALTY = 800;
const STALEMATE_CREDIT = 20;

interface Ctx {
  nodes: number;
  budget: number;
  opts: SearchOptions;
}

/**
 * Race-aware utility: own score minus the mean of the enemies'.
 *
 * Max-n over ABSOLUTE own score misses half the game: capturing an enemy queen lowers THEIR
 * component, not yours, so a bot maximising only its own number shrugs at free material. FFA
 * is a race — being ahead is what wins — so each node compares children by relative standing.
 * Partners (Teams) are excluded from the enemy mean; evaluate() already folds them into the
 * own-score side.
 */
function utility(v: Record<Army, number>, mover: Army, pos: Position): number {
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
function makeScored(pos: Position, m: Move): number {
  const gained = captureValue(pos, m);
  pos.points[pos.turn] += gained;
  pos.makeMove(m);
  return gained;
}

function unmakeScored(pos: Position, gained: number): void {
  pos.unmakeMove();
  pos.points[pos.turn] -= gained;
}

/** Cheap MVV ordering: big captures first, quiet moves keep generation order. */
function orderMoves(moves: Move[]): Move[] {
  return moves
    .map((m, i) => ({
      m,
      key: (m.captured !== null ? (m.capturedPromoted ? 1 : PIECE_VALUES[m.captured]) * 100 : 0) - i * 0.001,
    }))
    .sort((a, b) => b.key - a.key)
    .map((e) => e.m);
}

function maxn(pos: Position, depth: number, ctx: Ctx): Record<Army, number> {
  ctx.nodes++;
  if (depth === 0 || ctx.nodes >= ctx.budget) return evaluate(pos, ctx.opts.weights);

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

  let chosen = scored[0];
  if (opts.temperature > 0 && scored.length > 1) {
    // Softmax over the top few candidates — but only those within a fixed window of the best.
    // Temperature exists to VARY play, never to blunder: without the window, a 9-point-worse
    // move (declining a free queen) still received ~2% of the mass at easy-tier temperature,
    // and a miss like that reads as a bug rather than a weak opponent (Phase 2 gate).
    const WINDOW = 2.5; // points
    const top = scored.slice(0, 5).filter((c) => scored[0].score - c.score <= WINDOW);
    const max = top[0].score;
    const ws = top.map((c) => Math.exp((c.score - max) / opts.temperature));
    const total = ws.reduce((a, b) => a + b, 0);
    let roll = opts.rng() * total;
    for (let i = 0; i < top.length; i++) {
      roll -= ws[i];
      if (roll <= 0) {
        chosen = top[i];
        break;
      }
    }
  }

  return {
    move: chosen.move,
    scores: chosen.vector,
    nodes: ctx.nodes,
    considered: scored.map((c) => ({ move: c.move, score: c.score })),
  };
}
