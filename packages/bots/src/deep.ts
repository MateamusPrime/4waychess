/**
 * Deep search: Best-Reply layers, capture resolution at the horizon, a transposition table,
 * and iterative deepening. This is "Lever 1" — strength from search engineering, no training.
 *
 * WHY NOT DEEPER MAX-N: expanding all three opponents costs branching^3 per round, so classic
 * max-n never sees the root's own SECOND move inside any affordable budget. Best-Reply Search
 * (Schadd & Winands) collapses the three opponent plies into ONE layer: generate candidate
 * replies for every enemy army, keep only the single most damaging one, then it is the root's
 * turn again. The searched positions are slightly unreal (turn order is compressed), but the
 * root now alternates own-move / worst-threat, seeing its own follow-ups two and three moves
 * ahead — which classic max-n structurally cannot.
 *
 * HORIZON: leaves are settled by a capture rollout in TRUE turn order — each army in sequence
 * plays its best immediate capture if that capture improves its own utility, else passes.
 * This resolves the "recaptures live three plies away" horizon (the queen-into-pawn class of
 * blunder) exactly, instead of approximating it with the static hanging term alone.
 *
 * Budgets are node counts (one node = one make), no clock, seeded randomness only — the same
 * determinism contract as the classic search, enforced by the architecture test.
 */

import { ARMIES, generateLegal, isInCheck } from '@4wc/engine';
import type { Army, Move, Position } from '@4wc/engine';
import { evaluate } from './eval.ts';
import type { WeightsByArmy } from './eval.ts';
import {
  MATE_PENALTY, STALEMATE_CREDIT, makeScored, orderMoves, selectFromScored, unmakeScored,
  utility,
} from './core.ts';
import type { Rng } from './rng.ts';

export interface DeepOptions {
  /** Iterative-deepening ceiling, counted in ROOT moves (own moves ahead). */
  maxDepth: number;
  /** Hard cap on nodes (makes). The real limiter; depth is a ceiling, not a promise. */
  nodeBudget: number;
  /** Root and own-layer candidates after ordering. */
  branchCap: number;
  /** Candidate replies per enemy army at a best-reply layer. */
  replyCap: number;
  /** Ply cap for the capture rollout at leaves. */
  rolloutPlies: number;
  weights: WeightsByArmy;
  temperature: number;
  rng: Rng;
  /** Disable the transposition table (for A/B testing). */
  noTT?: boolean;
}

export interface DeepResult {
  move: Move | null;
  utility: number;
  nodes: number;
  /** Deepest fully completed iteration. */
  depthReached: number;
  considered: { move: Move; score: number }[];
}

interface Ctx {
  nodes: number;
  budget: number;
  opts: DeepOptions;
  root: Army;
  tt: Map<string, { depth: number; util: number }>;
}

/* ------------------------------------------------------------------ *
 * Capture rollout — horizon resolution in true turn order
 * ------------------------------------------------------------------ */

type RolloutStep =
  | { kind: 'move'; gained: number }
  | { kind: 'pass'; prevTurn: Army };

/**
 * Resolve pending exchanges: in real turn order, each army plays its best immediate capture
 * when that capture improves its own utility, otherwise passes (turn skip — legal here even
 * though it is not a legal game move, because this is analysis of exchange sequences, not
 * play). Passing matters enormously in four-way chess: the recapturing army is usually two
 * seats away, and without a pass mechanism the rollout would end at the first quiet army and
 * hide exactly the exchanges it exists to reveal.
 */
