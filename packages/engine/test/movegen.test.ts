import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Position, FFA_RULES, TEAMS_RULES } from '../src/position.ts';
import { startingPosition, serializeFen4 } from '../src/fen4.ts';
import { generateLegal, generatePseudoLegal, turnOutcome } from '../src/movegen.ts';
import { isInCheck, checkingArmies, isAttacked } from '../src/attacks.ts';
import { perft, perftDetailed } from '../src/perft.ts';
import { ARMIES, fromOwn, parseSquare, squareName, toOwn } from '../src/geometry.ts';
import type { Army, PieceType, Ruleset } from '../src/types.ts';

/** Build a sparse position: { h1: 'rK', a7: 'bK', ... }. */
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

/** Four kings tucked in corners of the arms, out of everyone's way. */
const FAR_KINGS = { d3: 'rK', a4: 'bK', k12: 'yK', n11: 'gK' } as const;

const names = (p: Position, a: Army): string[] =>
  generateLegal(p, a).map((m) => `${squareName(m.from)}-${squareName(m.to)}`).sort();

describe('opening position', () => {
  test('every army has exactly 20 legal moves — as in standard chess', () => {
    const pos = startingPosition();
    for (const a of ARMIES) {
      const ms = generateLegal(pos, a);
      assert.equal(ms.length, 20, a);
      assert.equal(ms.filter((m) => m.piece === 'p').length, 16, `${a} pawn moves`);
      assert.equal(ms.filter((m) => m.piece === 'n').length, 4, `${a} knight moves`);
    }
  });

  test('nobody is in check at the start', () => {
    const pos = startingPosition();
    for (const a of ARMIES) assert.equal(isInCheck(pos, a), false, a);
  });

  test('FROZEN perft baselines (RISKS.md R4)', () => {
    const pos = startingPosition();
    assert.equal(perft(pos, 1), 20);
    assert.equal(perft(pos, 2), 395);
    assert.equal(perft(pos, 3), 7800);
  });

  test('no captures, castles, promotions or en passant exist in the first round', () => {
    const d = perftDetailed(startingPosition(), 3);
    assert.deepEqual(
      { captures: d.captures, enPassant: d.enPassant, castles: d.castles, promotions: d.promotions },
      { captures: 0, enPassant: 0, castles: 0, promotions: 0 },
    );
  });

  test('Red f2-f3 unveils a cross-army pin: the g1 queen pins Blue\'s b6 pawn to a7', () => {
    // The diagonal g1-f2-e3-d4-c5-b6-a7 links Red's queen to Blue's king, blocked only by
    // Red's own f2 pawn. Vacating f2 pins Blue's b6 pawn — an interaction with no analogue
    // in two-player chess, between armies that never face each other.
    const pos = startingPosition();
    assert.ok(names(pos, 'blue').includes('b6-c6'));

    const f2f3 = generateLegal(pos, 'red')
      .find((m) => squareName(m.from) === 'f2' && squareName(m.to) === 'f3');
    assert.ok(f2f3 !== undefined);
    pos.makeMove(f2f3);

    const after = names(pos, 'blue');
    assert.equal(after.includes('b6-c6'), false, 'pinned pawn must not move off the diagonal');
    assert.equal(after.includes('b6-d6'), false);
    assert.equal(generateLegal(pos, 'blue').length, 18);
  });

  test('Red d2-d4 collides with Blue\'s own double-step square', () => {
    const pos = startingPosition();
    const d2d4 = generateLegal(pos, 'red')
      .find((m) => squareName(m.from) === 'd2' && squareName(m.to) === 'd4');
    assert.ok(d2d4 !== undefined);
    pos.makeMove(d2d4);
    assert.equal(names(pos, 'blue').includes('b4-d4'), false);
    assert.equal(generateLegal(pos, 'blue').length, 19);
  });
});

describe('make / unmake', () => {
  test('restores position exactly over a random playout', () => {
    let seed = 12345;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const pos = startingPosition();
    const stack: string[] = [];
    for (let i = 0; i < 120; i++) {
      const moves = generateLegal(pos, pos.turn);
      if (moves.length === 0) break;
      stack.push(serializeFen4(pos));
      pos.makeMove(moves[rnd(moves.length)]);
    }
    while (stack.length > 0) {
      pos.unmakeMove();
      assert.equal(serializeFen4(pos), stack.pop());
    }
  });

  test('turn advances clockwise and skips eliminated armies', () => {
    const pos = startingPosition();
    assert.equal(pos.turn, 'red');
    pos.status.blue = 'checkmated';
    pos.makeMove(generateLegal(pos, 'red')[0]);
    assert.equal(pos.turn, 'yellow', 'must skip the eliminated Blue');
  });
});

