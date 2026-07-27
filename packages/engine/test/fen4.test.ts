import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  OUR_START, CHESSCOM_START, parseBoard, serializeBoard, parseFen4, serializeFen4,
  startingPosition,
} from '../src/fen4.ts';
import { ARMIES, SQUARES, parseSquare, squareName, toOwn } from '../src/geometry.ts';
import { TEAMS_RULES } from '../src/position.ts';
import { generateLegal } from '../src/movegen.ts';
import type { Army, PieceType } from '../src/types.ts';

describe('FEN4 parsing', () => {
  test('starting position has 64 pieces, 16 per army', () => {
    const pos = startingPosition();
    let total = 0;
    const per: Record<string, number> = { red: 0, blue: 0, yellow: 0, green: 0 };
    for (const s of SQUARES) {
      const p = pos.at(s);
      if (p !== null) { total++; per[p.army]++; }
    }
    assert.equal(total, 64);
    for (const a of ARMIES) assert.equal(per[a], 16, a);
  });

  test('no piece sits on an unplayable square', () => {
    const pos = startingPosition();
    for (let s = 0; s < 196; s++) {
      if (!SQUARES.includes(s)) assert.equal(pos.codeAt(s), 0, `square index ${s}`);
    }
  });

  test('kings and queens are on the house-rule squares', () => {
    const pos = startingPosition();
    const kings: Record<Army, string> = { red: 'h1', blue: 'a7', yellow: 'g14', green: 'n8' };
    const queens: Record<Army, string> = { red: 'g1', blue: 'a8', yellow: 'h14', green: 'n7' };
    for (const a of ARMIES) {
      assert.deepEqual(pos.at(parseSquare(kings[a])), { army: a, type: 'k', promoted: false });
      assert.deepEqual(pos.at(parseSquare(queens[a])), { army: a, type: 'q', promoted: false });
    }
  });

  test('every army reads R N B Q K B N R from its own left — queen-left house rule', () => {
    const pos = startingPosition();
    for (const a of ARMIES) {
      const line: PieceType[] = [];
      for (const s of SQUARES) {
        const p = pos.at(s);
        if (p === null || p.army !== a) continue;
        const [f, r] = toOwn(a, s);
        if (r === 1) line[f - 1] = p.type;
      }
      assert.equal(line.join(''), 'rnbqkbnr', `${a} back line`);
    }
  });

  test('every army has 8 pawns on ownRank 2', () => {
    const pos = startingPosition();
    for (const a of ARMIES) {
      let n = 0;
      for (const s of SQUARES) {
        const p = pos.at(s);
        if (p === null || p.army !== a || p.type !== 'p') continue;
        assert.equal(toOwn(a, s)[1], 2, `${a} pawn on ${squareName(s)}`);
        n++;
      }
      assert.equal(n, 8, a);
    }
  });

  test('our position differs from chess.com at exactly a7 a8 n7 n8', () => {
    const ours = parseBoard(OUR_START);
    const theirs = parseBoard(CHESSCOM_START);
    const diff = SQUARES.filter((s) => ours.codeAt(s) !== theirs.codeAt(s)).map(squareName);
    assert.deepEqual(diff.sort(), ['a7', 'a8', 'n7', 'n8']);
  });

  test('chess.com position is mirror-symmetric: Blue and Green are king-left', () => {
    const cc = parseBoard(CHESSCOM_START);
    for (const a of ARMIES) {
      const line: PieceType[] = [];
      for (const s of SQUARES) {
        const p = cc.at(s);
        if (p === null || p.army !== a) continue;
        const [f, r] = toOwn(a, s);
        if (r === 1) line[f - 1] = p.type;
      }
      const expected = a === 'red' || a === 'yellow' ? 'rnbqkbnr' : 'rnbkqbnr';
      assert.equal(line.join(''), expected, `${a} back line`);
    }
  });
});

