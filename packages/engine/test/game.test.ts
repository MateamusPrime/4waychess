import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/game.ts';
import { Position, FFA_RULES, TEAMS_RULES } from '../src/position.ts';
import { startingPosition, parseFen4, serializeFen4 } from '../src/fen4.ts';
import { generateLegal } from '../src/movegen.ts';
import { isInCheck } from '../src/attacks.ts';
import { parseSquare, squareName, ARMIES } from '../src/geometry.ts';
import {
  PIECE_VALUES, armiesCheckedBy, captureValue, checkBonusFor, kingCount, materialValue, newChecks,
} from '../src/scoring.ts';
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

const findMove = (g: Game, from: string, to: string) =>
  g.legalMoves().find((m) => squareName(m.from) === from && squareName(m.to) === to)!;

describe('scoring (RULES.md §10)', () => {
  test('bishops outrank knights — the inversion from standard chess', () => {
    assert.equal(PIECE_VALUES.b, 5);
    assert.equal(PIECE_VALUES.n, 3);
    assert.ok(PIECE_VALUES.b > PIECE_VALUES.n);
  });

  test('capturing awards the piece value', () => {
    const pos = build({ ...FAR_KINGS, h5: 'rR', h8: 'yB' });
    const m = generateLegal(pos, 'red').find((x) => squareName(x.to) === 'h8')!;
    assert.equal(captureValue(pos, m), 5);
  });

  test('a promoted 1-point queen is worth 1, not 9', () => {
    const pos = build({ ...FAR_KINGS, h5: 'rR' });
    pos.put(parseSquare('h8'), 'yellow', 'q', true);
    const m = generateLegal(pos, 'red').find((x) => squareName(x.to) === 'h8')!;
    assert.equal(captureValue(pos, m), 1);
    pos.put(parseSquare('h8'), 'yellow', 'q', false);
    const m2 = generateLegal(pos, 'red').find((x) => squareName(x.to) === 'h8')!;
    assert.equal(captureValue(pos, m2), 9);
  });

  test('dead pieces award zero — they are terrain (RULES.md §9)', () => {
    const pos = build({ ...FAR_KINGS, h5: 'rR', h8: 'yQ' });
    const m = generateLegal(pos, 'red').find((x) => squareName(x.to) === 'h8')!;
    assert.equal(captureValue(pos, m), 9);
    pos.status.yellow = 'checkmated';
    assert.equal(captureValue(pos, m), 0);
  });

  test('a spare king is worth 3, a last king 20', () => {
    const single = build({ ...FAR_KINGS, k11: 'rR' });
    assert.equal(kingCount(single, 'green'), 1);
    const m = generateLegal(single, 'red').find((x) => squareName(x.to) === 'n11')!;
    assert.equal(captureValue(single, m), 20);

    const spare = build({ ...FAR_KINGS, k11: 'rR', m6: 'gK' });
    assert.equal(kingCount(spare, 'green'), 2);
    const m2 = generateLegal(spare, 'red').find((x) => squareName(x.to) === 'n11')!;
    assert.equal(captureValue(spare, m2), 3);
  });

  test('checking two opponents at once pays 5, three pays 20', () => {
    // Red queen on h7 checks Blue (d7) and Yellow (h11) along rank and file.
    const two = build({ d3: 'rK', d7: 'bK', h11: 'yK', n11: 'gK', h7: 'rQ' });
    assert.deepEqual(armiesCheckedBy(two, 'red').sort(), ['blue', 'yellow']);
    assert.equal(checkBonusFor(armiesCheckedBy(two, 'red').length), 5);

    const three = build({ d3: 'rK', d7: 'bK', h11: 'yK', h4: 'gK', h7: 'rQ' });
    assert.equal(checkBonusFor(armiesCheckedBy(three, 'red').length), 20);

    const one = build({ d3: 'rK', d7: 'bK', k12: 'yK', n11: 'gK', h7: 'rQ' });
    assert.equal(checkBonusFor(armiesCheckedBy(one, 'red').length), 0);
  });

  test('only checks a move DELIVERS count — standing checks are not farmable', () => {
    // Red rook on k1 already checks Yellow on k12 and will keep doing so. If standing checks
    // counted, Red could collect the two-player bonus every time it checked anyone else with
    // an unrelated piece, forever.
    // The queen sits on h4, not h3: from h3 the diagonal h3-g4-f5-e6-d7 would already check
    // Blue, and long-range lines like that are easy to lay accidentally on a 160-square board.
    const pos = build({ d3: 'rK', d7: 'bK', k12: 'yK', n11: 'gK', k1: 'rR', h4: 'rQ' });
    const before = armiesCheckedBy(pos, 'red');
    assert.deepEqual(before, ['yellow'], 'Yellow is already in check, from the k1 rook');

    const deliver = generateLegal(pos, 'red')
      .find((m) => squareName(m.from) === 'h4' && squareName(m.to) === 'h7')!;
    pos.makeMove(deliver);
    const after = armiesCheckedBy(pos, 'red');
    assert.deepEqual(after.sort(), ['blue', 'yellow'], 'two are now in check');
    assert.deepEqual(newChecks(before, after), ['blue'], 'but only Blue was newly checked');
    assert.equal(checkBonusFor(newChecks(before, after).length), 0, 'so no bonus');
  });

  test('material value ignores kings', () => {
    const pos = build({ ...FAR_KINGS, h5: 'rR', h6: 'rN', h7: 'rB' });
    assert.equal(materialValue(pos, 'red'), 5 + 3 + 5);
  });
});

