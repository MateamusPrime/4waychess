/**
 * Move generation.
 *
 * Pseudo-legal generation first, then a legality filter that rejects any move leaving the
 * mover's own king attacked by ANY opponent — the four-way generalisation of the pin rule.
 *
 * Everything pawn- and castling-related is expressed in the army-local frame (RULES.md §3),
 * so the logic reads as ordinary chess rather than four rotated special cases.
 */

import type { Army, Move, PieceType, Square } from './types.ts';
import {
  BISHOP_DIRS, FORWARD, KING_DELTAS, KNIGHT_DELTAS, PAWN_CAPTURES, QUEEN_DIRS, ROOK_DIRS,
  SQUARES, fromOwn, step, toOwn,
} from './geometry.ts';
import { Position, codeArmy, codePromoted, codeType } from './position.ts';
import { isAttacked, isInCheck } from './attacks.ts';

function emptyMove(from: Square, to: Square, piece: PieceType): Move {
  return {
    from, to, piece,
    captured: null, capturedSq: null, capturedArmy: null, capturedPromoted: false,
    promotion: null, castle: null, doubleStep: false,
  };
}

function captureMove(pos: Position, from: Square, to: Square, piece: PieceType): Move {
  const m = emptyMove(from, to, piece);
  const c = pos.board[to];
  if (c !== 0) {
    m.captured = codeType(c);
    m.capturedSq = to;
    m.capturedArmy = codeArmy(c);
    m.capturedPromoted = codePromoted(c);
  }
  return m;
}

/**
 * All pseudo-legal moves for `army` — legal in shape, but possibly leaving the king in check.
 * Generates for any army regardless of whose turn it is; the caller decides.
 */
export function generatePseudoLegal(pos: Position, army: Army): Move[] {
  const moves: Move[] = [];
  if (!pos.isActive(army)) return moves;

  for (const from of SQUARES) {
    const code = pos.board[from];
    if (code === 0 || codeArmy(code) !== army) continue;
    const type = codeType(code);

    switch (type) {
      case 'p': genPawn(pos, army, from, moves); break;
      case 'n': genSteps(pos, army, from, 'n', KNIGHT_DELTAS, moves); break;
      case 'k': genSteps(pos, army, from, 'k', KING_DELTAS, moves); break;
      case 'b': genSlides(pos, army, from, 'b', BISHOP_DIRS, moves); break;
      case 'r': genSlides(pos, army, from, 'r', ROOK_DIRS, moves); break;
      case 'q': genSlides(pos, army, from, 'q', QUEEN_DIRS, moves); break;
    }
  }

  genCastling(pos, army, moves);
  return moves;
}

function genSteps(
  pos: Position, army: Army, from: Square, piece: PieceType,
  deltas: readonly (readonly [number, number])[], out: Move[],
): void {
  for (const [dx, dy] of deltas) {
    const to = step(from, dx, dy);
    if (to < 0) continue;
    const c = pos.board[to];
    if (c !== 0 && !pos.areEnemies(army, codeArmy(c))) continue;
    out.push(captureMove(pos, from, to, piece));
  }
}

function genSlides(
  pos: Position, army: Army, from: Square, piece: PieceType,
  dirs: readonly (readonly [number, number])[], out: Move[],
): void {
  for (const [dx, dy] of dirs) {
    let to = step(from, dx, dy);
    while (to >= 0) {
      const c = pos.board[to];
      if (c === 0) {
        out.push(emptyMove(from, to, piece));
        to = step(to, dx, dy);
        continue;
      }
      // Occupied: capture if hostile, then stop either way. Dead pieces block like any other.
      if (pos.areEnemies(army, codeArmy(c))) out.push(captureMove(pos, from, to, piece));
      break;
    }
  }
}

function pushPawnMove(pos: Position, army: Army, m: Move, out: Move[]): void {
  const ownRank = toOwn(army, m.to)[1];
  if (ownRank !== pos.rules.promotionRank) {
    out.push(m);
    return;
  }
  if (pos.rules.allowUnderpromotion) {
    for (const p of ['q', 'r', 'b', 'n'] as PieceType[]) out.push({ ...m, promotion: p });
  } else {
    out.push({ ...m, promotion: 'q' });
  }
}

