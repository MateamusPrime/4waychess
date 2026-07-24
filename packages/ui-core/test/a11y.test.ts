import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARMIES, FFA_RULES, Position, SQUARES, generateLegal, parseSquare, squareName, startingPosition,
} from '@4wc/engine';
import type { Army, PieceType } from '@4wc/engine';
import {
  defaultCursor, describeArmies, describeBoard, describeMove, describeScores, describeSquare,
  describeTargets, describeTurn, moveCursor, pieceName,
} from '../src/a11y.ts';
import { toCell } from '../src/view.ts';
import type { Direction } from '../src/a11y.ts';

function build(pieces: Record<string, string>): Position {
  const p = new Position(FFA_RULES);
  const LET: Record<string, Army> = { r: 'red', b: 'blue', y: 'yellow', g: 'green' };
  for (const [sq, tok] of Object.entries(pieces)) {
    p.put(parseSquare(sq), LET[tok[0]], tok[1].toLowerCase() as PieceType);
  }
  return p;
}

const sq = (n: string) => parseSquare(n);

describe('keyboard cursor', () => {
  test('arrows move in SCREEN space, so they feel right from every seat', () => {
    // From each seat's own king, "up" must move away from that player, i.e. forward.
    const kings: Record<Army, string> = { red: 'h1', blue: 'a7', yellow: 'g14', green: 'n8' };
    for (const seat of ARMIES) {
      const from = sq(kings[seat]);
      const to = moveCursor(seat, from, 'up');
      assert.notEqual(to, from, `${seat} should be able to move up`);
      assert.equal(toCell(seat, to).row, toCell(seat, from).row - 1, `${seat} up`);
      assert.equal(toCell(seat, to).col, toCell(seat, from).col, `${seat} same column`);
    }
  });

  test('all four directions move exactly one screen cell where one exists', () => {
    const from = sq('h7'); // deep in the middle, all neighbours playable
    const deltas: Record<Direction, [number, number]> = {
      up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0],
    };
    for (const seat of ARMIES) {
      for (const dir of Object.keys(deltas) as Direction[]) {
        const to = moveCursor(seat, from, dir);
        const [dc, dr] = deltas[dir];
        assert.equal(toCell(seat, to).col, toCell(seat, from).col + dc, `${seat} ${dir} col`);
        assert.equal(toCell(seat, to).row, toCell(seat, from).row + dr, `${seat} ${dir} row`);
      }
    }
  });

  test('the cursor steps OVER cut corners rather than getting stuck', () => {
    // Moving left along rank 4 from d4: c4/b4/a4 are playable (left arm), so it just moves.
    assert.equal(moveCursor('red', sq('d4'), 'left'), sq('c4'));
    // Moving down from d4 reaches d3, d2, d1 — all playable.
    assert.equal(moveCursor('red', sq('d4'), 'down'), sq('d3'));
    // But moving left along rank 1 from d1 must skip the whole cut corner and find nothing,
    // so the cursor stays put rather than landing off the board.
    assert.equal(moveCursor('red', sq('d1'), 'left'), sq('d1'));
  });

  test('the cursor never lands on an unplayable square, from anywhere, in any direction', () => {
    const dirs: Direction[] = ['up', 'down', 'left', 'right'];
    for (const seat of ARMIES) {
      for (const from of SQUARES) {
        for (const dir of dirs) {
          const to = moveCursor(seat, from, dir);
          assert.ok(SQUARES.includes(to), `${seat} ${squareName(from)} ${dir}`);
        }
      }
    }
  });

  test('the board edge stops the cursor instead of wrapping', () => {
    assert.equal(moveCursor('red', sq('a7'), 'left'), sq('a7'));
    assert.equal(moveCursor('red', sq('n7'), 'right'), sq('n7'));
    assert.equal(moveCursor('red', sq('h1'), 'down'), sq('h1'));
    assert.equal(moveCursor('red', sq('h14'), 'up'), sq('h14'));
  });

  test('a long walk across the board terminates and stays on the board', () => {
    let cur = sq('a7');
    for (let i = 0; i < 40; i++) cur = moveCursor('red', cur, 'right');
    assert.equal(squareName(cur), 'n7', 'should have run to the far edge and stopped');
  });

  test('the cursor starts on your own king so orientation is immediate', () => {
    const pos = startingPosition();
    const kings: Record<Army, string> = { red: 'h1', blue: 'a7', yellow: 'g14', green: 'n8' };
    for (const seat of ARMIES) {
      assert.equal(squareName(defaultCursor(pos, seat)), kings[seat], seat);
    }
  });

  test('with no king it falls back to any piece, then to -1', () => {
    const noKing = build({ h5: 'rR' });
    assert.equal(squareName(defaultCursor(noKing, 'red')), 'h5');
    assert.equal(defaultCursor(noKing, 'blue'), -1);
  });
});

