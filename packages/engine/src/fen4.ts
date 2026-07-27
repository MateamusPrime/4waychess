/**
 * FEN4 — position serialisation. Format version 1.
 *
 * Board field: 14 rows separated by "/", rank 14 first down to rank 1. Within a row,
 * comma-separated tokens left to right; a number means that many empty squares, and a
 * token like "rK" is <army-initial><piece-letter>.
 *
 * Full string adds a header of hyphen-separated fields before the board:
 *   <turn>-<dead x4>-<castleShort x4>-<castleLong x4>-<points x4>-<halfmove>-<board>
 * with the four-value fields always ordered Red,Blue,Yellow,Green.
 *
 * Everything written by this engine is versioned from the first byte, because FEN4 is the
 * substrate for saved games, analysis, replays, puzzles and retroactive rating recomputation
 * (RULES.md §15). Changing it after games exist means migrating all of them.
 */

import type { Army, ArmyStatus, PieceType, Ruleset } from './types.ts';
import { ARMIES, W, idx } from './geometry.ts';
import { FFA_RULES, Position, codeArmy, codePromoted, codeType } from './position.ts';

export const FEN4_VERSION = 1;

const ARMY_LETTER: Readonly<Record<Army, string>> = {
  red: 'r', blue: 'b', yellow: 'y', green: 'g',
};
const LETTER_ARMY: Readonly<Record<string, Army>> = {
  r: 'red', b: 'blue', y: 'yellow', g: 'green',
};

/**
 * Our house starting position: queen left for ALL four armies (RULES.md §4).
 * This makes the setup 90-degree rotationally symmetric.
 */
export const OUR_START =
  '3,yR,yN,yB,yK,yQ,yB,yN,yR,3/3,yP,yP,yP,yP,yP,yP,yP,yP,3/14/' +
  'bR,bP,10,gP,gR/bN,bP,10,gP,gN/bB,bP,10,gP,gB/bQ,bP,10,gP,gK/' +
  'bK,bP,10,gP,gQ/bB,bP,10,gP,gB/bN,bP,10,gP,gN/bR,bP,10,gP,gR/' +
  '14/3,rP,rP,rP,rP,rP,rP,rP,rP,3/3,rR,rN,rB,rQ,rK,rB,rN,rR,3';

/**
 * The authoritative chess.com position, retained for import compatibility.
 * Differs from OUR_START at exactly four squares — a7 a8 n7 n8 — because the real game is
 * mirror-symmetric, giving Blue and Green king-left. (RULES.md §4.2)
 */
export const CHESSCOM_START =
  '3,yR,yN,yB,yK,yQ,yB,yN,yR,3/3,yP,yP,yP,yP,yP,yP,yP,yP,3/14/' +
  'bR,bP,10,gP,gR/bN,bP,10,gP,gN/bB,bP,10,gP,gB/bK,bP,10,gP,gQ/' +
  'bQ,bP,10,gP,gK/bB,bP,10,gP,gB/bN,bP,10,gP,gN/bR,bP,10,gP,gR/' +
  '14/3,rP,rP,rP,rP,rP,rP,rP,rP,3/3,rR,rN,rB,rQ,rK,rB,rN,rR,3';

const STATUS_CODE: Readonly<Record<ArmyStatus, string>> = {
  active: '0', checkmated: '1', stalemated: '2', resigned: '3', timeout: '4',
};
const CODE_STATUS: Readonly<Record<string, ArmyStatus>> = {
  '0': 'active', '1': 'checkmated', '2': 'stalemated', '3': 'resigned', '4': 'timeout',
};

/** Parse just the board field into a Position. */
export function parseBoard(board: string, rules: Ruleset = FFA_RULES): Position {
  const pos = new Position(rules);
  const rows = board.trim().split('/');
  if (rows.length !== W) throw new Error(`FEN4 board must have ${W} rows, got ${rows.length}`);

  rows.forEach((row, i) => {
    const y = 13 - i; // row 0 is rank 14
    let x = 0;
    for (const tok of row.split(',')) {
      const t = tok.trim();
      if (t === '') continue;
      if (/^\d+$/.test(t)) {
        x += Number(t);
        continue;
      }
      const army = LETTER_ARMY[t[0].toLowerCase()];
      if (army === undefined) throw new Error(`FEN4: unknown army in token "${t}"`);
      const type = t[1].toLowerCase() as PieceType;
      if (!'pnbrqk'.includes(type)) throw new Error(`FEN4: unknown piece in token "${t}"`);
      // A trailing "+" marks a promoted (1-point) queen.
      pos.put(idx(x, y), army, type, t.endsWith('+'));
      x++;
    }
    if (x !== W) throw new Error(`FEN4: row for rank ${y + 1} has width ${x}, expected ${W}`);
  });

  return pos;
}

