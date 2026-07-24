/**
 * Interaction state machine.
 *
 * Tap-to-select then tap-to-move is the PRIMARY path, on every platform (RISKS.md R7). Drag is
 * an enhancement layered on top, never the only way to move a piece. The reason is mobile: if
 * one-finger drag moved pieces, it could not also pan the board, and on a 14x14 grid panning is
 * not optional. Making tap primary keeps drag free to be optional.
 *
 * Pure reducers — no DOM, no events, no timers. The host translates real input into these calls.
 */

import { generateLegal } from '@4wc/engine';
import type { Army, Move, Position, Square } from '@4wc/engine';

export type Selection =
  | { kind: 'none' }
  | { kind: 'piece'; from: Square; moves: Move[] }
  | { kind: 'promotion'; from: Square; to: Square; options: Move[] };

export interface InteractionState {
  selection: Selection;
  /** Keyboard / screen-reader cursor. -1 when the board is not focused. */
  cursor: Square;
  /** The most recent move, for board highlighting. */
  lastMove: Move | null;
}

export const INITIAL_INTERACTION: InteractionState = {
  selection: { kind: 'none' },
  cursor: -1,
  lastMove: null,
};

export interface InteractionContext {
  position: Position;
  /** The viewing seat — whose side of the board is at the bottom. */
  seat: Army;
  /** Armies this client may move. Empty means view-only: spectating, replay, analysis. */
  controllable: readonly Army[];
}

export type Intent =
  | { kind: 'none' }
  | { kind: 'play'; move: Move }
  /** The host must show a promotion picker; call `choosePromotion` with the answer. */
  | { kind: 'need-promotion'; from: Square; to: Square; options: Move[] };

export interface Step {
  state: InteractionState;
  intent: Intent;
}

const NO_INTENT: Intent = { kind: 'none' };

function canMove(ctx: InteractionContext): boolean {
  return ctx.controllable.includes(ctx.position.turn);
}

function ownPieceAt(ctx: InteractionContext, sq: Square): boolean {
  const p = ctx.position.at(sq);
  return p !== null && p.army === ctx.position.turn;
}

function selectPiece(ctx: InteractionContext, state: InteractionState, sq: Square): Step {
  const moves = generateLegal(ctx.position, ctx.position.turn).filter((m) => m.from === sq);
  if (moves.length === 0) {
    // A piece with no legal moves still deselects cleanly rather than appearing stuck.
    return { state: { ...state, selection: { kind: 'none' } }, intent: NO_INTENT };
  }
  return {
    state: { ...state, selection: { kind: 'piece', from: sq, moves }, cursor: sq },
    intent: NO_INTENT,
  };
}

/** A tap or click on a board square. */
export function tapSquare(
  ctx: InteractionContext,
  state: InteractionState,
  sq: Square,
): Step {
  if (sq < 0) return { state, intent: NO_INTENT };

  // While a promotion picker is open, board taps are ignored: an accidental tap must not
  // silently pick a piece type the player did not choose.
  if (state.selection.kind === 'promotion') return { state, intent: NO_INTENT };

  if (!canMove(ctx)) {
    // View-only: the cursor still moves, so the board stays navigable and readable.
    return { state: { ...state, cursor: sq }, intent: NO_INTENT };
  }

  if (state.selection.kind === 'none') {
    if (!ownPieceAt(ctx, sq)) return { state: { ...state, cursor: sq }, intent: NO_INTENT };
    return selectPiece(ctx, state, sq);
  }

  const { from, moves } = state.selection;

  if (sq === from) {
    return { state: { ...state, selection: { kind: 'none' }, cursor: sq }, intent: NO_INTENT };
  }

  const targeting = moves.filter((m) => m.to === sq);
  if (targeting.length === 0) {
    // Tapping another of your own pieces reselects; anything else deselects.
    if (ownPieceAt(ctx, sq)) return selectPiece(ctx, state, sq);
    return { state: { ...state, selection: { kind: 'none' }, cursor: sq }, intent: NO_INTENT };
  }

  if (targeting.length > 1) {
    return {
      state: { ...state, selection: { kind: 'promotion', from, to: sq, options: targeting } },
      intent: { kind: 'need-promotion', from, to: sq, options: targeting },
    };
  }

  return {
    state: { ...state, selection: { kind: 'none' }, cursor: sq, lastMove: targeting[0] },
    intent: { kind: 'play', move: targeting[0] },
  };
}

/** Answer an open promotion picker. */
export function choosePromotion(state: InteractionState, promotion: string): Step {
  if (state.selection.kind !== 'promotion') return { state, intent: NO_INTENT };
  const move = state.selection.options.find((m) => m.promotion === promotion);
  if (move === undefined) return { state, intent: NO_INTENT };
  return {
    state: { ...state, selection: { kind: 'none' }, cursor: move.to, lastMove: move },
    intent: { kind: 'play', move },
  };
}

/** Dismiss any selection or open picker. */
export function cancel(state: InteractionState): Step {
  if (state.selection.kind === 'none') return { state, intent: NO_INTENT };
  return { state: { ...state, selection: { kind: 'none' } }, intent: NO_INTENT };
}

/** Record a move played by someone else (opponent, bot, network) for highlighting. */
export function observeMove(state: InteractionState, move: Move): InteractionState {
  return { ...state, selection: { kind: 'none' }, lastMove: move };
}

/* ------------------------------------------------------------------ *
 * Derived view helpers
 * ------------------------------------------------------------------ */

export interface MoveTargets {
  /** Empty destination squares. */
  quiet: Square[];
  /** Destinations occupied by a piece that would be captured. */
  captures: Square[];
}

export function targetsOf(ctx: InteractionContext, state: InteractionState): MoveTargets {
  const quiet: Square[] = [];
  const captures: Square[] = [];
  if (state.selection.kind === 'none') return { quiet, captures };

  const moves = state.selection.kind === 'piece' ? state.selection.moves : state.selection.options;
  for (const m of moves) {
    const list = m.captured === null ? quiet : captures;
    if (!list.includes(m.to)) list.push(m.to);
  }
  return { quiet, captures };
}

export function selectedSquare(state: InteractionState): Square {
  if (state.selection.kind === 'none') return -1;
  return state.selection.from;
}
