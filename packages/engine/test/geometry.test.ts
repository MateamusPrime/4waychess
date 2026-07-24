import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  W, NSQ, ARMIES, SQUARES, PLAYABLE, isPlayableXY, isPlayable, isDarkSquare,
  idx, fileOf, rankOf, toOwn, fromOwn, squareName, parseSquare, step,
  FORWARD, RIGHT, PAWN_CAPTURES,
} from '../src/geometry.ts';
import type { Army } from '../src/types.ts';

describe('board geometry', () => {
  test('160 playable squares', () => {
    assert.equal(SQUARES.length, 160);
    assert.equal(PLAYABLE.filter(Boolean).length, 160);
  });

  test('all four 3x3 corners are removed', () => {
    for (const [x0, y0] of [[0, 0], [11, 0], [0, 11], [11, 11]]) {
      for (let dx = 0; dx < 3; dx++) {
        for (let dy = 0; dy < 3; dy++) {
          assert.equal(isPlayableXY(x0 + dx, y0 + dy), false,
            `(${x0 + dx},${y0 + dy}) should be a cut corner`);
        }
      }
    }
  });

  test('cutouts are exactly 36 squares', () => {
    let cut = 0;
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) if (!isPlayableXY(x, y)) cut++;
    assert.equal(cut, 36);
    assert.equal(NSQ - cut, 160);
  });

  test('off-board coordinates are rejected', () => {
    assert.equal(isPlayableXY(-1, 7), false);
    assert.equal(isPlayableXY(14, 7), false);
    assert.equal(isPlayableXY(7, -1), false);
    assert.equal(isPlayableXY(7, 14), false);
    assert.equal(isPlayable(-1), false);
    assert.equal(isPlayable(NSQ), false);
  });

  test('a1 is dark, as in standard chess', () => {
    assert.equal(isDarkSquare(parseSquare('a1')), true);
    assert.equal(isDarkSquare(parseSquare('b1')), false);
  });

  test('square names round-trip for every playable square', () => {
    for (const s of SQUARES) assert.equal(parseSquare(squareName(s)), s);
  });

  test('index helpers agree', () => {
    for (const s of SQUARES) assert.equal(idx(fileOf(s), rankOf(s)), s);
  });

  test('parseSquare rejects nonsense', () => {
    assert.throws(() => parseSquare('z1'));
    assert.throws(() => parseSquare('a99'));
  });
});

describe('army-local frame (RULES.md §3)', () => {
  test('toOwn / fromOwn round-trip over every playable square', () => {
    for (const army of ARMIES) {
      for (const s of SQUARES) {
        const [f, r] = toOwn(army, s);
        assert.equal(fromOwn(army, f, r), s, `${army} ${squareName(s)} own(${f},${r})`);
      }
    }
  });

  test('each army back line is ownRank 1, ownFile 1..8', () => {
    const backLine: Record<Army, string[]> = {
      red: ['d1', 'e1', 'f1', 'g1', 'h1', 'i1', 'j1', 'k1'],
      blue: ['a11', 'a10', 'a9', 'a8', 'a7', 'a6', 'a5', 'a4'],
      yellow: ['k14', 'j14', 'i14', 'h14', 'g14', 'f14', 'e14', 'd14'],
      green: ['n4', 'n5', 'n6', 'n7', 'n8', 'n9', 'n10', 'n11'],
    };
    for (const army of ARMIES) {
      backLine[army].forEach((name, i) => {
        const [f, r] = toOwn(army, parseSquare(name));
        assert.equal(r, 1, `${army} ${name} should be ownRank 1`);
        assert.equal(f, i + 1, `${army} ${name} should be ownFile ${i + 1}`);
      });
    }
  });

  test('all four kings start at own(5,1) — the e1 square', () => {
    const kings: Record<Army, string> = {
      red: 'h1', blue: 'a7', yellow: 'g14', green: 'n8',
    };
    for (const army of ARMIES) {
      assert.deepEqual(toOwn(army, parseSquare(kings[army])), [5, 1], army);
    }
  });

  test('all four queens start at own(4,1) — the d1 square, queen-left house rule', () => {
    const queens: Record<Army, string> = {
      red: 'g1', blue: 'a8', yellow: 'h14', green: 'n7',
    };
    for (const army of ARMIES) {
      assert.deepEqual(toOwn(army, parseSquare(queens[army])), [4, 1], army);
    }
  });

  test('the local frame covers exactly the playable board', () => {
    for (const army of ARMIES) {
      const seen = new Set<number>();
      for (const s of SQUARES) {
        const [f, r] = toOwn(army, s);
        assert.ok(r >= 1 && r <= 14, `${army} ownRank ${r} out of range`);
        seen.add(f * 100 + r);
      }
      assert.equal(seen.size, 160, `${army} frame should be a bijection`);
    }
  });

  test('ownFile is 1..8 on the eight home ranks and unconstrained elsewhere', () => {
    // On ownRank 1..3 and 12..14 the arms are only 8 wide, so ownFile must be 1..8.
    for (const army of ARMIES) {
      for (const s of SQUARES) {
        const [f, r] = toOwn(army, s);
        if (r <= 3 || r >= 12) {
          assert.ok(f >= 1 && f <= 8, `${army} ${squareName(s)} own(${f},${r})`);
        }
      }
    }
  });
});