describe('Game — captures and points', () => {
  test('points accrue to the capturing army', () => {
    const g = new Game(build({ ...FAR_KINGS, h5: 'rR', h8: 'yQ' }));
    const events = g.play(findMove(g, 'h5', 'h8'));
    assert.equal(g.pos.points.red, 9);
    assert.equal(events.find((e) => e.type === 'capture')?.points, 9);
    for (const a of ['blue', 'yellow', 'green'] as Army[]) assert.equal(g.pos.points[a], 0);
  });

  test('a multi-check bonus is awarded on top of the capture', () => {
    const g = new Game(build({ d3: 'rK', d7: 'bK', h11: 'yK', n11: 'gK', h4: 'rQ', h7: 'yP' }));
    assert.deepEqual(armiesCheckedBy(g.pos, 'red'), [], 'nobody is in check beforehand');
    g.play(findMove(g, 'h4', 'h7'));
    // Qh7 newly checks Blue along rank 7 and Yellow up the h-file.
    // 1 for the pawn, plus 5 for the double check.
    assert.equal(g.pos.points.red, 6);
  });
});

describe('Game — elimination and end conditions (RULES.md §8, §12)', () => {
  test('checkmate is NOT applied until the victim\'s own turn arrives', () => {
    // Blue mates Red on d1: Rd10 checks down the d-file and covers d2; Re14 covers e1 and e2.
    // But Yellow and Green must still take their turns before Red is eliminated — the rule
    // with no chess analogue (RULES.md §8).
    const g = new Game(build({ d1: 'rK', e14: 'bR', h10: 'bR', a4: 'bK', k12: 'yK', n11: 'gK' }));
    g.pos.turn = 'blue';

    const deliver = findMove(g, 'h10', 'd10');
    const afterMate = g.play(deliver);
    assert.equal(g.pos.status.red, 'active', 'still alive immediately after the mating move');
    assert.equal(g.pos.points.blue, 0, 'and the bonus is not paid yet');
    assert.equal(afterMate.some((e) => e.type === 'checkmate'), false);

    assert.equal(g.turn, 'yellow');
    g.play(g.legalMoves()[0]);
    assert.equal(g.pos.status.red, 'active', 'still alive after Yellow moves');

    assert.equal(g.turn, 'green');
    const events = g.play(g.legalMoves()[0]);

    // Now Red's turn came round, and only now is the mate real.
    assert.equal(g.pos.status.red, 'checkmated');
    assert.equal(g.pos.points.blue, 20);
    assert.equal(events.some((e) => e.type === 'checkmate' && e.other === 'blue'), true);
  });

  test('a mate that evaporates before the victim\'s turn is no mate at all', () => {
    const g = new Game(build({ d1: 'rK', e14: 'bR', h10: 'bR', a4: 'bK', k12: 'yK', n11: 'gK' }));
    g.pos.turn = 'blue';
    g.play(findMove(g, 'h10', 'd10'));

    // Blue is eliminated before Red's turn comes round, so the check dies with it.
    g.resign('blue');
    assert.equal(g.pos.status.red, 'active');
    assert.ok(g.legalMoves('red').length > 0, 'Red is free again');
  });

  test('a stalemated player is eliminated and paid 20 themselves', () => {
    // Yellow seals Red's corner without checking: Rk2 covers d2 and e2 along rank 2,
    // Re14 covers e1. Nothing attacks d1 itself.
    const g = new Game(build({ d1: 'rK', k5: 'yR', e14: 'yR', a4: 'bK', k12: 'yK', n11: 'gK' }));
    g.pos.turn = 'yellow';
    g.play(findMove(g, 'k5', 'k2'));
    assert.equal(g.pos.status.red, 'active', 'not yet — Green moves first');

    g.play(g.legalMoves()[0]); // Green
    assert.equal(g.pos.status.red, 'stalemated');
    assert.equal(g.pos.points.red, 20, 'self-stalemate pays the stalemated player');
    assert.equal(g.pos.points.yellow, 0, 'and pays the sealer nothing');
  });

  test('turn order skips eliminated armies', () => {
    const g = Game.create();
    g.pos.status.blue = 'resigned';
    g.play(g.legalMoves()[0]);
    assert.equal(g.turn, 'yellow');
  });

  test('FFA ends when one player remains, and the highest score wins', () => {
    const g = new Game(build({ ...FAR_KINGS, h5: 'rR' }));
    g.pos.points.red = 12;
    g.pos.points.yellow = 40;
    g.resign('blue');
    g.resign('green');
    assert.equal(g.result().over, false, 'two players left');
    g.resign('yellow');
    assert.deepEqual(g.result(), { over: true, reason: 'elimination', winners: ['yellow'] });
  });

  test('FFA can be won by an eliminated player — it is a points race', () => {
    const g = new Game(build({ ...FAR_KINGS, h5: 'rR' }));
    g.pos.points.yellow = 99;
    g.resign('yellow');
    g.resign('blue');
    g.resign('green');
    assert.deepEqual(g.result().winners, ['yellow']);
  });

  test('tied leaders share the win', () => {
    const g = new Game(build({ ...FAR_KINGS, h5: 'rR' }));
    g.pos.points.red = 7;
    g.pos.points.blue = 7;
    g.resign('yellow');
    g.resign('green');
    g.resign('blue');
    assert.deepEqual(g.result().winners.sort(), ['blue', 'red']);
  });
});

