/**
 * PGN4 — game serialisation. Format version 1.
 *
 * This is the substrate for saved games, the analysis board, shareable links, replays, puzzle
 * generation and retroactive rating recomputation (RULES.md §15). It is versioned from the
 * first byte written, because changing it once games exist means migrating all of them.
 *
 * Every game records its ruleset id and engine version, so a stored game can always be
 * replayed under the rules it was actually played under — which is what makes it possible to
 * change the rules later without invalidating history.
 *
 * Movetext is one numbered line per round, four moves separated by " .. ", with "--" marking a
 * seat that did not move (eliminated, or the game ended mid-round):
 *
 *   1. g2-g4 .. b7-d7 .. h13-h11 .. m8-k8
 *   2. Nj1-i3 .. Na5-c6 .. -- .. Nn10-l9
 *
 * Moves are LONG algebraic (from-square, separator, to-square). Long algebraic is deliberate:
 * short algebraic needs disambiguation rules, and with four armies on 160 squares those rules
 * would be a bug farm for no benefit a machine format cares about.
 */

import type { Army, Move, PieceType } from './types.ts';
import { ARMIES, squareName } from './geometry.ts';
import { FFA_RULES, Position, TEAMS_RULES, codeArmy } from './position.ts';
import { parseFen4, serializeFen4, startingPosition } from './fen4.ts';
import { generateLegal } from './movegen.ts';
import { armiesCheckedBy, newChecks } from './scoring.ts';
import { Game } from './game.ts';

export const PGN4_VERSION = 1;
export const ENGINE_VERSION = '0.1.0';

const PIECE_LETTER: Readonly<Record<PieceType, string>> = {
  p: '', n: 'N', b: 'B', r: 'R', q: 'Q', k: 'K',
};

/**
 * Render a move in long algebraic.
 *
 * `+` means the move delivers check to one opponent, `++` to two or more. There is deliberately
 * no `#` suffix: checkmate is only determined when the mated player's turn arrives (RULES.md §8),
 * so at the moment a move is played it cannot know whether it mates.
 */
export function formatMove(pos: Position, move: Move): string {
  if (move.castle === 'short') return withCheck(pos, move, 'O-O');
  if (move.castle === 'long') return withCheck(pos, move, 'O-O-O');

  const sep = move.captured === null ? '-' : 'x';
  let text = PIECE_LETTER[move.piece] + squareName(move.from) + sep + squareName(move.to);
  if (move.capturedSq !== null && move.capturedSq !== move.to) text += 'e.p.';
  if (move.promotion !== null) text += `=${move.promotion.toUpperCase()}`;
  return withCheck(pos, move, text);
}

function withCheck(pos: Position, move: Move, text: string): string {
  // Derive the mover from the board rather than from pos.turn: formatMove is also used to
  // render moves for an army that is not currently on move (analysis, hint display).
  const code = pos.board[move.from];
  const mover = code === 0 ? pos.turn : codeArmy(code);

  // "+" means this move DELIVERS check, not that some opponent happens to be in check.
  // Standing checks are routine in four-way chess — two opponents move between your check and
  // the victim's reply — so marking them would put "+" on nearly every move.
  const before = armiesCheckedBy(pos, mover);
  pos.makeMove(move);
  const delivered = newChecks(before, armiesCheckedBy(pos, mover));
  pos.unmakeMove();

  if (delivered.length >= 2) return `${text}++`;
  return delivered.length === 1 ? `${text}+` : text;
}

/**
 * Parse one move token against the legal moves of `army`.
 *
 * Matching against generated legal moves rather than reconstructing the move from text means
 * the parser cannot invent an illegal move, and it stays correct automatically as the rules
 * evolve. Returns null if the token matches nothing.
 */
export function parseMoveText(pos: Position, text: string, army: Army = pos.turn): Move | null {
  const t = text.trim().replace(/[+#]+$/, '');
  if (t === '' || t === '--') return null;
  const legal = generateLegal(pos, army);

  if (t === 'O-O') return legal.find((m) => m.castle === 'short') ?? null;
  if (t === 'O-O-O') return legal.find((m) => m.castle === 'long') ?? null;

  const m = /^([NBRQK]?)([a-n]\d{1,2})([-x])([a-n]\d{1,2})(e\.p\.)?(?:=([NBRQ]))?$/.exec(t);
  if (m === null) return null;
  const [, letter, from, , to, , promo] = m;

  return legal.find((mv) =>
    squareName(mv.from) === from
    && squareName(mv.to) === to
    && PIECE_LETTER[mv.piece] === letter
    && (promo === undefined
      ? mv.promotion === null
      : mv.promotion === promo.toLowerCase())) ?? null;
}

/* ------------------------------------------------------------------ *
 * Documents
 * ------------------------------------------------------------------ */

export interface Pgn4Tags {
  [key: string]: string;
}

export interface Pgn4Document {
  tags: Pgn4Tags;
  game: Game;
}

/** Serialise a played game. */
export function writePgn4(game: Game, extraTags: Pgn4Tags = {}): string {
  const startFen = game.startingFen !== ''
    ? game.startingFen
    : serializeFen4(startingPosition(game.rules));

  const tags: Pgn4Tags = {
    Pgn4Version: String(PGN4_VERSION),
    Variant: game.rules.id,
    Mode: game.rules.mode,
    EngineVersion: ENGINE_VERSION,
    StartPos: startFen,
    ...extraTags,
    Points: ARMIES.map((a) => game.pos.points[a]).join(','),
    Status: ARMIES.map((a) => game.pos.status[a]).join(','),
    Result: game.result().over ? game.result().winners.join(',') || 'draw' : '*',
  };

  const header = Object.entries(tags).map(([k, v]) => `[${k} "${v}"]`).join('\n');

  // Replay from the start so each move can be rendered in the position it was actually played.
  const pos = parseFen4(startFen, game.rules);
  const rendered: string[] = [];
  for (const mv of game.moves) {
    rendered.push(formatMove(pos, mv));
    pos.makeMove(mv);
  }

  const lines: string[] = [];
  for (let i = 0; i < rendered.length; i += 4) {
    lines.push(`${i / 4 + 1}. ${rendered.slice(i, i + 4).join(' .. ')}`);
  }

  return `${header}\n\n${lines.join('\n')}\n`;
}

/** Parse a PGN4 document and replay it into a Game. Throws on an unplayable move. */
export function readPgn4(text: string): Pgn4Document {
  const tags: Pgn4Tags = {};
  for (const m of text.matchAll(/\[(\w+)\s+"([^"]*)"\]/g)) tags[m[1]] = m[2];

  const rules = tags.Mode === 'teams' ? TEAMS_RULES : FFA_RULES;
  const startFen = tags.StartPos ?? serializeFen4(startingPosition(rules));
  const game = new Game(parseFen4(startFen, rules), startFen);

  const body = text.replace(/\[[^\]]*\]/g, '');
  const tokens = body
    .replace(/\d+\.\s*/g, ' ')
    .replace(/\.\./g, ' ')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s !== '' && s !== '--' && s !== '*');

  for (const tok of tokens) {
    const mv = parseMoveText(game.pos, tok, game.pos.turn);
    if (mv === null) {
      throw new Error(
        `PGN4: "${tok}" is not a legal move for ${game.pos.turn} at ply ${game.moves.length + 1}`,
      );
    }
    game.play(mv);
    if (game.result().over) break;
  }

  return { tags, game };
}
