/**
 * Position representation and make/unmake.
 *
 * Pieces are packed into a Uint8Array of 196 squares:
 *   bits 0-2  piece type, 1..6 (0 = empty)
 *   bits 3-4  army, 0..3
 *   bit  5    promoted flag — a "1-point queen" in FFA (RULES.md §6)
 *
 * Off-board squares (the corner cutouts) are simply never written to.
 */

import type {
  Army, ArmyStatus, CastlingRights, EnPassantRight, Move, PieceType, Ruleset, Square,
} from './types.ts';
import { ARMIES, ARMY_INDEX, NSQ, fromOwn, toOwn } from './geometry.ts';

const TYPE_ORDER: readonly PieceType[] = ['p', 'n', 'b', 'r', 'q', 'k'];
const TYPE_CODE: Readonly<Record<PieceType, number>> = {
  p: 1, n: 2, b: 3, r: 4, q: 5, k: 6,
};
const PROMOTED_BIT = 32;

export function encodePiece(army: Army, type: PieceType, promoted = false): number {
  return TYPE_CODE[type] | (ARMY_INDEX[army] << 3) | (promoted ? PROMOTED_BIT : 0);
}
export function codeType(code: number): PieceType {
  return TYPE_ORDER[(code & 7) - 1];
}
export function codeArmy(code: number): Army {
  return ARMIES[(code >> 3) & 3];
}
export function codePromoted(code: number): boolean {
  return (code & PROMOTED_BIT) !== 0;
}

export interface Piece {
  army: Army;
  type: PieceType;
  promoted: boolean;
}

interface Undo {
  move: Move;
  castling: Record<Army, CastlingRights>;
  ep: EnPassantRight[];
  halfmove: number;
  turn: Army;
  movedPieceCode: number;
  status: Record<Army, ArmyStatus>;
}

export const FFA_RULES: Ruleset = {
  id: '4wc.house.v1.ffa',
  mode: 'ffa',
  promotionRank: 8,
  allowUnderpromotion: false,
  promotedQueenIsOnePoint: true,
  repetitionLimit: 3,
  moveRuleRounds: 50,
};

export const TEAMS_RULES: Ruleset = {
  id: '4wc.house.v1.teams',
  mode: 'teams',
  promotionRank: 11,
  allowUnderpromotion: true,
  promotedQueenIsOnePoint: false,
  repetitionLimit: 3,
  moveRuleRounds: 50,
};

/** Teams pairing: Red + Yellow vs Blue + Green. (RULES.md §11) */
export const PARTNER: Readonly<Record<Army, Army>> = {
  red: 'yellow', yellow: 'red', blue: 'green', green: 'blue',
};

export class Position {
  board: Uint8Array;
  turn: Army;
  status: Record<Army, ArmyStatus>;
  castling: Record<Army, CastlingRights>;
  ep: EnPassantRight[];
  points: Record<Army, number>;
  halfmove: number;
  ply: number;
  rules: Ruleset;
  private undoStack: Undo[];

  constructor(rules: Ruleset = FFA_RULES) {
    this.board = new Uint8Array(NSQ);
    this.turn = 'red';
    this.status = { red: 'active', blue: 'active', yellow: 'active', green: 'active' };
    this.castling = {
      red: { short: true, long: true },
      blue: { short: true, long: true },
      yellow: { short: true, long: true },
      green: { short: true, long: true },
    };
    this.ep = [];
    this.points = { red: 0, blue: 0, yellow: 0, green: 0 };
    this.halfmove = 0;
    this.ply = 0;
    this.rules = rules;
    this.undoStack = [];
  }

  clone(): Position {
    const p = new Position(this.rules);
    p.board = this.board.slice();
    p.turn = this.turn;
    p.status = { ...this.status };
    p.castling = {
      red: { ...this.castling.red }, blue: { ...this.castling.blue },
      yellow: { ...this.castling.yellow }, green: { ...this.castling.green },
    };
    p.ep = this.ep.map((e) => ({ ...e }));
    p.points = { ...this.points };
    p.halfmove = this.halfmove;
    p.ply = this.ply;
    return p;
  }

  /* ---------------- board access ---------------- */

  at(s: Square): Piece | null {
    const c = this.board[s];
    if (c === 0) return null;
    return { army: codeArmy(c), type: codeType(c), promoted: codePromoted(c) };
  }
  codeAt(s: Square): number {
    return this.board[s];
  }
  put(s: Square, army: Army, type: PieceType, promoted = false): void {
    this.board[s] = encodePiece(army, type, promoted);
  }
  remove(s: Square): void {
    this.board[s] = 0;
  }

  isActive(a: Army): boolean {
    return this.status[a] === 'active';
  }
  activeArmies(): Army[] {
    return ARMIES.filter((a) => this.isActive(a));
  }

  /** Are these two armies opponents? In Teams, partners are not. (RULES.md §11) */
  areEnemies(a: Army, b: Army): boolean {
    if (a === b) return false;
    if (this.rules.mode === 'teams' && PARTNER[a] === b) return false;
    return true;
  }

  kingSquare(a: Army): Square {
    const want = encodePiece(a, 'k');
    const wantPromoted = want | PROMOTED_BIT;
    for (let s = 0; s < NSQ; s++) {
      const c = this.board[s];
      if (c === want || c === wantPromoted) return s;
    }
    return -1;
  }

