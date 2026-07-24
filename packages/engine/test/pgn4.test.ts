import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  PGN4_VERSION, ENGINE_VERSION, formatMove, parseMoveText, readPgn4, writePgn4,
} from '../src/pgn4.ts';
import { Game } from '../src/game.ts';
import { Position, FFA_RULES, TEAMS_RULES } from '../src/position.ts';
import { serializeFen4, startingPosition } from '../src/fen4.ts';
import { generateLegal } from '../src/movegen.ts';
import { parseSquare, squareName, ARMIES } from '../src/geometry.ts';
import type { Army, PieceType, Ruleset } from '../src/types.ts';

function build(pieces: Record<string, string>, rules: Ruleset = FFA_RULES): Position {
  const p = new Position(rules);
  const LET: Record<string, Army> = { r: 'red', b: 'blue', y: 'yellow', g: 'green' };
  for (const [sq, tok] of Object.entries(pieces)) {
    p.put(parseSquare(sq), LET[tok[0]], tok[1].toLowerCase() as PieceType);
  }
  p.castling = {
    red: { short: false, long: false }, blue: { short: false, long: false },
    yellow: { short: false, long: false }, green: { short: false, long: false },
  };
  return p;
}

const FAR_KINGS = { d3: 'rK', a4: 'bK', k12: 'yK', n11: 'gK' } as const;

const move = (pos: Position, from: string, to: string, army: Army = pos.turn) =>
  generateLegal(pos, army).find(
    (m) => squareName(m.from) === from && squareName(m.to) === to,
  )!;

describe('move notation', () => {
  test('quiet pawn and piece moves', () => {
    const pos = startingPosition();
    assert.equal(formatMove(pos, move(pos, 'g2', 'g4')), 'g2-g4');
    assert.equal(formatMove(pos, move(pos, 'j1', 'i3')), 'Nj1-i3');
  });

  test('captures use x', () => {
    const pos = build({ ...FAR_KINGS, h5: 'rR', h8: 'yQ' });
    assert.equal(formatMove(pos, move(pos, 'h5', 'h8', 'red')), 'Rh5xh8');
  });

  test('castling', () => {
    const pos = build({ h1: 'rK', d1: 'rR', k1: 'rR', a4: 'bK', k12: 'yK', n11: 'gK' });
    pos.castling.red = { short: true, long: true };
    const cs = generateLegal(pos, 'red').filter((m) => m.castle !== null);
    assert.equal(formatMove(pos, cs.find((m) => m.castle === 'short')!), 'O-O');
    assert.equal(formatMove(pos, cs.find((m) => m.castle === 'long')!), 'O-O-O');
  });

  test('promotion', () => {
    const pos = build({ ...FAR_KINGS, g7: 'rP' });
    assert.equal(formatMove(pos, move(pos, 'g7', 'g8', 'red')), 'g7-g8=Q+',
      'the new queen checks Yellow on k12 down the g8-h9-i10-j11-k12 diagonal');
  });

  test('en passant is marked explicitly', () => {
    const pos = build({ ...FAR_KINGS, g2: 'rP', h4: 'yP' });
    pos.makeMove(generateLegal(pos, 'red').find((m) => m.doubleStep)!);
    pos.turn = 'yellow';
    const ep = generateLegal(pos, 'yellow')
      .find((m) => m.capturedSq !== null && m.capturedSq !== m.to)!;
    assert.equal(formatMove(pos, ep), 'h4xg3e.p.');
  });

  test('a check suffix is added, but never a mate suffix', () => {
    // Mate cannot be known when a move is played — it is only assessed on the victim's
    // turn (RULES.md §8) — so "#" is deliberately absent from the notation.
    const pos = build({ d1: 'rK', e14: 'bR', h10: 'bR', a4: 'bK', k12: 'yK', n11: 'gK' });
    pos.turn = 'blue';
    const text = formatMove(pos, move(pos, 'h10', 'd10', 'blue'));
    assert.equal(text, 'Rh10-d10+');
    assert.equal(text.includes('#'), false);
  });

  test('formatting leaves the position untouched', () => {
    const pos = startingPosition();
    const before = serializeFen4(pos);
    for (const m of generateLegal(pos, 'red')) formatMove(pos, m);
    assert.equal(serializeFen4(pos), before);
  });
});