function genPawn(pos: Position, army: Army, from: Square, out: Move[]): void {
  const [fx, fy] = FORWARD[army];
  const ownRank = toOwn(army, from)[1];

  const one = step(from, fx, fy);
  if (one >= 0 && pos.board[one] === 0) {
    pushPawnMove(pos, army, emptyMove(from, one, 'p'), out);

    if (ownRank === 2) {
      const two = step(one, fx, fy);
      if (two >= 0 && pos.board[two] === 0) {
        const m = emptyMove(from, two, 'p');
        m.doubleStep = true;
        // A double step can never land on the promotion rank, so no promotion handling.
        out.push(m);
      }
    }
  }

  for (const [dx, dy] of PAWN_CAPTURES[army]) {
    const to = step(from, dx, dy);
    if (to < 0) continue;

    const c = pos.board[to];
    if (c !== 0) {
      if (pos.areEnemies(army, codeArmy(c))) {
        pushPawnMove(pos, army, captureMove(pos, from, to, 'p'), out);
      }
      continue;
    }

    // En passant. Multiple rights can be live at once in four-way chess, because up to
    // three armies may have double-stepped since our last turn. (RULES.md §6)
    for (const right of pos.ep) {
      if (right.passed !== to) continue;
      if (!pos.areEnemies(army, right.army)) continue;
      const victim = pos.board[right.victim];
      if (victim === 0) continue;
      const m = emptyMove(from, to, 'p');
      m.captured = codeType(victim);
      m.capturedSq = right.victim;
      m.capturedArmy = codeArmy(victim);
      m.capturedPromoted = codePromoted(victim);
      pushPawnMove(pos, army, m, out);
    }
  }
}

/**
 * Castling. In the army-local frame this is exactly standard chess (RULES.md §7):
 * king own(5,1); rooks own(1,1) and own(8,1); short king->own(7,1), long king->own(3,1).
 */
function genCastling(pos: Position, army: Army, out: Move[]): void {
  const rights = pos.castling[army];
  if (!rights.short && !rights.long) return;

  const kingSq = fromOwn(army, 5, 1);
  const kc = pos.board[kingSq];
  if (kc === 0 || codeArmy(kc) !== army || codeType(kc) !== 'k') return;
  if (isAttacked(pos, kingSq, army)) return; // may not castle out of check

  const sq = (f: number): Square => fromOwn(army, f, 1);
  const empty = (f: number): boolean => pos.board[sq(f)] === 0;
  const safe = (f: number): boolean => !isAttacked(pos, sq(f), army);
  const rookOk = (f: number): boolean => {
    const c = pos.board[sq(f)];
    return c !== 0 && codeArmy(c) === army && codeType(c) === 'r';
  };

  if (rights.short && rookOk(8) && empty(6) && empty(7) && safe(6) && safe(7)) {
    const m = emptyMove(kingSq, sq(7), 'k');
    m.castle = 'short';
    out.push(m);
  }
  // Long: own file 2 must be empty but need not be safe — the b1 square in standard chess.
  if (rights.long && rookOk(1) && empty(2) && empty(3) && empty(4) && safe(3) && safe(4)) {
    const m = emptyMove(kingSq, sq(3), 'k');
    m.castle = 'long';
    out.push(m);
  }
}

/** All fully legal moves for `army`. */
export function generateLegal(pos: Position, army: Army = pos.turn): Move[] {
  const pseudo = generatePseudoLegal(pos, army);
  const legal: Move[] = [];
  for (const m of pseudo) {
    pos.makeMove(m);
    const ok = !isInCheck(pos, army);
    pos.unmakeMove();
    if (ok) legal.push(m);
  }
  return legal;
}

export type TurnOutcome = 'normal' | 'check' | 'checkmate' | 'stalemate';

/**
 * Evaluate the position for the army whose turn it is.
 *
 * Checkmate and stalemate are assessed ONLY when the affected player's own turn arrives,
 * never at the moment the mating move is played (RULES.md §8). A player mated by an attacker
 * who is themselves eliminated before the turn comes round is therefore not mated at all.
 */
export function turnOutcome(pos: Position, army: Army = pos.turn): TurnOutcome {
  if (!pos.isActive(army)) return 'normal';
  const inCheck = isInCheck(pos, army);
  const hasMove = generateLegal(pos, army).length > 0;
  if (hasMove) return inCheck ? 'check' : 'normal';
  return inCheck ? 'checkmate' : 'stalemate';
}