  /* ---------------- turn order ---------------- */

  /** Next active army after `a`, clockwise. Returns `a` itself if nobody else is active. */
  nextActive(a: Army): Army {
    const start = ARMY_INDEX[a];
    for (let i = 1; i <= 4; i++) {
      const cand = ARMIES[(start + i) % 4];
      if (this.isActive(cand)) return cand;
    }
    return a;
  }

  /**
   * Set the side to move and expire any en passant rights belonging to it.
   *
   * This implements the four-way en passant window (RULES.md §6): a right created by army X
   * survives exactly one turn for each opponent and dies the moment X is on move again.
   */
  private setTurn(a: Army): void {
    this.turn = a;
    if (this.ep.length > 0) this.ep = this.ep.filter((e) => e.army !== a);
  }

  /* ---------------- make / unmake ---------------- */

  makeMove(m: Move): void {
    const movedCode = this.board[m.from];

    this.undoStack.push({
      move: m,
      castling: {
        red: { ...this.castling.red }, blue: { ...this.castling.blue },
        yellow: { ...this.castling.yellow }, green: { ...this.castling.green },
      },
      ep: this.ep.map((e) => ({ ...e })),
      halfmove: this.halfmove,
      turn: this.turn,
      movedPieceCode: movedCode,
      status: { ...this.status },
    });

    const mover = codeArmy(movedCode);

    if (m.capturedSq !== null) this.board[m.capturedSq] = 0;
    this.board[m.from] = 0;

    if (m.promotion !== null) {
      this.board[m.to] = encodePiece(
        mover, m.promotion,
        m.promotion === 'q' && this.rules.promotedQueenIsOnePoint,
      );
    } else {
      this.board[m.to] = movedCode;
    }

    if (m.castle !== null) {
      const rookFromFile = m.castle === 'short' ? 8 : 1;
      const rookToFile = m.castle === 'short' ? 6 : 4;
      const rf = fromOwn(mover, rookFromFile, 1);
      const rt = fromOwn(mover, rookToFile, 1);
      this.board[rt] = this.board[rf];
      this.board[rf] = 0;
    }

    this.updateCastlingRights(mover, m);

    this.halfmove = m.piece === 'p' || m.captured !== null ? 0 : this.halfmove + 1;
    this.ply++;

    this.setTurn(this.nextActive(mover));

    if (m.doubleStep) {
      const [f, r] = toOwn(mover, m.to);
      this.ep.push({ passed: fromOwn(mover, f, r - 1), victim: m.to, army: mover });
    }
  }

  unmakeMove(): void {
    const u = this.undoStack.pop();
    if (u === undefined) throw new Error('unmakeMove with empty undo stack');
    const m = u.move;
    const mover = codeArmy(u.movedPieceCode);

    if (m.castle !== null) {
      const rookFromFile = m.castle === 'short' ? 8 : 1;
      const rookToFile = m.castle === 'short' ? 6 : 4;
      const rf = fromOwn(mover, rookFromFile, 1);
      const rt = fromOwn(mover, rookToFile, 1);
      this.board[rf] = this.board[rt];
      this.board[rt] = 0;
    }

    this.board[m.to] = 0;
    this.board[m.from] = u.movedPieceCode;

    if (m.capturedSq !== null && m.captured !== null && m.capturedArmy !== null) {
      this.board[m.capturedSq] = encodePiece(m.capturedArmy, m.captured, m.capturedPromoted);
    }

    this.castling = u.castling;
    this.ep = u.ep;
    this.halfmove = u.halfmove;
    this.turn = u.turn;
    this.status = u.status;
    this.ply--;
  }

  private updateCastlingRights(mover: Army, m: Move): void {
    if (m.piece === 'k') {
      this.castling[mover] = { short: false, long: false };
    } else if (m.piece === 'r') {
      const [f, r] = toOwn(mover, m.from);
      if (r === 1 && f === 8) this.castling[mover].short = false;
      if (r === 1 && f === 1) this.castling[mover].long = false;
    }
    // A rook captured on its home square also kills that army's right on that side.
    if (m.captured === 'r' && m.capturedArmy !== null && m.capturedSq !== null) {
      const [cf, cr] = toOwn(m.capturedArmy, m.capturedSq);
      if (cr === 1 && cf === 8) this.castling[m.capturedArmy].short = false;
      if (cr === 1 && cf === 1) this.castling[m.capturedArmy].long = false;
    }
  }

  /**
   * Distinct key for repetition detection. (RULES.md §13)
   *
   * Encodes the board with String.fromCharCode rather than Buffer: Buffer is a Node-only
   * global and would break this package the moment it runs in a browser or React Native,
   * which is exactly what the engine-purity rule exists to prevent.
   */
  positionKey(): string {
    const cast = ARMIES.map(
      (a) => `${this.castling[a].short ? 'S' : '-'}${this.castling[a].long ? 'L' : '-'}`,
    ).join('');
    const eps = this.ep.map((e) => `${e.army}:${e.passed}`).sort().join(',');
    const st = ARMIES.map((a) => this.status[a][0]).join('');
    let board = '';
    for (let i = 0; i < this.board.length; i++) board += String.fromCharCode(this.board[i]);
    return `${board}|${this.turn}|${st}|${cast}|${eps}`;
  }
}