describe('move parsing', () => {
  test('round-trips every legal move in the opening position', () => {
    const pos = startingPosition();
    for (const a of ARMIES) {
      for (const m of generateLegal(pos, a)) {
        const text = formatMove(pos, m);
        const back = parseMoveText(pos, text, a);
        assert.ok(back !== null, `failed to parse "${text}"`);
        assert.equal(back.from, m.from, text);
        assert.equal(back.to, m.to, text);
        assert.equal(back.promotion, m.promotion, text);
      }
    }
  });

  test('tolerates a missing check suffix', () => {
    const pos = build({ d1: 'rK', e14: 'bR', h10: 'bR', a4: 'bK', k12: 'yK', n11: 'gK' });
    pos.turn = 'blue';
    assert.ok(parseMoveText(pos, 'Rh10-d10', 'blue') !== null);
    assert.ok(parseMoveText(pos, 'Rh10-d10+', 'blue') !== null);
  });

  test('refuses moves that are not legal', () => {
    const pos = startingPosition();
    assert.equal(parseMoveText(pos, 'g2-g5', 'red'), null, 'three-square pawn push');
    assert.equal(parseMoveText(pos, 'Qg1-g8', 'red'), null, 'blocked queen');
    assert.equal(parseMoveText(pos, 'nonsense', 'red'), null);
    assert.equal(parseMoveText(pos, '--', 'red'), null);
  });

  test('underpromotion parses only where the ruleset allows it', () => {
    const teams = build({ ...FAR_KINGS, g10: 'rP' }, TEAMS_RULES);
    assert.ok(parseMoveText(teams, 'g10-g11=N', 'red') !== null);
    const ffa = build({ ...FAR_KINGS, g7: 'rP' }, FFA_RULES);
    assert.equal(parseMoveText(ffa, 'g7-g8=N', 'red'), null, 'FFA has no underpromotion');
    assert.ok(parseMoveText(ffa, 'g7-g8=Q', 'red') !== null);
  });
});

describe('PGN4 documents', () => {
  function randomGame(plies: number, rules: Ruleset = FFA_RULES, seed = 4242): Game {
    let s = seed;
    const rnd = (n: number): number => {
      s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
      return s % n;
    };
    const g = Game.create(rules);
    g.startingFen = serializeFen4(startingPosition(rules));
    for (let i = 0; i < plies && !g.result().over; i++) {
      const ms = g.legalMoves();
      if (ms.length === 0) break;
      g.play(ms[rnd(ms.length)]);
    }
    return g;
  }

  test('a written game replays to exactly the same position', () => {
    const g = randomGame(80);
    const pgn = writePgn4(g);
    const { game: replayed } = readPgn4(pgn);
    assert.equal(replayed.moves.length, g.moves.length);
    assert.equal(serializeFen4(replayed.pos), serializeFen4(g.pos));
    for (const a of ARMIES) assert.equal(replayed.pos.points[a], g.pos.points[a], `${a} points`);
  });

  test('round-trips in Teams mode too', () => {
    const g = randomGame(80, TEAMS_RULES, 777);
    const { game: replayed, tags } = readPgn4(writePgn4(g));
    assert.equal(tags.Mode, 'teams');
    assert.equal(replayed.rules.promotionRank, 11);
    assert.equal(serializeFen4(replayed.pos), serializeFen4(g.pos));
  });

  test('writing is stable — the same game always produces the same text', () => {
    const g = randomGame(40);
    assert.equal(writePgn4(g), writePgn4(g));
  });

  test('records ruleset and versions, so history survives a rules change', () => {
    const pgn = writePgn4(randomGame(8));
    const { tags } = readPgn4(pgn);
    assert.equal(tags.Pgn4Version, String(PGN4_VERSION));
    assert.equal(tags.EngineVersion, ENGINE_VERSION);
    assert.equal(tags.Variant, FFA_RULES.id);
    assert.equal(tags.Mode, 'ffa');
    assert.ok(tags.StartPos.length > 0);
  });

  test('custom tags are preserved', () => {
    const pgn = writePgn4(randomGame(8), { Event: 'Test Cup', Red: 'alice', Blue: 'bot:reaper' });
    const { tags } = readPgn4(pgn);
    assert.equal(tags.Event, 'Test Cup');
    assert.equal(tags.Red, 'alice');
    assert.equal(tags.Blue, 'bot:reaper');
  });

  test('movetext is one numbered line per round with four seats', () => {
    const g = randomGame(8);
    const body = writePgn4(g).split('\n\n')[1].trim().split('\n');
    assert.equal(body.length, 2, 'eight plies is two rounds');
    assert.match(body[0], /^1\. /);
    assert.equal(body[0].split(' .. ').length, 4);
  });

  test('an illegal move in the movetext is rejected loudly, not silently skipped', () => {
    const pgn = writePgn4(randomGame(8)).replace(/^1\. \S+/m, '1. g2-g9');
    assert.throws(() => readPgn4(pgn), /not a legal move/);
  });

  test('a game carrying points and eliminations round-trips its outcome', () => {
    const g = new Game(build({ ...FAR_KINGS, h5: 'rR', h8: 'yQ' }));
    g.startingFen = serializeFen4(g.pos);
    g.play(move(g.pos, 'h5', 'h8', 'red'));
    const { game: back } = readPgn4(writePgn4(g));
    assert.equal(back.pos.points.red, 9);
    assert.equal(serializeFen4(back.pos), serializeFen4(g.pos));
  });
});
