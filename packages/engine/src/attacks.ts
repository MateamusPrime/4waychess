/**
 * Attack detection.
 *
 * Uses reverse detection — scan outward from the target square looking for attackers —
 * rather than generating every enemy move. On a 160-square board with three opponents that
 * difference is large, and legality testing is the hottest path in the engine.
 *
 * Two four-way specifics:
 *  - Only ACTIVE armies attack. Dead pieces block but never give check. (RULES.md §9)
 *  - "Enemy" is mode-dependent: in Teams your partner is not an enemy. (RULES.md §11)
 */

import type { Army, Square } from './types.ts';
import {
  ARMIES, BISHOP_DIRS, KING_DELTAS, KNIGHT_DELTAS, NSQ, PAWN_CAPTURES, QUEEN_DIRS, ROOK_DIRS,
  step,
} from './geometry.ts';
import { Position, codeArmy, codeType } from './position.ts';

/** Is `sq` attacked by any piece of `by`? Returns false if `by` is not active. */
export function isAttackedBy(pos: Position, sq: Square, by: Army): boolean {
  if (!pos.isActive(by)) return false;

  for (const [dx, dy] of KNIGHT_DELTAS) {
    const s = step(sq, dx, dy);
    if (s < 0) continue;
    const c = pos.board[s];
    if (c !== 0 && codeArmy(c) === by && codeType(c) === 'n') return true;
  }

  for (const [dx, dy] of KING_DELTAS) {
    const s = step(sq, dx, dy);
    if (s < 0) continue;
    const c = pos.board[s];
    if (c !== 0 && codeArmy(c) === by && codeType(c) === 'k') return true;
  }

  for (const [dx, dy] of ROOK_DIRS) {
    let s = step(sq, dx, dy);
    while (s >= 0) {
      const c = pos.board[s];
      if (c !== 0) {
        if (codeArmy(c) === by) {
          const t = codeType(c);
          if (t === 'r' || t === 'q') return true;
        }
        break;
      }
      s = step(s, dx, dy);
    }
  }

  for (const [dx, dy] of BISHOP_DIRS) {
    let s = step(sq, dx, dy);
    while (s >= 0) {
      const c = pos.board[s];
      if (c !== 0) {
        if (codeArmy(c) === by) {
          const t = codeType(c);
          if (t === 'b' || t === 'q') return true;
        }
        break;
      }
      s = step(s, dx, dy);
    }
  }

  // A pawn of `by` attacks sq if it stands at sq minus one of `by`'s capture directions.
  for (const [dx, dy] of PAWN_CAPTURES[by]) {
    const s = step(sq, -dx, -dy);
    if (s < 0) continue;
    const c = pos.board[s];
    if (c !== 0 && codeArmy(c) === by && codeType(c) === 'p') return true;
  }

  return false;
}

/** Is `sq` attacked by any active army that `army` is at war with? */
export function isAttacked(pos: Position, sq: Square, army: Army): boolean {
  for (const other of ARMIES) {
    if (!pos.areEnemies(army, other)) continue;
    if (isAttackedBy(pos, sq, other)) return true;
  }
  return false;
}

/** Every active enemy army currently attacking `sq`. Used for multi-check bonuses. */
export function attackersOf(pos: Position, sq: Square, army: Army): Army[] {
  const out: Army[] = [];
  for (const other of ARMIES) {
    if (!pos.areEnemies(army, other)) continue;
    if (isAttackedBy(pos, sq, other)) out.push(other);
  }
  return out;
}

/**
 * Every square attacked by `army`, as a 0/1 map indexed by square.
 *
 * The forward complement to `isAttackedBy`'s reverse scan. Reverse detection wins when asking
 * about ONE square (legality); a full map wins when a consumer needs many squares at once —
 * bot evaluation asks "which of my pieces stand attacked, and are they defended?" for every
 * piece on the board, and answering that piece-by-piece in reverse costs an order of magnitude
 * more than building each army's map once.
 *
 * Semantics match isAttackedBy exactly (a differential test enforces this): attack means
 * "could capture a piece standing there" — pawns count their capture diagonals only, sliders
 * include the first blocker's square, and an inactive army attacks nothing.
 */
export function attackMap(pos: Position, by: Army): Uint8Array {
  const map = new Uint8Array(NSQ);
  if (!pos.isActive(by)) return map;

  for (let s = 0; s < NSQ; s++) {
    const code = pos.board[s];
    if (code === 0 || codeArmy(code) !== by) continue;

    switch (codeType(code)) {
      case 'p':
        for (const [dx, dy] of PAWN_CAPTURES[by]) {
          const q = step(s, dx, dy);
          if (q >= 0) map[q] = 1;
        }
        break;
      case 'n':
        for (const [dx, dy] of KNIGHT_DELTAS) {
          const q = step(s, dx, dy);
          if (q >= 0) map[q] = 1;
        }
        break;
      case 'k':
        for (const [dx, dy] of KING_DELTAS) {
          const q = step(s, dx, dy);
          if (q >= 0) map[q] = 1;
        }
        break;
      case 'b':
      case 'r':
      case 'q': {
        const dirs = codeType(code) === 'b' ? BISHOP_DIRS
          : codeType(code) === 'r' ? ROOK_DIRS : QUEEN_DIRS;
        for (const [dx, dy] of dirs) {
          let q = step(s, dx, dy);
          while (q >= 0) {
            map[q] = 1;
            if (pos.board[q] !== 0) break; // the blocker square is attacked; nothing beyond
            q = step(q, dx, dy);
          }
        }
        break;
      }
    }
  }
  return map;
}

/** Is this army's king currently in check? A missing king is never in check. */
export function isInCheck(pos: Position, army: Army): boolean {
  const k = pos.kingSquare(army);
  if (k < 0) return false;
  return isAttacked(pos, k, army);
}

/** Which armies are checking this army's king. May be two or three at once. (RULES.md §8) */
export function checkingArmies(pos: Position, army: Army): Army[] {
  const k = pos.kingSquare(army);
  if (k < 0) return [];
  return attackersOf(pos, k, army);
}
