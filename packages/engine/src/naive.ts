/**
 * A deliberately naive, slow, INDEPENDENT move generator.
 *
 * This exists solely to differential-test `movegen.ts`. Standard chess engines validate move
 * generation against published perft counts; no such reference data exists for four-way chess,
 * and our queen-left house rule means chess.com's games would not match anyway (RISKS.md R4).
 * So we build a second implementation that shares no logic with the first, and demand they
 * agree over millions of positions.
 *
 * Design rule: this file must NOT import from movegen.ts or attacks.ts. Where the fast path
 * uses reverse attack detection and precomputed direction tables, this one brute-forces every
 * ordered pair of squares and re-derives paths from scratch. If they agree, the agreement means
 * something.
 */

import type { Army, Move, PieceType, Square } from './types.ts';
import { FILES, SQUARES, W, fileOf, idx, isPlayableXY, rankOf, toOwn } from './geometry.ts';

/**
 * Own-frame to raw board coordinates, WITHOUT assuming the result is on the board.
 *
 * Deliberately does not use `fromOwn`, which composes idx() and would silently wrap a
 * row when handed out-of-range coordinates. Pawns genuinely reach ownFile 0 and below by
 * capturing sideways into the arms, so the caller must be able to bounds-check the raw
 * coordinates before trusting them.
 */
function ownToXY(army: Army, f: number, r: number): readonly [number, number] {
  switch (army) {
    case 'red': return [f + 2, r - 1];
    case 'blue': return [r - 1, 11 - f];
    case 'yellow': return [11 - f, 14 - r];
    case 'green': return [14 - r, f + 2];
  }
}

/** Own-frame square, or -1 if it is not a playable board square. */
function ownSq(army: Army, f: number, r: number): Square {
  const [x, y] = ownToXY(army, f, r);
  return isPlayableXY(x, y) ? idx(x, y) : -1;
}
import { Position, codeArmy, codePromoted, codeType } from './position.ts';

const sign = (n: number): number => (n > 0 ? 1 : n < 0 ? -1 : 0);

/** Walk from -> to along a straight line, checking every intermediate square is empty and on-board. */
function pathClear(pos: Position, from: Square, to: Square): boolean {
  const dx = sign(fileOf(to) - fileOf(from));
  const dy = sign(rankOf(to) - rankOf(from));
  let x = fileOf(from) + dx;
  let y = rankOf(from) + dy;
  while (x !== fileOf(to) || y !== rankOf(to)) {
    if (!isPlayableXY(x, y)) return false;
    if (pos.board[idx(x, y)] !== 0) return false;
    x += dx;
    y += dy;
  }
  return true;
}

/** Naive geometric reachability, ignoring occupancy of the destination and king safety. */
function canReach(pos: Position, from: Square, to: Square, type: PieceType, army: Army): boolean {
  if (from === to) return false;
  if (!isPlayableXY(fileOf(to), rankOf(to))) return false;

  const dx = fileOf(to) - fileOf(from);
  const dy = rankOf(to) - rankOf(from);
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);

  switch (type) {
    case 'n':
      return (adx === 1 && ady === 2) || (adx === 2 && ady === 1);
    case 'k':
      return adx <= 1 && ady <= 1;
    case 'r':
      return (dx === 0 || dy === 0) && pathClear(pos, from, to);
    case 'b':
      return adx === ady && pathClear(pos, from, to);
    case 'q':
      return (dx === 0 || dy === 0 || adx === ady) && pathClear(pos, from, to);
    case 'p': {
      // Handled entirely by the caller; pawns are too asymmetric for a reachability test.
      void army;
      return false;
    }
  }
}

/** Does the piece on `from` ATTACK `to`? Pawns attack diagonally only, never forward. */
function attacksSquare(pos: Position, from: Square, to: Square): boolean {
  const code = pos.board[from];
  if (code === 0) return false;
  const army = codeArmy(code);
  const type = codeType(code);
  if (!pos.isActive(army)) return false; // dead pieces never give check (RULES.md §9)

  if (type === 'p') {
    const [tf, tr] = toOwn(army, to);
    const [ff, fr] = toOwn(army, from);
    return tr === fr + 1 && Math.abs(tf - ff) === 1;
  }
  return canReach(pos, from, to, type, army);
}

/** Is `sq` attacked by any active army hostile to `army`? Brute force over the whole board. */
export function naiveIsAttacked(pos: Position, sq: Square, army: Army): boolean {
  for (const from of SQUARES) {
    const code = pos.board[from];
    if (code === 0) continue;
    const other = codeArmy(code);
    if (!pos.areEnemies(army, other)) continue;
    if (attacksSquare(pos, from, sq)) return true;
  }
  return false;
}

export function naiveIsInCheck(pos: Position, army: Army): boolean {
  const k = pos.kingSquare(army);
  if (k < 0) return false;
  return naiveIsAttacked(pos, k, army);
}

function mk(pos: Position, from: Square, to: Square, piece: PieceType): Move {
  const c = pos.board[to];
  return {
    from, to, piece,
    captured: c === 0 ? null : codeType(c),
    capturedSq: c === 0 ? null : to,
    capturedArmy: c === 0 ? null : codeArmy(c),
    capturedPromoted: c === 0 ? false : codePromoted(c),
    promotion: null, castle: null, doubleStep: false,
  };
}