describe('pawns', () => {
  test('each army advances toward the opposite edge', () => {
    const pos = startingPosition();
    for (const a of ARMIES) {
      for (const m of generateLegal(pos, a).filter((x) => x.piece === 'p')) {
        const [, fr] = toOwn(a, m.from);
        const [, tr] = toOwn(a, m.to);
        assert.ok(tr > fr, `${a} pawn must move forward in its own frame`);
      }
    }
  });

  test('FFA promotes on ownRank 8 to a 1-point queen, no underpromotion', () => {
    const pos = build({ ...FAR_KINGS, g7: 'rP' });
    const proms = generateLegal(pos, 'red').filter((m) => m.promotion !== null);
    assert.equal(proms.length, 1);
    assert.equal(proms[0].promotion, 'q');
    assert.equal(squareName(proms[0].to), 'g8');
    pos.makeMove(proms[0]);
    assert.deepEqual(pos.at(parseSquare('g8')), { army: 'red', type: 'q', promoted: true });
  });

  test('Teams promotes on ownRank 11 with underpromotion and a full-value queen', () => {
    const pos = build({ ...FAR_KINGS, g10: 'rP' }, TEAMS_RULES);
    const proms = generateLegal(pos, 'red').filter((m) => m.promotion !== null);
    assert.deepEqual(proms.map((m) => m.promotion).sort(), ['b', 'n', 'q', 'r']);
    const q = proms.find((m) => m.promotion === 'q');
    assert.ok(q !== undefined);
    pos.makeMove(q);
    assert.deepEqual(pos.at(parseSquare('g11')), { army: 'red', type: 'q', promoted: false });
  });

  test('a pawn on ownRank 7 in Teams mode does not promote', () => {
    const pos = build({ ...FAR_KINGS, g7: 'rP' }, TEAMS_RULES);
    assert.equal(generateLegal(pos, 'red').filter((m) => m.promotion !== null).length, 0);
  });

  test('double step only from ownRank 2 and only through empty squares', () => {
    const pos = build({ ...FAR_KINGS, g2: 'rP', h2: 'rP', h3: 'bP' });
    const red = names(pos, 'red');
    assert.ok(red.includes('g2-g4'), 'clear file may double-step');
    assert.equal(red.includes('h2-h4'), false, 'blocked file may not');
    assert.equal(red.includes('h2-h3'), false, 'and may not advance one either');
  });
});

describe('en passant (RULES.md §6)', () => {
  test('a double step creates a right, and an enemy pawn may take it', () => {
    const pos = build({ ...FAR_KINGS, g2: 'rP', h4: 'yP' });
    const dbl = generateLegal(pos, 'red').find((m) => m.doubleStep === true);
    assert.ok(dbl !== undefined);
    pos.makeMove(dbl);
    assert.equal(pos.ep.length, 1);
    assert.equal(squareName(pos.ep[0].passed), 'g3');
    assert.equal(squareName(pos.ep[0].victim), 'g4');

    pos.turn = 'yellow';
    const ep = generateLegal(pos, 'yellow').find((m) => m.capturedSq !== null && m.capturedSq !== m.to);
    assert.ok(ep !== undefined, 'Yellow should have an en passant capture');
    assert.equal(squareName(ep.to), 'g3');
    assert.equal(squareName(ep.capturedSq), 'g4');
    pos.makeMove(ep);
    assert.equal(pos.at(parseSquare('g4')), null, 'captured pawn removed from its landing square');
    assert.deepEqual(pos.at(parseSquare('g3')), { army: 'yellow', type: 'p', promoted: false });
  });

  test('MULTIPLE en passant rights can be live at once — a four-way-only case', () => {
    // Up to three armies may double-step before your turn comes round.
    const pos = build({ ...FAR_KINGS, g2: 'rP', b7: 'bP', h4: 'yP', d8: 'yP' });
    pos.turn = 'red';
    pos.makeMove(generateLegal(pos, 'red').find((m) => m.doubleStep === true)!);
    assert.equal(pos.turn, 'blue');
    pos.makeMove(generateLegal(pos, 'blue').find((m) => m.doubleStep === true)!);
    assert.equal(pos.turn, 'yellow');

    assert.equal(pos.ep.length, 2, 'two simultaneous en passant rights');
    const eps = generateLegal(pos, 'yellow')
      .filter((m) => m.capturedSq !== null && m.capturedSq !== m.to)
      .map((m) => squareName(m.to)).sort();
    assert.deepEqual(eps, ['c7', 'g3'], 'Yellow can take either');
  });

  test('a right expires when its owner is on move again', () => {
    const pos = build({ ...FAR_KINGS, g2: 'rP', h4: 'yP' });
    pos.makeMove(generateLegal(pos, 'red').find((m) => m.doubleStep === true)!);
    assert.equal(pos.ep.length, 1);
    for (const a of ['blue', 'yellow', 'green'] as Army[]) {
      assert.equal(pos.turn, a);
      const quiet = generateLegal(pos, a).find((m) => m.captured === null && !m.doubleStep)!;
      pos.makeMove(quiet);
    }
    assert.equal(pos.turn, 'red', 'back to the double-stepper');
    assert.equal(pos.ep.length, 0, 'right must have expired');
  });
});