/** Serialise just the board field. */
export function serializeBoard(pos: Position): string {
  const rows: string[] = [];
  for (let i = 0; i < W; i++) {
    const y = 13 - i;
    const toks: string[] = [];
    let empty = 0;
    for (let x = 0; x < W; x++) {
      const code = pos.codeAt(idx(x, y));
      if (code === 0) {
        empty++;
        continue;
      }
      if (empty > 0) {
        toks.push(String(empty));
        empty = 0;
      }
      const army = codeArmy(code);
      const type = codeType(code);
      toks.push(ARMY_LETTER[army] + type.toUpperCase() + (codePromoted(code) ? '+' : ''));
    }
    if (empty > 0) toks.push(String(empty));
    rows.push(toks.join(','));
  }
  return rows.join('/');
}

/** Parse a full FEN4 string, or a bare board field. */
export function parseFen4(fen: string, rules: Ruleset = FFA_RULES): Position {
  const trimmed = fen.trim();
  const firstSlash = trimmed.indexOf('/');
  const headerEnd = trimmed.lastIndexOf('-', firstSlash === -1 ? trimmed.length : firstSlash);

  if (headerEnd === -1) return parseBoard(trimmed, rules);

  const header = trimmed.slice(0, headerEnd).split('-');
  const board = trimmed.slice(headerEnd + 1);
  const pos = parseBoard(board, rules);

  const four = (s: string | undefined): string[] =>
    s === undefined ? [] : s.split(',').map((v) => v.trim());

  if (header[0] !== undefined && header[0].trim() !== '') {
    const a = LETTER_ARMY[header[0].trim().toLowerCase()];
    if (a !== undefined) pos.turn = a;
  }
  const dead = four(header[1]);
  const cs = four(header[2]);
  const cl = four(header[3]);
  const pts = four(header[4]);
  ARMIES.forEach((a, i) => {
    if (dead[i] !== undefined) pos.status[a] = CODE_STATUS[dead[i]] ?? 'active';
    if (cs[i] !== undefined) pos.castling[a].short = cs[i] === '1';
    if (cl[i] !== undefined) pos.castling[a].long = cl[i] === '1';
    if (pts[i] !== undefined) pos.points[a] = Number(pts[i]) || 0;
  });
  if (header[5] !== undefined && header[5].trim() !== '') {
    pos.halfmove = Number(header[5].trim()) || 0;
  }
  // En passant rights: "e" + one "passed.victim.armyLetter" group per right, or absent/"x".
  // Optional seventh field so pre-existing strings (which lack it) still parse.
  if (header[6] !== undefined && header[6].startsWith('e')) {
    for (const tok of header[6].slice(1).split(';')) {
      const m = /^(\d+)\.(\d+)\.([rbyg])$/.exec(tok.trim());
      if (m !== null) {
        pos.ep.push({ passed: Number(m[1]), victim: Number(m[2]), army: LETTER_ARMY[m[3]] });
      }
    }
  }
  return pos;
}

/** Serialise a full FEN4 string. */
export function serializeFen4(pos: Position): string {
  const t = ARMY_LETTER[pos.turn].toUpperCase();
  const dead = ARMIES.map((a) => STATUS_CODE[pos.status[a]]).join(',');
  const cs = ARMIES.map((a) => (pos.castling[a].short ? '1' : '0')).join(',');
  const cl = ARMIES.map((a) => (pos.castling[a].long ? '1' : '0')).join(',');
  const pts = ARMIES.map((a) => String(pos.points[a])).join(',');
  // En passant rights ride along: a position sent over a wire (bot worker, server) must carry
  // them, or the receiver silently loses legal moves. "x" keeps the field count stable.
  const eps = pos.ep.length === 0
    ? 'x'
    : `e${pos.ep.map((e) => `${e.passed}.${e.victim}.${ARMY_LETTER[e.army]}`).join(';')}`;
  return `${t}-${dead}-${cs}-${cl}-${pts}-${pos.halfmove}-${eps}-${serializeBoard(pos)}`;
}

/** A fresh game in our house ruleset. */
export function startingPosition(rules: Ruleset = FFA_RULES): Position {
  return parseBoard(OUR_START, rules);
}