function captureRollout(pos: Position, ctx: Ctx): Record<Army, number> {
  const steps: RolloutStep[] = [];

  for (let ply = 0; ply < ctx.opts.rolloutPlies && ctx.nodes < ctx.budget; ply++) {
    const mover = pos.turn;
    const captures = orderMoves(
      generateLegal(pos, mover).filter((m) => m.captured !== null),
    ).slice(0, 2);

    let played = false;
    if (captures.length > 0) {
      const standPat = utility(evaluate(pos, ctx.opts.weights), mover, pos);
      for (const m of captures) {
        const gained = makeScored(pos, m);
        ctx.nodes++;
        const after = utility(evaluate(pos, ctx.opts.weights), mover, pos);
        if (after > standPat + 1e-9) {
          steps.push({ kind: 'move', gained });
          played = true;
          break;
        }
        unmakeScored(pos, gained);
      }
    }

    if (!played) {
      // Pass: hand the turn on without moving. Every army passing in sequence ends the rollout.
      const prevTurn = mover;
      const next = pos.nextActive(mover);
      if (next === mover) break;
      pos.turn = next;
      steps.push({ kind: 'pass', prevTurn });
      const allPassed = steps.length >= pos.activeArmies().length
        && steps.slice(-pos.activeArmies().length).every((s) => s.kind === 'pass');
      if (allPassed) break;
    }
  }

  const settled = evaluate(pos, ctx.opts.weights);

  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.kind === 'move') unmakeScored(pos, s.gained);
    else pos.turn = s.prevTurn;
  }
  return settled;
}

/* ------------------------------------------------------------------ *
 * Best-reply layers
 * ------------------------------------------------------------------ */

function leafUtility(pos: Position, ctx: Ctx): number {
  return utility(captureRollout(pos, ctx), ctx.root, pos);
}

/** Own layer: the root army picks its best move. */
function rootLayer(pos: Position, depthLeft: number, ctx: Ctx): number {
  if (depthLeft === 0 || ctx.nodes >= ctx.budget) return leafUtility(pos, ctx);

  const key = ctx.opts.noTT === true ? null : `${pos.positionKey()}|${depthLeft}`;
  if (key !== null) {
    const hit = ctx.tt.get(key);
    if (hit !== undefined && hit.depth >= depthLeft) return hit.util;
  }

  const moves = generateLegal(pos, ctx.root);
  if (moves.length === 0) {
    const v = evaluate(pos, ctx.opts.weights);
    v[ctx.root] += isInCheck(pos, ctx.root)
      ? -MATE_PENALTY
      : STALEMATE_CREDIT * ctx.opts.weights[ctx.root].points;
    return utility(v, ctx.root, pos);
  }

  let best = -Infinity;
  for (const m of orderMoves(moves).slice(0, ctx.opts.branchCap)) {
    const gained = makeScored(pos, m);
    ctx.nodes++;
    const u = replyLayer(pos, depthLeft, ctx);
    unmakeScored(pos, gained);
    if (u > best) best = u;
    if (ctx.nodes >= ctx.budget) break;
  }

  if (key !== null && best > -Infinity) ctx.tt.set(key, { depth: depthLeft, util: best });
  return best;
}

/**
 * Rational-reply layer: one layer standing in for all three opponents' turns.
 *
 * The first version was textbook BRS — recurse on EVERY enemy candidate and take the worst
 * for the root. The arena flunked it decisively (30.8 vs 44.6 points against classic max-n at
 * equal budget): full paranoia models three opponents colluding against you, and in an FFA
 * points race real opponents mostly ignore you and farm each other — so the paranoid root
 * plays passively and loses the race, while the full-width layer burned so much budget that
 * depth-2 iterations never completed.
 *
 * The fix models opponents as RATIONAL, not hostile: statically score every enemy candidate
 * once (one eval yields both the replier's own utility and the root's), then recurse only on
 * each enemy's own best move — their actual plan — plus the single most root-damaging
 * candidate as tactical insurance (that channel is what still catches forks and mate threats
 * aimed at us). At most four recursions per layer instead of fifteen: a truer opponent model
 * that is simultaneously ~4x cheaper, which is what lets real depth materialise in-budget.
 */