describe('castling (RULES.md §7)', () => {
  test('every army can castle both ways from a cleared back line', () => {
    for (const a of ARMIES) {
      const pos = new Position(FFA_RULES);
      pos.put(fromOwn(a, 5, 1), a, 'k');
      pos.put(fromOwn(a, 1, 1), a, 'r');
      pos.put(fromOwn(a, 8, 1), a, 'r');
      for (const other of ARMIES) if (other !== a) pos.put(fromOwn(other, 5, 1), other, 'k');
      const cs = generateLegal(pos, a).filter((m) => m.castle !== null);
      assert.deepEqual(cs.map((m) => m.castle).sort(), ['long', 'short'], a);
      for (const m of cs) {
        const dest = toOwn(a, m.to)[0];
        assert.equal(dest, m.castle === 'short' ? 7 : 3, `${a} ${m.castle} king destination`);
      }
    }
  });

  test('Red castling lands on the squares named in RULES.md', () => {
    const pos = build({ h1: 'rK', d1: 'rR', k1: 'rR', a4: 'bK', k12: 'yK', n11: 'gK' });
    pos.castling.red = { short: true, long: true };
    const cs = generateLegal(pos, 'red').filter((m) => m.castle !== null);
    const short = cs.find((m) => m.castle === 'short')!;
    const long = cs.find((m) => m.castle === 'long')!;
    assert.equal(squareName(short.to), 'j1');
    assert.equal(squareName(long.to), 'f1');
    pos.makeMove(short);
    assert.deepEqual(pos.at(parseSquare('j1')), { army: 'red', type: 'k', promoted: false });
    assert.deepEqual(pos.at(parseSquare('i1')), { army: 'red', type: 'r', promoted: false });
    pos.unmakeMove();
    pos.makeMove(long);
    assert.deepEqual(pos.at(parseSquare('f1')), { army: 'red', type: 'k', promoted: false });
    assert.deepEqual(pos.at(parseSquare('g1')), { army: 'red', type: 'r', promoted: false });
  });

  test('may not castle out of, through, or into check — from any opponent', () => {
    const mk = (attacker: string): Position => {
      const p = build({ h1: 'rK', d1: 'rR', k1: 'rR', a4: 'bK', k12: 'yK', n11: 'gK', [attacker]: 'bR' });
      p.castling.red = { short: true, long: true };
      return p;
    };
    // Rook on i-file attacks i1, the square the king passes through when castling short.
    const through = mk('i8');
    assert.equal(isAttacked(through, parseSquare('i1'), 'red'), true);
    assert.equal(generateLegal(through, 'red').some((m) => m.castle === 'short'), false);
    // Rook on j-file attacks j1, the short destination.
    const into = mk('j8');
    assert.equal(generateLegal(into, 'red').some((m) => m.castle === 'short'), false);
    // Rook on h-file gives check outright: no castling at all.
    const out = mk('h8');
    assert.equal(isInCheck(out, 'red'), true);
    assert.equal(generateLegal(out, 'red').some((m) => m.castle !== null), false);
  });

  test('rights are lost when the king or the relevant rook moves', () => {
    const pos = build({ h1: 'rK', d1: 'rR', k1: 'rR', a4: 'bK', k12: 'yK', n11: 'gK' });
    pos.castling.red = { short: true, long: true };
    const rookMove = generateLegal(pos, 'red')
      .find((m) => squareName(m.from) === 'k1' && m.castle === null)!;
    pos.makeMove(rookMove);
    assert.deepEqual(pos.castling.red, { short: false, long: true });
    pos.unmakeMove();
    assert.deepEqual(pos.castling.red, { short: true, long: true }, 'unmake restores rights');
  });
});

