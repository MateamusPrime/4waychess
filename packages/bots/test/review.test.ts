import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  FFA_RULES, Position, generateLegal, parseSquare, squareName, startingPosition,
} from '@4wc/engine';
import type { Army, Move, PieceType } from '@4wc/engine';
import { uniformWeights } from '../src/eval.ts';
import { makeRng } from '../src/rng.ts';
import { pickMove, scoreRootMove } from '../src/search.ts';
import {
  GRADE_THRESHOLDS, REVIEW_SEARCH, gradeLoss, reviewMove, suggestMove,
} from '../src/review.ts';
import { makeBot } from '../src/personalities.ts';

function build(pieces: Record<string, string>): Position {
  const p = new Position(FFA_RULES);
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

/** Red's queen on h5 is attacked by Yellow's i6 pawn, which j7 defends — so Qxi6 is poisoned. */
function queenEnPrise(): Position {
  const pos = build({ ...FAR_KINGS, h5: 'rQ', i6: 'yP', j7: 'yP', e2: 'rP', d2: 'rN' });
  pos.turn = 'red';
  return pos;
}

const find = (pos: Position, from: string, to: string): Move => {
  const m = generateLegal(pos, pos.turn).find(
    (x) => squareName(x.from) === from && squareName(x.to) === to,
  );
  assert.ok(m !== undefined, `${from}-${to} must be legal`);
  return m;
};

describe('grading', () => {
  test('thresholds map loss to grades, and the best move is always "best"', () => {
    assert.equal(gradeLoss(0, true), 'best');
    assert.equal(gradeLoss(9, true), 'best');
    assert.equal(gradeLoss(GRADE_THRESHOLDS.good - 0.01, false), 'good');
    assert.equal(gradeLoss(GRADE_THRESHOLDS.good, false), 'inaccuracy');
    assert.equal(gradeLoss(GRADE_THRESHOLDS.inaccuracy, false), 'mistake');
    assert.equal(gradeLoss(GRADE_THRESHOLDS.mistake, false), 'blunder');
  });
});

describe('reviewMove', () => {
  test('leaving the queen en prise is a blunder, and the review names a queen move instead', () => {
    const pos = queenEnPrise();
    const v = reviewMove(pos, find(pos, 'e2', 'e3'))!;
    assert.equal(v.grade, 'blunder', `loss ${v.loss.toFixed(2)}`);
    assert.equal(v.best.piece, 'q');
    assert.equal(v.best.captured, null, 'the defended pawn is poisoned — not the fix');
  });

  test('playing the engine\'s own best move grades "best" with zero loss', () => {
    const pos = queenEnPrise();
    const first = reviewMove(pos, find(pos, 'e2', 'e3'))!;
    const again = reviewMove(pos, first.best)!;
    assert.equal(again.grade, 'best');
    assert.equal(again.loss, 0);
  });

  test('leaves the position exactly as it found it', () => {
    const pos = queenEnPrise();
    const before = JSON.stringify([...pos.board, pos.turn, pos.points]);
    reviewMove(pos, find(pos, 'e2', 'e3'));
    assert.equal(JSON.stringify([...pos.board, pos.turn, pos.points]), before);
  });

  test('scoreRootMove agrees with pickMove on a move both score', () => {
    // Review compares a pickMove score with a scoreRootMove score, so the two must be the same
    // measurement for any move they both see.
    const pos = startingPosition();
    const opts = {
      ...REVIEW_SEARCH, temperature: 0, weights: uniformWeights(), rng: makeRng(1),
    };
    const r = pickMove(pos, opts);
    for (const c of r.considered.slice(0, 3)) {
      const s = scoreRootMove(pos, c.move, opts).score;
      assert.ok(Math.abs(s - c.score) < 1e-9, `${s} vs ${c.score}`);
    }
  });
});

describe('suggestMove', () => {
  test('rescues the attacked queen, deterministically', () => {
    const a = suggestMove(queenEnPrise(), 8_000)!;
    const b = suggestMove(queenEnPrise(), 8_000)!;
    assert.deepEqual([a.from, a.to], [b.from, b.to]);
    assert.equal(a.piece, 'q');
    assert.equal(a.captured, null);
  });

  test('returns null only when there is no legal move', () => {
    const mate = build({ d1: 'rK', d14: 'yR', e14: 'yR', a4: 'bK', k12: 'yK', n11: 'gK' });
    mate.turn = 'red';
    assert.equal(suggestMove(mate), null);
  });
});

describe('makeBot budget override', () => {
  test('an explicit budget is honoured; an undefined one keeps the tier default', () => {
    const pos = startingPosition();
    const tiny = makeBot('opportunist', 'expert', 5, { nodeBudget: 400 }).pick(pos, 'red');
    assert.ok(tiny !== null, 'a tiny budget still returns a move');
    const legal = generateLegal(pos, 'red').map((m) => `${m.from}-${m.to}`);
    assert.ok(legal.includes(`${tiny.from}-${tiny.to}`));

    const plain = makeBot('opportunist', 'medium', 5).pick(startingPosition(), 'red')!;
    const undef = makeBot('opportunist', 'medium', 5, { nodeBudget: undefined })
      .pick(startingPosition(), 'red')!;
    assert.deepEqual([undef.from, undef.to], [plain.from, plain.to]);
  });
});