function replyLayer(pos: Position, depthLeft: number, ctx: Ctx): number {
  if (ctx.nodes >= ctx.budget) return leafUtility(pos, ctx);

  interface Candidate {
    move: Move;
    ownStatic: number;
    rootStatic: number;
    enemy: Army;
  }
  const all: Candidate[] = [];

  for (const enemy of ARMIES) {
    if (!pos.areEnemies(ctx.root, enemy) || !pos.isActive(enemy)) continue;
    const replies = orderMoves(generateLegal(pos, enemy)).slice(0, ctx.opts.replyCap);
    for (const m of replies) {
      const gained = makeScored(pos, m);
      ctx.nodes++;
      const v = evaluate(pos, ctx.opts.weights);
      unmakeScored(pos, gained);
      all.push({
        move: m,
        ownStatic: utility(v, enemy, pos),
        rootStatic: utility(v, ctx.root, pos),
        enemy,
      });
      if (ctx.nodes >= ctx.budget) break;
    }
    if (ctx.nodes >= ctx.budget) break;
  }

  if (all.length === 0) return rootLayer(pos, depthLeft - 1, ctx);

  // Each enemy's own best plan, plus the globally scariest candidate for us.
  const chosen = new Set<Move>();
  for (const enemy of new Set(all.map((c) => c.enemy))) {
    const own = all.filter((c) => c.enemy === enemy);
    chosen.add(own.reduce((b, c) => (c.ownStatic > b.ownStatic ? c : b)).move);
  }
  chosen.add(all.reduce((b, c) => (c.rootStatic < b.rootStatic ? c : b)).move);

  let worst = Infinity;
  for (const m of chosen) {
    const gained = makeScored(pos, m);
    ctx.nodes++;
    const u = rootLayer(pos, depthLeft - 1, ctx);
    unmakeScored(pos, gained);
    if (u < worst) worst = u;
    if (ctx.nodes >= ctx.budget) break;
  }
  return worst;
}

/* ------------------------------------------------------------------ *
 * Iterative deepening root
 * ------------------------------------------------------------------ */

export function pickMoveDeep(pos: Position, army: Army, opts: DeepOptions): DeepResult {
  const moves = generateLegal(pos, army);
  const ctx: Ctx = { nodes: 0, budget: opts.nodeBudget, opts, root: army, tt: new Map() };

  if (moves.length === 0) {
    return { move: null, utility: 0, nodes: 0, depthReached: 0, considered: [] };
  }

  const ordered = orderMoves(moves).slice(0, Math.max(opts.branchCap, 8));
  let completed: { move: Move; score: number }[] = [];
  let depthReached = 0;

  for (let depth = 1; depth <= opts.maxDepth; depth++) {
    const iteration: { move: Move; score: number }[] = [];
    let aborted = false;

    // Search the previous iteration's best move first — the classic ID ordering win, and the
    // reason shallow iterations are not wasted work.
    const order = completed.length > 0
      ? [...completed.map((c) => c.move),
        ...ordered.filter((m) => !completed.some((c) => c.move === m))]
      : ordered;

    for (const m of order) {
      const gained = makeScored(pos, m);
      ctx.nodes++;
      const u = replyLayer(pos, depth, ctx);
      unmakeScored(pos, gained);
      iteration.push({ move: m, score: u });
      if (ctx.nodes >= ctx.budget) {
        aborted = true;
        break;
      }
    }

    iteration.sort((a, b) => b.score - a.score);
    if (!aborted || completed.length === 0) {
      // A partial first iteration is still better than nothing; deeper partials are not —
      // their scores are not comparable across the abort boundary.
      if (!aborted) depthReached = depth;
      if (!aborted || depth === 1) completed = iteration;
    }
    if (aborted) break;
  }

  const idx = selectFromScored(completed.map((c) => c.score), opts.temperature, opts.rng);
  return {
    move: completed[idx].move,
    utility: completed[idx].score,
    nodes: ctx.nodes,
    depthReached,
    considered: completed,
  };
}