describe('FEN4 round-tripping', () => {
  test('board field round-trips exactly', () => {
    assert.equal(serializeBoard(parseBoard(OUR_START)), OUR_START.replace(/\s+/g, ''));
    assert.equal(serializeBoard(parseBoard(CHESSCOM_START)), CHESSCOM_START.replace(/\s+/g, ''));
  });

  test('full FEN4 round-trips through parse and serialise', () => {
    const pos = startingPosition();
    pos.points.red = 17;
    pos.status.green = 'checkmated';
    pos.castling.blue.short = false;
    pos.halfmove = 9;
    const fen = serializeFen4(pos);
    const back = parseFen4(fen);
    assert.equal(serializeFen4(back), fen);
    assert.equal(back.points.red, 17);
    assert.equal(back.status.green, 'checkmated');
    assert.equal(back.castling.blue.short, false);
    assert.equal(back.castling.blue.long, true);
    assert.equal(back.halfmove, 9);
  });

  test('a bare board field parses without a header', () => {
    const pos = parseFen4(OUR_START);
    assert.equal(pos.turn, 'red');
    assert.equal(serializeBoard(pos), OUR_START);
  });

  test('en passant rights survive a round-trip — a wire-transferred position must not lose moves', () => {
    // A bot worker or server receives positions as FEN4. Before this field existed, the
    // receiver silently lost every en passant capture: the right simply vanished in transit.
    const pos = startingPosition();
    const dbl = generateLegal(pos, 'red').find((m) => m.doubleStep === true);
    assert.ok(dbl !== undefined);
    pos.makeMove(dbl);
    assert.equal(pos.ep.length, 1);

    const back = parseFen4(serializeFen4(pos));
    assert.equal(back.ep.length, 1);
    assert.deepEqual(back.ep[0], pos.ep[0]);
    assert.equal(serializeFen4(back), serializeFen4(pos));
  });

  test('legacy FEN4 strings without the en passant field still parse', () => {
    const pos = startingPosition();
    const modern = serializeFen4(pos);
    const legacy = modern.replace('-x-', '-');
    const back = parseFen4(legacy);
    assert.deepEqual(back.ep, []);
    assert.equal(serializeBoard(back), serializeBoard(pos));
  });

  test('promoted (1-point) queens survive a round-trip', () => {
    const pos = startingPosition();
    pos.put(parseSquare('h7'), 'red', 'q', true);
    const back = parseBoard(serializeBoard(pos));
    const p = back.at(parseSquare('h7'));
    assert.deepEqual(p, { army: 'red', type: 'q', promoted: true });
  });

  test('malformed input is rejected loudly', () => {
    assert.throws(() => parseBoard('14/14/14'), /must have 14 rows/);
    assert.throws(() => parseBoard(OUR_START.replace('3,yR', '4,yR')), /width/);
    assert.throws(() => parseBoard(OUR_START.replace('yR', 'zR')), /unknown army/);
    assert.throws(() => parseBoard(OUR_START.replace('yR', 'yZ')), /unknown piece/);
  });
});

describe('ruleset config', () => {
  test('mode is configuration, not a fork', () => {
    const ffa = startingPosition();
    const teams = startingPosition(TEAMS_RULES);
    assert.equal(serializeBoard(ffa), serializeBoard(teams));
    assert.equal(ffa.rules.promotionRank, 8);
    assert.equal(teams.rules.promotionRank, 11);
    assert.equal(ffa.rules.allowUnderpromotion, false);
    assert.equal(teams.rules.allowUnderpromotion, true);
  });

  test('partners are not enemies in Teams, but are in FFA', () => {
    const ffa = startingPosition();
    const teams = startingPosition(TEAMS_RULES);
    assert.equal(ffa.areEnemies('red', 'yellow'), true);
    assert.equal(teams.areEnemies('red', 'yellow'), false);
    assert.equal(teams.areEnemies('red', 'blue'), true);
    assert.equal(teams.areEnemies('red', 'red'), false);
  });
});