describe('king capture (RULES.md §9, §10)', () => {
  test('REGRESSION: losing your last king eliminates you', () => {
    // Reported from a live game: "someone took the king as a piece and the team stayed alive".
    // King capture is reachable because checkmate is only assessed on the victim's turn (§8) —
    // a checked player's king can be taken by a THIRD party first. The victim used to survive
    // with no king, and since isInCheck reports false when there is no king to check, they
    // became permanently immune to check and checkmate and played on forever.
    const pos = build({ d3: 'rK', h7: 'bK', k12: 'yK', n11: 'gK', h5: 'rR', b7: 'bP' });
    const g = new Game(pos);
    const capture = g.legalMoves().find((m) => squareName(m.to) === 'h7')!;
    assert.equal(capture.captured, 'k', 'the king really is capturable here');

    const events = g.play(capture);
    assert.equal(g.pos.points.red, 20, 'a king is worth 20 (§10)');
    assert.equal(g.pos.status.blue, 'captured', 'and the victim is out');
    assert.equal(g.legalMoves('blue').length, 0, 'a dead army generates no moves');
    assert.notEqual(g.pos.turn, 'blue', 'and never gets another turn');
    assert.ok(events.some((e) => e.type === 'captured' && e.army === 'blue'));
  });

  test('a kingless army can never be checked, which is exactly why it must be eliminated', () => {
    // Pins the mechanism rather than just the symptom: without elimination this army would be
    // immortal, because "in check" is undefined for a player with no king.
    const pos = build({ d3: 'rK', h7: 'bK', k12: 'yK', n11: 'gK', h5: 'rR' });
    const g = new Game(pos);
    g.play(g.legalMoves().find((m) => squareName(m.to) === 'h7')!);
    assert.equal(g.pos.kingSquare('blue'), -1);
    assert.equal(isInCheck(g.pos, 'blue'), false, 'no king means never in check');
    assert.equal(g.pos.isActive('blue'), false, 'so elimination cannot rely on check at all');
  });

  test('a SPARE king absorbs the capture — the army plays on', () => {
    // Teams inheritance can leave one army holding two kings; capturing one is worth 3, not 20
    // (§10), and must not end them.
    const pos = build({ d3: 'rK', h7: 'bK', e5: 'bK', k12: 'yK', n11: 'gK', h5: 'rR' });
    const g = new Game(pos);
    g.play(g.legalMoves().find((m) => squareName(m.to) === 'h7')!);
    assert.equal(g.pos.points.red, 3, 'a spare king is worth 3');
    assert.equal(g.pos.status.blue, 'active', 'and the army survives on its remaining king');
    assert.ok(g.legalMoves('blue').length > 0);
  });

  test('capturing the last king can end the game outright', () => {
    const pos = build({ d3: 'rK', h7: 'bK', h5: 'rR' });
    const g = new Game(pos);
    g.pos.status.yellow = 'resigned';
    g.pos.status.green = 'resigned';
    g.play(g.legalMoves().find((m) => squareName(m.to) === 'h7')!);
    assert.equal(g.result().over, true);
    assert.equal(g.result().reason, 'elimination');
  });

  test('the captured status survives a FEN4 round trip', () => {
    const pos = build({ d3: 'rK', h7: 'bK', k12: 'yK', n11: 'gK', h5: 'rR' });
    const g = new Game(pos);
    g.play(g.legalMoves().find((m) => squareName(m.to) === 'h7')!);
    const back = parseFen4(serializeFen4(g.pos));
    assert.equal(back.status.blue, 'captured');
  });
});

