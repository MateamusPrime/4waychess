/**
 * Scoring (RULES.md §10).
 *
 * In free-for-all this is not decoration — the point table IS the win condition, so it drives
 * both player strategy and bot evaluation. Note the inversion from standard chess: bishops (5)
 * outrank knights (3), because long diagonals on an open 14x14 board make them materially
 * stronger.
 *
 * Pure functions only. The Game layer decides when to apply them.
 */

import type { Army, Move, PieceType } from './types.ts';
import { ARMIES } from './geometry.ts';
import { Position, codeArmy, codeType } from './position.ts';
import { isAttackedBy } from './attacks.ts';

export const PIECE_VALUES: Readonly<Record<PieceType, number>> = {
  p: 1, n: 3, b: 5, r: 5, q: 9, k: 20,
};

/** A queen created by promotion in FFA is worth only 1 if captured. */
export const PROMOTED_QUEEN_VALUE = 1;
/** A king beyond an army's first — see `spareKingValue`. */
export const SPARE_KING_VALUE = 3;
export const CHECKMATE_BONUS = 20;
export const SELF_STALEMATE_BONUS = 20;
export const CHECK_TWO_BONUS = 5;
export const CHECK_THREE_BONUS = 20;

/** How many kings this army currently has on the board. */
export function kingCount(pos: Position, army: Army): number {
  let n = 0;
  for (let s = 0; s < pos.board.length; s++) {
    const c = pos.board[s];
    if (c !== 0 && codeArmy(c) === army && codeType(c) === 'k') n++;
  }
  return n;
}

/**
 * Points for capturing the piece this move takes, evaluated against the position BEFORE the
 * move is made.
 *
 * Dead armies' pieces are worth zero — they are pure terrain (RULES.md §9). A "spare king" is
 * a king an army holds beyond its first, which in our ruleset arises when a Teams partner
 * resigns and their pieces transfer (RULES.md §11); capturing one is worth 3 rather than 20,
 * because it does not end anybody.
 */
export function captureValue(pos: Position, move: Move): number {
  if (move.captured === null || move.capturedArmy === null) return 0;
  if (!pos.isActive(move.capturedArmy)) return 0;

  if (move.captured === 'k') {
    return kingCount(pos, move.capturedArmy) > 1 ? SPARE_KING_VALUE : PIECE_VALUES.k;
  }
  if (move.captured === 'q' && move.capturedPromoted) return PROMOTED_QUEEN_VALUE;
  return PIECE_VALUES[move.captured];
}

/** Which opponents of `mover` are currently in check *from `mover`*. */
export function armiesCheckedBy(pos: Position, mover: Army): Army[] {
  const out: Army[] = [];
  for (const a of ARMIES) {
    if (a === mover || !pos.isActive(a) || !pos.areEnemies(mover, a)) continue;
    const k = pos.kingSquare(a);
    if (k >= 0 && isAttackedBy(pos, k, mover)) out.push(a);
  }
  return out;
}

/**
 * Checks NEWLY created by a move — those in the after-set but not the before-set.
 *
 * The distinction matters far more here than in two-player chess. Because two opponents move
 * between your check and the victim's reply, a check you delivered earlier is still standing
 * when your next turn comes round. Counting standing checks would mean a player could park one
 * permanent check, then collect the multi-check bonus every time they checked anybody else
 * with an unrelated piece. Only checks this move actually delivers count.
 */
export function newChecks(before: Army[], after: Army[]): Army[] {
  return after.filter((a) => !before.includes(a));
}

/** Bonus for the number of opponents a single move puts in check. (RULES.md §10) */
export function checkBonusFor(count: number): number {
  if (count >= 3) return CHECK_THREE_BONUS;
  if (count === 2) return CHECK_TWO_BONUS;
  return 0;
}

/** Total material an army has on the board, at capture values. */
export function materialValue(pos: Position, army: Army): number {
  let total = 0;
  for (let s = 0; s < pos.board.length; s++) {
    const c = pos.board[s];
    if (c === 0 || codeArmy(c) !== army) continue;
    const t = codeType(c);
    if (t === 'k') continue;
    total += PIECE_VALUES[t];
  }
  return total;
}