describe('directions', () => {
  test('forward moves an army toward the opposite edge', () => {
    // One step forward from each army's back line lands on its pawn line.
    const backAndPawn: Record<Army, [string, string]> = {
      red: ['h1', 'h2'],
      blue: ['a7', 'b7'],
      yellow: ['g14', 'g13'],
      green: ['n8', 'm8'],
    };
    for (const army of ARMIES) {
      const [back, pawn] = backAndPawn[army];
      const [dx, dy] = FORWARD[army];
      assert.equal(step(parseSquare(back), dx, dy), parseSquare(pawn), army);
    }
  });

  test('forward is +1 ownRank and right is +1 ownFile', () => {
    for (const army of ARMIES) {
      const s = fromOwn(army, 4, 5);
      const [fx, fy] = FORWARD[army];
      const [rx, ry] = RIGHT[army];
      assert.deepEqual(toOwn(army, step(s, fx, fy)), [4, 6], `${army} forward`);
      assert.deepEqual(toOwn(army, step(s, rx, ry)), [5, 5], `${army} right`);
    }
  });

  test('pawn captures are the two forward diagonals in the local frame', () => {
    for (const army of ARMIES) {
      const s = fromOwn(army, 4, 5);
      const landed = PAWN_CAPTURES[army].map(([dx, dy]) => toOwn(army, step(s, dx, dy)));
      assert.deepEqual(
        landed.map((p) => p.join(',')).sort(),
        ['3,6', '5,6'],
        `${army} capture squares`,
      );
    }
  });
});

describe('step()', () => {
  test('refuses to slide across a corner cutout', () => {
    // The bottom-left cutout is files a-c x ranks 1-3, so c3 is NOT playable.
    // d3 sits on its edge; stepping down-left from it would land on c2, inside the cutout.
    assert.equal(isPlayable(parseSquare('c3')), false);
    assert.equal(isPlayable(parseSquare('d3')), true);
    assert.equal(step(parseSquare('d3'), -1, -1), -1);
    // Same on the other three corners.
    assert.equal(step(parseSquare('d12'), -1, 1), -1);
    assert.equal(step(parseSquare('k3'), 1, -1), -1);
    assert.equal(step(parseSquare('k12'), 1, 1), -1);
  });

  test('returns -1 off the outer edge', () => {
    assert.equal(step(parseSquare('a7'), -1, 0), -1);
    assert.equal(step(parseSquare('n7'), 1, 0), -1);
    assert.equal(step(parseSquare('h1'), 0, -1), -1);
    assert.equal(step(parseSquare('h14'), 0, 1), -1);
  });
});
