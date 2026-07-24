import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startingPosition, parseFen4 } from '../src/fen4.ts';
import { perft, perftDetailed, plyOrder } from '../src/perft.ts';
import { generateLegal } from '../src/movegen.ts';
import { naiveGenerateLegal, moveKey } from '../src/naive.ts';
import { ARMIES } from '../src/geometry.ts';
import { TACTICAL } from './fixtures.ts';

/**
 * FROZEN PERFT BASELINES.
 *
 * These numbers are not externally verified — no reference perft data exists for four-way
 * chess, and our queen-left house rule diverges from chess.com anyway (RISKS.md R4). They are
 * established by construction and by agreement with the independent naive generator, then
 * frozen. Their purpose is regression: any change to move generation that moves these numbers
 * is caught immediately and must be justified, not silently accepted.
 *
 * If you change one of these, say why in the commit message.
 */

describe('perft — opening position (FROZEN)', () => {
  test('node counts to depth 4', () => {
    const pos = startingPosition();
    assert.equal(perft(pos, 1), 20);
    assert.equal(perft(pos, 2), 395);
    assert.equal(perft(pos, 3), 7800);
    assert.equal(perft(pos, 4), 152050);
  });

  test('one full round is Red, Blue, Yellow, Green', () => {
    assert.deepEqual(plyOrder(startingPosition(), 4), ['red', 'blue', 'yellow', 'green']);
  });

  test('the armies cannot reach each other in the first round', () => {
    // Documents WHY the opening is a weak regression target and TACTICAL exists.
    const d = perftDetailed(startingPosition(), 4);
    assert.equal(d.captures, 0);
    assert.equal(d.enPassant, 0);
    assert.equal(d.castles, 0);
    assert.equal(d.promotions, 0);
  });
});

describe('perft — tactical position (FROZEN)', () => {
  test('node and capture counts to depth 3', () => {
    assert.deepEqual(perftDetailed(parseFen4(TACTICAL), 1), {
      nodes: 32, captures: 3, enPassant: 0, castles: 0, promotions: 0,
    });
    assert.deepEqual(perftDetailed(parseFen4(TACTICAL), 2), {
      nodes: 1506, captures: 231, enPassant: 0, castles: 0, promotions: 0,
    });
    assert.deepEqual(perftDetailed(parseFen4(TACTICAL), 3), {
      nodes: 65956, captures: 11646, enPassant: 32, castles: 0, promotions: 0,
    });
  });

  test('both generators agree on the tactical position for every army', () => {
    const pos = parseFen4(TACTICAL);
    for (const a of ARMIES) {
      assert.deepEqual(
        generateLegal(pos, a).map(moveKey).sort(),
        naiveGenerateLegal(pos, a).map(moveKey).sort(),
        a,
      );
    }
  });

  test('perft is stable across repeated runs — make/unmake leaks nothing', () => {
    const pos = parseFen4(TACTICAL);
    const first = perft(pos, 2);
    const second = perft(pos, 2);
    const third = perft(pos, 2);
    assert.equal(first, 1506);
    assert.equal(second, 1506);
    assert.equal(third, 1506);
  });
});
