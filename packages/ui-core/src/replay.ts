/**
 * Replay state — stepping through a finished game.
 *
 * A stored game nobody can watch is half a feature, and this is also the substrate for the
 * analysis board, shared game links and puzzle mining later (RISKS.md R18).
 *
 * Positions are reconstructed by REPLAYING from the start rather than by unwinding, because
 * `Game` is deliberately forward-only: eliminations, Teams piece inheritance and banked points
 * are not reversible in place. Replaying is O(ply) per seek, which is negligible at these
 * lengths and removes a whole class of "undo didn't quite restore it" bugs.
 *
 * Pure and framework-free like the rest of ui-core: no clock, no timers. The host drives
 * autoplay by calling `step` on its own schedule.
 */

import { FFA_RULES, Game, TEAMS_RULES, formatMove, parseFen4, readPgn4 } from '@4wc/engine';
import type { Army, Move, Position, Retirement, Ruleset } from '@4wc/engine';

export interface ReplayState {
  /** Every move of the finished game. */
  moves: Move[];
  /** How many moves have been applied. 0 = the starting position. */
  ply: number;
  /** The position after `ply` moves. */
  position: Position;
  /** The move that produced the current position, for board highlighting. */
  lastMove: Move | null;
  /** Points after `ply` moves — these change as the replay advances. */
  points: Record<Army, number>;
  /** Long-algebraic text per ply, matching the stored PGN4. */
  notation: string[];
  /** Which army played each ply. */
  movers: Army[];
  /** Retained so any ply can be rebuilt from scratch. */
  startFen: string;
  rules: Ruleset;
  /**
   * Resignations and timeouts. They are not moves, so replaying the movetext alone keeps the
   * retired army in the turn order: from its next skipped seat every mover label and every
   * rebuilt position was wrong. `readPgn4` already applied them; the replay must too.
   */
  retirements: Retirement[];
}

/** A game at the recorded start position under the recorded ruleset, with no moves played. */
function freshGame(startFen: string, rules: Ruleset): Game {
  return new Game(parseFen4(startFen, rules), startFen);
}

/** Apply every retirement recorded as taking effect after `game.moves.length` moves. */
function applyRetirements(game: Game, retirements: readonly Retirement[]): void {
  for (const r of retirements) {
    if (r.atPly !== game.moves.length) continue;
    if (!game.pos.isActive(r.army) || game.result().over) continue;
    if (r.status === 'timeout') game.timeout(r.army);
    else game.resign(r.army);
  }
}

/**
 * Walk the game once from the start, calling `visit` with each ply's index and the position
 * the move is played FROM — retirements applied, exactly as the game was played. Analysis
 * (game review) needs every pre-move position; seeking to each ply would be quadratic.
 */
export function forEachPly(
  state: Pick<ReplayState, 'moves' | 'startFen' | 'rules' | 'retirements'>,
  visit: (ply: number, before: Position, move: Move) => void,
): void {
  const game = freshGame(state.startFen, state.rules);
  applyRetirements(game, state.retirements);
  for (const [ply, m] of state.moves.entries()) {
    visit(ply, game.pos, m);
    game.play(m);
    applyRetirements(game, state.retirements);
  }
}

/**
 * Rebuild a game from PGN4 and seek to a ply.
 *
 * Notation is re-derived by walking the moves rather than scraped from the stored movetext, so
 * a replay renders identically whatever formatting the file happened to carry.
 */
export function loadReplay(pgn4: string, ply = 0): ReplayState {
  const { game, tags } = readPgn4(pgn4);
  const rules: Ruleset = tags.Mode === 'teams' ? TEAMS_RULES : FFA_RULES;
  const startFen = game.startingFen;
  const moves = [...game.moves];
  const retirements = [...game.retirements];

  const notation: string[] = [];
  const movers: Army[] = [];
  forEachPly({ moves, startFen, rules, retirements }, (_ply, before, m) => {
    movers.push(before.turn);
    notation.push(formatMove(before, m));
  });

  const base: ReplayState = {
    moves,
    ply: 0,
    position: freshGame(startFen, rules).pos,
    lastMove: null,
    points: { red: 0, blue: 0, yellow: 0, green: 0 },
    notation,
    movers,
    startFen,
    rules,
    retirements,
  };
  return seek(base, ply);
}

/** Seek to an absolute ply, clamped to the game's length. */
export function seek(state: ReplayState, ply: number): ReplayState {
  const target = Math.max(0, Math.min(state.moves.length, Math.floor(ply)));
  const game = freshGame(state.startFen, state.rules);
  applyRetirements(game, state.retirements);
  for (let i = 0; i < target; i++) {
    game.play(state.moves[i]);
    applyRetirements(game, state.retirements);
  }

  return {
    ...state,
    ply: target,
    position: game.pos,
    lastMove: target > 0 ? state.moves[target - 1] : null,
    points: { ...game.pos.points },
  };
}

export function step(state: ReplayState, delta: number): ReplayState {
  return seek(state, state.ply + delta);
}

export function toStart(state: ReplayState): ReplayState {
  return seek(state, 0);
}

export function toEnd(state: ReplayState): ReplayState {
  return seek(state, state.moves.length);
}

export function atStart(state: ReplayState): boolean {
  return state.ply === 0;
}

export function atEnd(state: ReplayState): boolean {
  return state.ply >= state.moves.length;
}

/** Round number (1-based) and seat index for a ply, for move-list highlighting. */
export function roundOf(ply: number): { round: number; seat: number } {
  return { round: Math.floor(ply / 4) + 1, seat: ply % 4 };
}