describe('Game — Teams (RULES.md §11)', () => {
  test('resigning transfers surviving pieces to the partner', () => {
    const g = new Game(build({
      d3: 'rK', a4: 'bK', k12: 'yK', n11: 'gK', h5: 'rR', h6: 'rN',
    }, TEAMS_RULES));
    assert.equal(kingCount(g.pos, 'yellow'), 1);
    const events = g.resign('red');
    assert.equal(g.pos.status.red, 'resigned');
    assert.equal(g.pos.at(parseSquare('h5'))?.army, 'yellow', 'rook inherited');
    assert.equal(g.pos.at(parseSquare('h6'))?.army, 'yellow', 'knight inherited');
    assert.equal(kingCount(g.pos, 'yellow'), 2, 'and a spare king');
    assert.ok(events.some((e) => e.type === 'inherit' && e.other === 'red'));
  });

  test('the game ends when both members of one team are out', () => {
    const g = new Game(build(FAR_KINGS, TEAMS_RULES));
    g.resign('red');
    assert.equal(g.result().over, false, 'Yellow still holds the team up');
    g.resign('yellow');
    assert.deepEqual(g.result(), {
      over: true, reason: 'team-eliminated', winners: ['blue', 'green'],
    });
  });

  test('an inherited spare king is worth 3 when captured', () => {
    const g = new Game(build({
      d3: 'rK', a4: 'bK', k12: 'yK', n11: 'gK', k11: 'bR',
    }, TEAMS_RULES));
    g.resign('red');
    // Red's king is now Yellow's spare, sitting on d3.
    assert.equal(kingCount(g.pos, 'yellow'), 2);
    const pos = g.pos;
    const cap = generateLegal(pos, 'blue').find((m) => squareName(m.to) === 'k12');
    if (cap !== undefined) assert.equal(captureValue(pos, cap), 3);
  });
});

