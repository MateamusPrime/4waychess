/**
 * Perft — count leaf nodes of the move tree to a fixed depth.
 *
 * In standard chess, perft is validated against published reference counts. None exist for
 * four-way chess, so our numbers are established by construction and by agreement with the
 * independent naive generator, then FROZEN as regression baselines (RISKS.md R4). Their value
 * is not that they are externally verified — it is that any future change to move generation
 * which alters them is caught immediately and must be justified.
 *
 * Note a "ply" here is one army's move, so depth 4 is roughly one full round.
 */

import type { Army } from './types.ts';
import { Position } from './position.ts';
import { generateLegal } from './movegen.ts';

export function perft(pos: Position, depth: number): number {
  if (depth === 0) return 1;
  const moves = generateLegal(pos, pos.turn);
  if (depth === 1) return moves.length;

  let nodes = 0;
  for (const m of moves) {
    pos.makeMove(m);
    nodes += perft(pos, depth - 1);
    pos.unmakeMove();
  }
  return nodes;
}

export interface PerftDetail {
  nodes: number;
  captures: number;
  enPassant: number;
  castles: number;
  promotions: number;
}

/** Perft with a breakdown by move kind — far more diagnostic when a count drifts. */
export function perftDetailed(pos: Position, depth: number): PerftDetail {
  const acc: PerftDetail = {
    nodes: 0, captures: 0, enPassant: 0, castles: 0, promotions: 0,
  };
  walk(pos, depth, acc);
  return acc;
}

function walk(pos: Position, depth: number, acc: PerftDetail): void {
  if (depth === 0) {
    acc.nodes++;
    return;
  }
  for (const m of generateLegal(pos, pos.turn)) {
    if (depth === 1) {
      acc.nodes++;
      if (m.captured !== null) acc.captures++;
      if (m.capturedSq !== null && m.capturedSq !== m.to) acc.enPassant++;
      if (m.castle !== null) acc.castles++;
      if (m.promotion !== null) acc.promotions++;
      continue;
    }
    pos.makeMove(m);
    walk(pos, depth - 1, acc);
    pos.unmakeMove();
  }
}

/** Per-move node counts at the root — the standard tool for bisecting a perft mismatch. */
export function perftDivide(pos: Position, depth: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of generateLegal(pos, pos.turn)) {
    pos.makeMove(m);
    out.set(`${m.from}-${m.to}${m.promotion ?? ''}`, depth <= 1 ? 1 : perft(pos, depth - 1));
    pos.unmakeMove();
  }
  return out;
}

/** Which army moves at each ply of a perft walk from this position. */
export function plyOrder(pos: Position, depth: number): Army[] {
  const out: Army[] = [];
  let cur = pos.turn;
  for (let i = 0; i < depth; i++) {
    out.push(cur);
    cur = pos.nextActive(cur);
  }
  return out;
}