describe('four-way legality', () => {
  test('a move is illegal if it exposes the king to ANY opponent', () => {
    // Red king h1, Red rook h4 shielding it from a Yellow rook on h9.
    const pos = build({ h1: 'rK', h4: 'rR', h9: 'yR', a4: 'bK', k12: 'yK', n11: 'gK' });
    const moves = names(pos, 'red');
    assert.equal(moves.some((m) => m.startsWith('h4-') && !m.startsWith('h4-h')), false,
      'the pinned rook may not leave the h-file');
    assert.ok(moves.includes('h4-h9'), 'but it may capture the pinner');
  });

  test('a king can be in check from two armies at once', () => {
    const pos = build({ h7: 'rK', h12: 'yR', d7: 'bR', a4: 'bK', k12: 'yK', n11: 'gK' });
    assert.deepEqual(checkingArmies(pos, 'red').sort(), ['blue', 'yellow']);
  });

  test('d1 is a true corner with exactly three escape squares', () => {
    // The cutouts make d1 the four-way equivalent of a1: c1, c2 and everything below are
    // off-board, so the king has only e1, d2 and e2.
    const pos = build({ d1: 'rK', a4: 'bK', k12: 'yK', n11: 'gK' });
    assert.deepEqual(names(pos, 'red'), ['d1-d2', 'd1-e1', 'd1-e2']);
  });

  test('checkmate is detected on the affected player\'s turn', () => {
    // Back-rank mate in the corner: the d-file rook checks and covers d2;
    // the e-file rook covers both remaining flight squares.
    const mate = build({ d1: 'rK', d14: 'yR', e14: 'yR', a4: 'bK', k12: 'yK', n11: 'gK' });
    mate.turn = 'red';
    assert.equal(isInCheck(mate, 'red'), true);
    assert.equal(generateLegal(mate, 'red').length, 0);
    assert.equal(turnOutcome(mate, 'red'), 'checkmate');
  });

  test('stalemate is detected on the affected player\'s turn', () => {
    // Same corner, but nothing attacks d1 itself: the rank-2 rook covers d2 and e2,
    // the e-file rook covers e1. No check, no move.
    const stale = build({ d1: 'rK', k2: 'yR', e14: 'yR', a4: 'bK', k12: 'yK', n11: 'gK' });
    stale.turn = 'red';
    assert.equal(isInCheck(stale, 'red'), false);
    assert.equal(generateLegal(stale, 'red').length, 0);
    assert.equal(turnOutcome(stale, 'red'), 'stalemate');
  });

  test('a mate delivered by an army that dies first is not a mate (RULES.md §8)', () => {
    // Mate is assessed only when the mated player's turn arrives. If the mating army is
    // eliminated in the meantime, the "mate" evaporates — a rule with no chess analogue.
    const pos = build({ d1: 'rK', d14: 'yR', e14: 'yR', a4: 'bK', k12: 'yK', n11: 'gK' });
    pos.turn = 'red';
    assert.equal(turnOutcome(pos, 'red'), 'checkmate');
    pos.status.yellow = 'checkmated';
    assert.equal(turnOutcome(pos, 'red'), 'normal', 'dead attackers give no check');
    assert.equal(generateLegal(pos, 'red').length, 3);
  });
});

describe('dead armies (RULES.md §9)', () => {
  test('dead pieces block movement but never give check', () => {
    const pos = build({ h1: 'rK', h9: 'yR', a4: 'bK', k12: 'yK', n11: 'gK' });
    assert.equal(isInCheck(pos, 'red'), true, 'alive Yellow rook checks');

    pos.status.yellow = 'checkmated';
    assert.equal(isInCheck(pos, 'red'), false, 'dead Yellow rook does not check');

    // Still blocks: Red rook on h4 cannot slide past the dead rook on h9.
    pos.put(parseSquare('h4'), 'red', 'r');
    const dests = names(pos, 'red').filter((m) => m.startsWith('h4-h'));
    assert.ok(dests.includes('h4-h9'), 'dead pieces remain capturable');
    assert.equal(dests.includes('h4-h10'), false, 'but cannot be slid through');
  });

  test('a dead army generates no moves and is skipped in turn order', () => {
    const pos = startingPosition();
    pos.status.blue = 'resigned';
    assert.equal(generateLegal(pos, 'blue').length, 0);
    assert.equal(generatePseudoLegal(pos, 'blue').length, 0);
    assert.equal(pos.nextActive('red'), 'yellow');
  });
});

describe('Teams mode (RULES.md §11)', () => {
  test('you cannot capture your partner, but can capture opponents', () => {
    const pos = build({ ...FAR_KINGS, h5: 'rR', h8: 'yR', e5: 'bR' }, TEAMS_RULES);
    const dests = names(pos, 'red');
    assert.equal(dests.includes('h5-h8'), false, 'Red must not capture partner Yellow');
    assert.ok(dests.includes('h5-e5'), 'Red may capture opponent Blue');
  });

  test('a partner never gives check', () => {
    const pos = build({ h1: 'rK', h9: 'yR', a4: 'bK', k12: 'yK', n11: 'gK' }, TEAMS_RULES);
    assert.equal(isInCheck(pos, 'red'), false, 'partner Yellow cannot check Red');
    const ffa = build({ h1: 'rK', h9: 'yR', a4: 'bK', k12: 'yK', n11: 'gK' }, FFA_RULES);
    assert.equal(isInCheck(ffa, 'red'), true, 'but in FFA it does');
  });
});
