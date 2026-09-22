import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  classify, cpLoss, formatScore, moveAccuracy, negate, terminalScore, toWhite, winPct,
  winningChances,
} from '../src/score.ts';

describe('score arithmetic', () => {
  test('winning chances follow the Lichess curve', () => {
    assert.equal(winningChances({ type: 'cp', value: 0 }), 0);
    assert.ok(Math.abs(winningChances({ type: 'cp', value: 100 }) - 0.1818) < 0.001);
    assert.ok(Math.abs(winningChances({ type: 'cp', value: -100 }) + 0.1818) < 0.001);
    assert.equal(winningChances({ type: 'mate', value: 3 }), 1);
    assert.equal(winningChances({ type: 'mate', value: -1 }), -1);
    // Clamped: an enormous cp is no better than +1000.
    assert.equal(winningChances({ type: 'cp', value: 5000 }), winningChances({ type: 'cp', value: 1000 }));
  });

  test('win percentage is symmetric around 50', () => {
    assert.equal(winPct({ type: 'cp', value: 0 }), 50);
    const up = winPct({ type: 'cp', value: 250 });
    const down = winPct({ type: 'cp', value: -250 });
    assert.ok(Math.abs(up + down - 100) < 1e-9);
    assert.equal(winPct({ type: 'mate', value: 2 }), 100);
    assert.equal(winPct({ type: 'mate', value: 0 }), 0);
  });

  test('perspective flips', () => {
    assert.deepEqual(negate({ type: 'mate', value: 2 }), { type: 'mate', value: -2 });
    assert.deepEqual(toWhite({ type: 'cp', value: 30 }, 'w'), { type: 'cp', value: 30 });
    assert.deepEqual(toWhite({ type: 'cp', value: 30 }, 'b'), { type: 'cp', value: -30 });
  });

  test('classification thresholds at 5 / 10 / 15 points', () => {
    assert.equal(classify(60, 60, true), 'best');
    assert.equal(classify(60, 58, false), 'good');
    assert.equal(classify(60, 55, false), 'inaccuracy');
    assert.equal(classify(60, 50, false), 'mistake');
    assert.equal(classify(60, 45, false), 'blunder');
    assert.equal(classify(60, 20, false), 'blunder');
  });

  test('accuracy is 100 for no loss and decays with the drop', () => {
    assert.equal(moveAccuracy(55, 55), 100);
    assert.equal(moveAccuracy(55, 70), 100);
    const a10 = moveAccuracy(60, 50);
    const a30 = moveAccuracy(60, 30);
    assert.ok(a10 > a30 && a30 > 0 && a10 < 100);
    assert.equal(moveAccuracy(100, 0), 0);
  });

  test('centipawn loss and formatting', () => {
    assert.equal(cpLoss({ type: 'cp', value: 50 }, { type: 'cp', value: -20 }), 70);
    assert.equal(cpLoss({ type: 'cp', value: 50 }, { type: 'cp', value: 80 }), 0);
    assert.equal(cpLoss({ type: 'cp', value: 50 }, { type: 'mate', value: -3 }), 10050);
    assert.equal(formatScore({ type: 'cp', value: 35 }), '+0.35');
    assert.equal(formatScore({ type: 'cp', value: -120 }), '-1.20');
    assert.equal(formatScore({ type: 'mate', value: 3 }), '#3');
    assert.equal(formatScore({ type: 'mate', value: -2 }), '-#2');
  });

  test('terminal scores', () => {
    assert.deepEqual(terminalScore(true), { type: 'mate', value: 0 });
    assert.deepEqual(terminalScore(false), { type: 'cp', value: 0 });
  });
});