describe('spoken descriptions', () => {
  test('piece names, including the promoted queen', () => {
    assert.equal(pieceName('n'), 'knight');
    assert.equal(pieceName('q'), 'queen');
    assert.equal(pieceName('q', true), 'promoted queen');
  });

  test('squares describe their occupant or say they are empty', () => {
    const pos = startingPosition();
    assert.equal(describeSquare(pos, sq('h1')), 'red king on h1');
    assert.equal(describeSquare(pos, sq('h7')), 'h7, empty');
  });

  test('a dead army is announced as eliminated', () => {
    const pos = startingPosition();
    pos.status.blue = 'checkmated';
    assert.match(describeSquare(pos, sq('a7')), /eliminated/);
  });

  test('moves describe origin, destination, captures and promotions', () => {
    const pos = startingPosition();
    const quiet = generateLegal(pos, 'red').find((m) => squareName(m.to) === 'g4')!;
    assert.equal(describeMove(pos, quiet), 'red pawn g2 to g4');

    const cap = build({ d3: 'rK', a4: 'bK', k12: 'yK', n11: 'gK', h5: 'rR', h8: 'yQ' });
    const take = generateLegal(cap, 'red').find((m) => squareName(m.to) === 'h8')!;
    assert.equal(describeMove(cap, take), 'red rook h5 to h8, capturing yellow queen');
  });

  test('en passant is called out by name', () => {
    const pos = build({ d3: 'rK', a4: 'bK', k12: 'yK', n11: 'gK', g2: 'rP', h4: 'yP' });
    pos.makeMove(generateLegal(pos, 'red').find((m) => m.doubleStep)!);
    pos.turn = 'yellow';
    const ep = generateLegal(pos, 'yellow')
      .find((m) => m.capturedSq !== null && m.capturedSq !== m.to)!;
    assert.match(describeMove(pos, ep), /en passant/);
  });

  test('promotion is announced', () => {
    const pos = build({ d3: 'rK', a4: 'bK', k12: 'yK', n11: 'gK', g7: 'rP' });
    const promo = generateLegal(pos, 'red').find((m) => m.promotion !== null)!;
    assert.match(describeMove(pos, promo), /promoting to queen/);
  });

  test('castling is described as castling, not as a king move', () => {
    const pos = build({ h1: 'rK', d1: 'rR', k1: 'rR', a4: 'bK', k12: 'yK', n11: 'gK' });
    pos.castling.red = { short: true, long: true };
    const short = generateLegal(pos, 'red').find((m) => m.castle === 'short')!;
    const long = generateLegal(pos, 'red').find((m) => m.castle === 'long')!;
    assert.equal(describeMove(pos, short), 'red castles short');
    assert.equal(describeMove(pos, long), 'red castles long');
  });

  test('turn announcements distinguish your check from someone else\'s', () => {
    const pos = startingPosition();
    assert.equal(describeTurn(pos), 'red to move');
    assert.match(describeTurn(pos, ['red']), /you are in check/);
    const other = describeTurn(pos, ['blue', 'yellow']);
    assert.match(other, /blue and yellow in check/);
    assert.equal(/you are in check/.test(other), false);
  });

  test('scores are read highest first — the FFA win condition made audible', () => {
    const pos = startingPosition();
    pos.points.yellow = 30;
    pos.points.red = 12;
    assert.match(describeScores(pos), /^yellow 30, red 12/);
  });

  test('army status lists who is playing and who is out', () => {
    const pos = startingPosition();
    assert.match(describeArmies(pos), /4 armies playing/);
    pos.status.green = 'resigned';
    const out = describeArmies(pos);
    assert.match(out, /3 armies playing/);
    assert.match(out, /green resigned/);
  });

  test('the board summary orients a new screen-reader user', () => {
    const text = describeBoard(startingPosition(), 'blue');
    assert.match(text, /160 squares/);
    assert.match(text, /You are blue/);
    assert.match(text, /red to move/);
    assert.match(text, /Scores/);
  });

  test('targets are counted and listed, and captures flagged', () => {
    const pos = build({ d3: 'rK', a4: 'bK', k12: 'yK', n11: 'gK', h5: 'rR', h8: 'yQ' });
    const moves = generateLegal(pos, 'red').filter((m) => m.from === sq('h5'));
    const text = describeTargets(pos, moves);
    assert.match(text, new RegExp(`^${moves.length} moves:`));
    assert.match(text, /h8 capture/);
    assert.equal(describeTargets(pos, []), 'no legal moves');
  });
});
