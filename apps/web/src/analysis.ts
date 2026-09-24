/**
 * Bot compute for the web app: device-sized budgets, bot moves, hints and game review.
 *
 * Shared by the worker (the normal path) and the main thread (the worker-less fallback), so
 * both behave identically. Positions arrive as FEN4 and moves leave as bare from/to/promotion;
 * the caller re-validates against its own legal moves.
 */

import {
  FFA_RULES, TEAMS_RULES, formatMove, generateLegal, parseFen4, startingPosition,
} from '@4wc/engine';
import type { Army, Move, Position } from '@4wc/engine';
import {
  makeBot, makeRng, pickMove, reviewMove, suggestMove, uniformWeights,
} from '@4wc/bots';
import type { Difficulty, Grade, PersonalityId } from '@4wc/bots';

export interface WireMove { from: number; to: number; promotion: string | null }

export interface WireVerdict {
  grade: Grade;
  loss: number;
  best: WireMove;
  /** The better move in notation, formatted in the position it would have been played in. */
  bestText: string;
}

export type AnalysisRequest =
  | {
      type: 'move'; id: number; fen: string; mode: 'ffa' | 'teams'; army: Army;
      kind: PersonalityId; difficulty: Difficulty; seed: number;
    }
  | { type: 'hint'; id: number; fen: string; mode: 'ffa' | 'teams' }
  | {
      type: 'review'; id: number; mode: 'ffa' | 'teams';
      items: { ply: number; fen: string; move: WireMove }[];
    }
  | { type: 'cancel' };

export type AnalysisReply =
  | { type: 'move'; id: number; army: Army; move: WireMove | null }
  | { type: 'hint'; id: number; move: WireMove | null; text: string | null }
  | { type: 'review-item'; id: number; ply: number; verdict: WireVerdict | null }
  | { type: 'review-done'; id: number };

const wire = (m: Move): WireMove => ({ from: m.from, to: m.to, promotion: m.promotion });

function position(fen: string, mode: 'ffa' | 'teams'): Position {
  return parseFen4(fen, mode === 'teams' ? TEAMS_RULES : FFA_RULES);
}

/* ------------------------------------------------------------------ *
 * Device speed (hints only)
 * ------------------------------------------------------------------ */

/**
 * Every difficulty tier is defined by DEPTH, not time: each tier's node budget always
 * completes its depth (Hard: depth 4 at branch cap 10, at most ~12.4k nodes; Expert: depth 5
 * at cap 8, ~43k — bounds that hold in any position, see bots.test.ts). So a bot plays the same
 * move on every device and a slow phone simply waits longer. Tiers used to be capped at a
 * thinking time instead, which silently made Hard a depth-3 bot on phones.
 *
 * Hints are the one exception: a hint is a convenience, not an opponent, so it thinks for a
 * fixed ~0.8s. The bots package has no clock (its purity test forbids one), so the host
 * measures its own speed once and converts that time into nodes.
 */
const HINT_MS = 800;

let measured: number | null = null;

/**
 * Nodes per millisecond on this device, measured once with the real search on the opening
 * position (the first run warms the JIT and is discarded). ~100ms on a desktop.
 */
export function nodesPerMs(): number {
  if (measured !== null) return measured;
  const opts = {
    depth: 3, nodeBudget: 2_000, branchCap: 10, temperature: 0,
    weights: uniformWeights(), rng: makeRng(1),
  };
  pickMove(startingPosition(), opts);
  const t0 = performance.now();
  const r = pickMove(startingPosition(), opts);
  measured = r.nodes / Math.max(1, performance.now() - t0);
  return measured;
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/* ------------------------------------------------------------------ *
 * Handlers
 * ------------------------------------------------------------------ */

export function computeMove(req: Extract<AnalysisRequest, { type: 'move' }>): AnalysisReply {
  const pos = position(req.fen, req.mode);
  const bot = makeBot(req.kind, req.difficulty, req.seed);
  const move = bot.pick(pos, req.army);
  return { type: 'move', id: req.id, army: req.army, move: move === null ? null : wire(move) };
}

export function computeHint(req: Extract<AnalysisRequest, { type: 'hint' }>): AnalysisReply {
  const pos = position(req.fen, req.mode);
  const budget = Math.round(clamp(nodesPerMs() * HINT_MS, 3_000, 30_000));
  const move = suggestMove(pos, budget);
  if (move === null) return { type: 'hint', id: req.id, move: null, text: null };
  return { type: 'hint', id: req.id, move: wire(move), text: formatMove(pos, move) };
}

/** Grade one reviewed move. Null when the move is not legal in the given position. */
export function reviewItem(
  mode: 'ffa' | 'teams', item: { fen: string; move: WireMove },
): WireVerdict | null {
  const pos = position(item.fen, mode);
  const played = generateLegal(pos, pos.turn).find(
    (m) => m.from === item.move.from && m.to === item.move.to
      && m.promotion === item.move.promotion,
  );
  if (played === undefined) return null;
  const v = reviewMove(pos, played);
  if (v === null) return null;
  return { grade: v.grade, loss: v.loss, best: wire(v.best), bestText: formatMove(pos, v.best) };
}
