import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startingPosition } from '../src/fen4.ts';
import { attackMap, isAttackedBy } from '../src/attacks.ts';
import { generateLegal } from '../src/movegen.ts';
import { naiveIsAttacked } from '../src/naive.ts';
import { ARMIES, SQUARES, parseSquare, squareName } from '../src/geometry.ts';
import { FFA_RULES, Position, TEAMS_RULES } from '../src/position.ts';
import type { Army, PieceType } from '../src/types.ts';

/**
 * attackMap is the forward complement of isAttackedBy, and the two must agree EXACTLY —
 * bot evaluation trusts the map to decide which pieces are hanging, and a map that disagrees
 * with legality's notion of "attacked" would make bots mis-count threats in precisely the
 * positions where it matters.
 */

describe('attackMap agrees with reverse detection', () => {
  test('at the opening position, for every army and every square', () => {
    const pos = startingPosition();
    for (const a of ARMIES) {
      const map = attackMap(pos, a);
      for (const s of SQUARES) {
        assert.equal(map[s] === 1, isAttackedBy(pos, s, a), `${a} ${squareName(s)}`);
      }
    }
  });

  test('across random play, against BOTH the fast and the naive detector', () => {
    let seed = 0xabcdef;
    const rnd = (n: number): number => {
      seed ^= seed << 13; seed >>>= 0; seed ^= seed >> 17; seed ^= seed << 5; seed >>>= 0;
      return seed % n;
    };
    for (let g = 0; g < 8; g++) {
      const pos = startingPosition(g % 2 === 0 ? FFA_RULES : TEAMS_RULES);
      for (let ply = 0; ply < 40; ply++) {
        const ms = generateLegal(pos, pos.turn);
        if (ms.length === 0) break;
        pos.makeMove(ms[rnd(ms.length)]);
      }
      if (g % 3 === 2) pos.status.blue = 'checkmated';
      for (const a of ARMIES) {
        const map = attackMap(pos, a);
        for (const s of SQUARES) {
          assert.equal(map[s] === 1, isAttackedBy(pos, s, a), `fast g${g} ${a} ${squareName(s)}`);
        }
      }
      // The naive detector answers "attacked by any enemy of X" — reconstruct that from maps.
      for (const victim of ARMIES) {
        const enemyMaps = ARMIES.filter((o) => pos.areEnemies(victim, o))
          .map((o) => attackMap(pos, o));
        for (const s of SQUARES) {
          const fromMaps = enemyMaps.some((m) => m[s] === 1);
          assert.equal(fromMaps, naiveIsAttacked(pos, s, victim), `naive g${g} ${victim} ${squareName(s)}`);
        }
      }
    }
  });

  test('a dead army attacks nothing', () => {
    const pos = startingPosition();
    pos.status.green = 'resigned';
    const map = attackMap(pos, 'green');
    assert.equal(map.reduce((a, b) => a + b, 0), 0);
  });

  test('sliders attack through to the first blocker and no further', () => {
    const pos = new Position(FFA_RULES);
    const put = (sq: string, army: Army, t: PieceType): void =>
      pos.put(parseSquare(sq), army, t);
    put('h1', 'red', 'k');
    put('a7', 'blue', 'k');
    put('g14', 'yellow', 'k');
    put('n8', 'green', 'k');
    put('h5', 'red', 'r');
    put('h9', 'yellow', 'p');
    const map = attackMap(pos, 'red');
    assert.equal(map[parseSquare('h8')], 1, 'open square on the file');
    assert.equal(map[parseSquare('h9')], 1, 'the blocker itself is attacked');
    assert.equal(map[parseSquare('h10')], 0, 'nothing beyond the blocker');
  });

  test('pawns attack their capture diagonals, never the square ahead', () => {
    const pos = new Position(FFA_RULES);
    pos.put(parseSquare('h5'), 'red', 'p');
    pos.put(parseSquare('h1'), 'red', 'k');
    pos.put(parseSquare('a7'), 'blue', 'k');
    pos.put(parseSquare('g14'), 'yellow', 'k');
    pos.put(parseSquare('n8'), 'green', 'k');
    const map = attackMap(pos, 'red');
    assert.equal(map[parseSquare('g6')], 1);
    assert.equal(map[parseSquare('i6')], 1);
    assert.equal(map[parseSquare('h6')], 0, 'forward is a move, not an attack');
  });
});