describe('Game — draw conditions (RULES.md §13)', () => {
  test('threefold repetition ends the game', () => {
    // Four knights shuffling between two squares repeats the position every round.
    const g = new Game(build({
      d3: 'rK', a4: 'bK', k12: 'yK', n11: 'gK',
      h5: 'rN', c6: 'bN', h10: 'yN', l8: 'gN',
    }));
    const shuffle = (from: string, to: string): void => {
      const m = findMove(g, from, to);
      if (m !== undefined && !g.result().over) g.play(m);
    };
    const cycle: [string, string][][] = [
      [['h5', 'j6'], ['c6', 'e7'], ['h10', 'j9'], ['l8', 'j7']],
      [['j6', 'h5'], ['e7', 'c6'], ['j9', 'h10'], ['j7', 'l8']],
    ];
    for (let i = 0; i < 8 && !g.result().over; i++) {
      for (const [from, to] of cycle[i % 2]) shuffle(from, to);
    }
    assert.equal(g.result().over, true);
    assert.equal(g.result().reason, 'repetition');
  });

  test('the fifty-round rule ends the game', () => {
    const g = new Game(build({ ...FAR_KINGS, h5: 'rR' }));
    g.pos.halfmove = g.rules.moveRuleRounds * 4 - 1;
    g.play(g.legalMoves().find((m) => m.captured === null && m.piece !== 'p')!);
    assert.equal(g.result().over, true);
    assert.equal(g.result().reason, 'move-rule');
  });

  test('a capture or pawn move resets the counter', () => {
    const g = Game.create();
    g.play(g.legalMoves().find((m) => m.piece === 'n')!);
    assert.equal(g.pos.halfmove, 1);
    g.play(g.legalMoves().find((m) => m.piece === 'p')!);
    assert.equal(g.pos.halfmove, 0);
  });
});

describe('Game — invariants under random play', () => {
  /**
   * Note: random play almost never produces checkmate — a 160-square board with 64 pieces
   * gives random movers far too much room. That is a fact about random play, not a defect,
   * and it is precisely why bots need real evaluation rather than noise (Phase 2). So this
   * test asserts INVARIANTS rather than termination; each end condition is proven separately
   * above with a constructed position.
   */
  test('invariants hold across 40 random games in both modes', () => {
    let s = 24680;
    const rnd = (n: number): number => {
      s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
      return s % n;
    };

    for (let i = 0; i < 40; i++) {
      const g = Game.create(i % 3 === 2 ? TEAMS_RULES : FFA_RULES);
      let lastPoints = 0;

      for (let ply = 0; ply < 400 && !g.result().over; ply++) {
        const moves = g.legalMoves();
        if (moves.length === 0) break;

        assert.ok(g.pos.isActive(g.turn), 'the side to move is always active');
        g.play(moves[rnd(moves.length)]);

        const total = ARMIES.reduce((sum, a) => sum + g.pos.points[a], 0);
        assert.ok(total >= lastPoints, 'points never decrease');
        lastPoints = total;
        for (const a of ARMIES) {
          assert.ok(Number.isInteger(g.pos.points[a]) && g.pos.points[a] >= 0, `${a} points`);
        }
        // An army that is out never comes back, and never has a turn.
        for (const a of ARMIES) {
          if (!g.pos.isActive(a)) assert.notEqual(g.turn, a, `${a} is out but on move`);
        }
      }

      const r = g.result();
      if (r.over) {
        assert.notEqual(r.reason, 'none');
        if (g.rules.mode === 'ffa' && r.winners.length > 0) {
          const best = Math.max(...ARMIES.map((a) => g.pos.points[a]));
          for (const w of r.winners) assert.equal(g.pos.points[w], best, 'winners are top scorers');
        }
      }
    }
  });

  test('playing after the game is over is refused', () => {
    const g = new Game(build({ ...FAR_KINGS, h5: 'rR' }));
    g.resign('blue');
    g.resign('yellow');
    g.resign('green');
    assert.equal(g.result().over, true);
    assert.throws(() => g.play(generateLegal(g.pos, 'red')[0]), /game is over/);
    assert.throws(() => g.resign('red'), /game is over/);
  });
});