function withPromotions(pos: Position, army: Army, m: Move, out: Move[]): void {
  if (toOwn(army, m.to)[1] !== pos.rules.promotionRank) {
    out.push(m);
    return;
  }
  if (pos.rules.allowUnderpromotion) {
    for (const p of ['q', 'r', 'b', 'n'] as PieceType[]) out.push({ ...m, promotion: p });
  } else {
    out.push({ ...m, promotion: 'q' });
  }
}

export function naiveGeneratePseudoLegal(pos: Position, army: Army): Move[] {
  const out: Move[] = [];
  if (!pos.isActive(army)) return out;

  for (const from of SQUARES) {
    const code = pos.board[from];
    if (code === 0 || codeArmy(code) !== army) continue;
    const type = codeType(code);

    if (type === 'p') {
      const [ff, fr] = toOwn(army, from);
      // Forward one and two, expressed purely in the local frame.
      for (const dr of [1, 2]) {
        if (dr === 2 && fr !== 2) continue;
        let blocked = false;
        for (let k = 1; k <= dr; k++) {
          const sq = ownSq(army, ff, fr + k);
          if (sq < 0 || pos.board[sq] !== 0) blocked = true;
        }
        if (blocked) continue;
        const to = ownSq(army, ff, fr + dr);
        const m = mk(pos, from, to, 'p');
        if (dr === 2) { m.doubleStep = true; out.push(m); } else { withPromotions(pos, army, m, out); }
      }
      // Diagonal captures and en passant. Note ownFile is NOT clamped to 1..8: pawns reach
      // the side arms by capturing sideways, where ownFile legitimately goes to 0 and below.
      for (const df of [-1, 1]) {
        const to = ownSq(army, ff + df, fr + 1);
        if (to < 0) continue;
        const c = pos.board[to];
        if (c !== 0) {
          if (pos.areEnemies(army, codeArmy(c))) withPromotions(pos, army, mk(pos, from, to, 'p'), out);
          continue;
        }
        for (const right of pos.ep) {
          if (right.passed !== to || !pos.areEnemies(army, right.army)) continue;
          const v = pos.board[right.victim];
          if (v === 0) continue;
          const m = mk(pos, from, to, 'p');
          m.captured = codeType(v);
          m.capturedSq = right.victim;
          m.capturedArmy = codeArmy(v);
          m.capturedPromoted = codePromoted(v);
          withPromotions(pos, army, m, out);
        }
      }
      continue;
    }

    for (const to of SQUARES) {
      if (!canReach(pos, from, to, type, army)) continue;
      const c = pos.board[to];
      if (c !== 0 && !pos.areEnemies(army, codeArmy(c))) continue;
      out.push(mk(pos, from, to, type));
    }
  }

  // Castling, derived independently in the local frame.
  const rights = pos.castling[army];
  const kingSq = ownSq(army, 5, 1);
  const kc = kingSq < 0 ? 0 : pos.board[kingSq];
  if ((rights.short || rights.long) && kc !== 0
      && codeArmy(kc) === army && codeType(kc) === 'k'
      && !naiveIsAttacked(pos, kingSq, army)) {
    const at = (f: number): number => pos.board[ownSq(army, f, 1)];
    const isRook = (f: number): boolean => {
      const c = at(f);
      return c !== 0 && codeArmy(c) === army && codeType(c) === 'r';
    };
    const safe = (f: number): boolean => !naiveIsAttacked(pos, ownSq(army, f, 1), army);

    if (rights.short && isRook(8) && at(6) === 0 && at(7) === 0 && safe(6) && safe(7)) {
      const m = mk(pos, kingSq, ownSq(army, 7, 1), 'k');
      m.castle = 'short';
      out.push(m);
    }
    if (rights.long && isRook(1) && at(2) === 0 && at(3) === 0 && at(4) === 0 && safe(3) && safe(4)) {
      const m = mk(pos, kingSq, ownSq(army, 3, 1), 'k');
      m.castle = 'long';
      out.push(m);
    }
  }

  return out;
}

/** Fully legal moves, filtered with the naive attack detector on a cloned position. */
export function naiveGenerateLegal(pos: Position, army: Army = pos.turn): Move[] {
  const out: Move[] = [];
  for (const m of naiveGeneratePseudoLegal(pos, army)) {
    const c = pos.clone();
    c.makeMove(m);
    if (!naiveIsInCheck(c, army)) out.push(m);
  }
  return out;
}

/** Stable text form of a move, for set comparison between the two generators. */
export function moveKey(m: Move): string {
  const sq = (s: Square): string => FILES[s % W] + String(((s / W) | 0) + 1);
  return [
    sq(m.from), sq(m.to), m.piece,
    m.promotion ?? '-', m.castle ?? '-',
    m.doubleStep ? 'D' : '-',
    m.capturedSq === null ? '-' : sq(m.capturedSq),
    m.captured ?? '-',
  ].join('');
}
