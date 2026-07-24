import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ARMIES, SQUARES, W, fileOf, parseSquare, rankOf, squareName, toOwn } from '@4wc/engine';
import type { Army } from '@4wc/engine';
import {
  VIEW, assertViewIsRotation, coordLabels, determinant, directionToScreen,
  rotationSteps, seatAngle, toCell, toSquare, visibleCells,
} from '../src/view.ts';

describe('view transforms', () => {
  test('all four are rotations, never reflections', () => {
    for (const seat of ARMIES) {
      assert.equal(determinant(VIEW[seat]), -1, `${seat} determinant`);
      assert.doesNotThrow(() => assertViewIsRotation(seat));
    }
  });

  test('toCell / toSquare round-trip over every playable square for every seat', () => {
    for (const seat of ARMIES) {
      for (const sq of SQUARES) {
        const { col, row } = toCell(seat, sq);
        assert.equal(toSquare(seat, col, row), sq, `${seat} ${squareName(sq)}`);
      }
    }
  });

  test('each seat projects onto a bijection of the 14x14 grid', () => {
    for (const seat of ARMIES) {
      const seen = new Set<string>();
      for (const sq of SQUARES) {
        const { col, row } = toCell(seat, sq);
        assert.ok(col >= 0 && col < W && row >= 0 && row < W, `${seat} out of grid`);
        seen.add(`${col},${row}`);
      }
      assert.equal(seen.size, 160, `${seat} collisions`);
    }
  });

  test('the viewing seat always sits at the bottom of the screen', () => {
    for (const seat of ARMIES) {
      // Every square on that army's own back line must land on the last screen row.
      for (const sq of SQUARES) {
        if (toOwn(seat, sq)[1] !== 1) continue;
        assert.equal(toCell(seat, sq).row, 13, `${seat} back line square ${squareName(sq)}`);
      }
    }
  });

  test('the viewing seat\'s own left is on the left of the screen', () => {
    for (const seat of ARMIES) {
      for (const sq of SQUARES) {
        const [ownFile, ownRank] = toOwn(seat, sq);
        if (ownRank !== 1) continue;
        // ownFile 1..8 maps to screen columns 3..10 in ascending order.
        assert.equal(toCell(seat, sq).col, ownFile + 2, `${seat} ${squareName(sq)}`);
      }
    }
  });

  test('the seat\'s own pawns always advance up the screen', () => {
    const FORWARD: Record<Army, [number, number]> = {
      red: [0, 1], blue: [1, 0], yellow: [0, -1], green: [-1, 0],
    };
    for (const seat of ARMIES) {
      const [dx, dy] = FORWARD[seat];
      assert.deepEqual(directionToScreen(seat, dx, dy), { col: 0, row: -1 }, seat);
    }
  });

  test('off-grid and cut-corner cells resolve to -1', () => {
    for (const seat of ARMIES) {
      assert.equal(toSquare(seat, -1, 5), -1);
      assert.equal(toSquare(seat, 14, 5), -1);
      assert.equal(toSquare(seat, 5, -1), -1);
      assert.equal(toSquare(seat, 5, 14), -1);
      // The four grid corners are always cut, whatever the rotation.
      for (const [c, r] of [[0, 0], [13, 0], [0, 13], [13, 13]]) {
        assert.equal(toSquare(seat, c, r), -1, `${seat} corner ${c},${r}`);
      }
    }
  });

  test('visibleCells returns exactly the 160 playable squares in row-major order', () => {
    for (const seat of ARMIES) {
      const cells = visibleCells(seat);
      assert.equal(cells.length, 160);
      assert.equal(new Set(cells.map((c) => c.square)).size, 160);
      for (let i = 1; i < cells.length; i++) {
        const a = cells[i - 1].cell;
        const b = cells[i].cell;
        assert.ok(b.row > a.row || (b.row === a.row && b.col > a.col), 'not row-major');
      }
    }
  });
});

describe('seat rotation', () => {
  test('handing to the NEXT seat rotates the image anticlockwise', () => {
    // Seats advance clockwise around the table, but carrying the next seat to the bottom of
    // the screen rotates the board IMAGE anticlockwise. Shipping the naive positive sign made
    // the board spin +90 and then snap to the -90 view — a 180-degree flash on every hand-off.
    assert.equal(rotationSteps('red', 'red'), 0);
    assert.equal(rotationSteps('red', 'blue'), -1);
    assert.equal(rotationSteps('blue', 'yellow'), -1);
    assert.equal(rotationSteps('yellow', 'green'), -1);
    assert.equal(rotationSteps('green', 'red'), -1);
    assert.equal(rotationSteps('red', 'yellow'), -2);
    // Going BACK a seat is the one clockwise case.
    assert.equal(rotationSteps('red', 'green'), 1);
    assert.equal(rotationSteps('blue', 'red'), 1);
  });

  test('the rotation is algebraically consistent with the view transforms', () => {
    // rotationSteps must agree with what toCell actually does: rotating from-view cells by
    // steps * 90 degrees about the grid centre must land exactly on to-view cells. This ties
    // the animation to the projection, which is precisely what regressed.
    const rotate = (col: number, row: number, steps: number): [number, number] => {
      let c = col - 6.5;
      let r = row - 6.5;
      const turns = ((steps % 4) + 4) % 4;
      for (let i = 0; i < turns; i++) {
        const [nc, nr] = [-r, c]; // one 90-degree clockwise image rotation, y-down
        c = nc;
        r = nr;
      }
      return [c + 6.5, r + 6.5];
    };
    for (const from of ARMIES) {
      for (const to of ARMIES) {
        const steps = rotationSteps(from, to);
        for (const sq of SQUARES) {
          const a = toCell(from, sq);
          const b = toCell(to, sq);
          const [c, r] = rotate(a.col, a.row, steps);
          assert.ok(Math.abs(c - b.col) < 1e-9 && Math.abs(r - b.row) < 1e-9,
            `${from}->${to} ${squareName(sq)}: rotated (${c},${r}) != (${b.col},${b.row})`);
        }
      }
    }
  });

  test('no rotation is ever more than a half turn', () => {
    for (const a of ARMIES) {
      for (const b of ARMIES) {
        assert.ok(Math.abs(rotationSteps(a, b)) <= 2, `${a}->${b}`);
      }
    }
  });

  test('seatAngle matches rotationSteps from Red', () => {
    assert.deepEqual(ARMIES.map(seatAngle), [0, -90, -180, -270]);
  });
});

describe('coordinate labels', () => {
  test('one file label per column and one rank label per row, for every seat', () => {
    for (const seat of ARMIES) {
      const { files, ranks } = coordLabels(seat);
      assert.equal(files.length, W, `${seat} files`);
      assert.equal(ranks.length, W, `${seat} ranks`);
      assert.equal(new Set(files.map((f) => f.cell.col)).size, W);
      assert.equal(new Set(ranks.map((r) => r.cell.row)).size, W);
    }
  });

  test('labels sit on the visible edge, following the ragged cutout boundary', () => {
    for (const seat of ARMIES) {
      const { files, ranks } = coordLabels(seat);
      for (const { cell } of files) {
        // Nothing playable may exist below a file label.
        for (let row = cell.row + 1; row < W; row++) {
          assert.equal(toSquare(seat, cell.col, row), -1, `${seat} col ${cell.col}`);
        }
      }
      for (const { cell } of ranks) {
        for (let col = 0; col < cell.col; col++) {
          assert.equal(toSquare(seat, col, cell.row), -1, `${seat} row ${cell.row}`);
        }
      }
    }
  });

  test('Red sees files a-n along the bottom and ranks 1-14 up the left', () => {
    const { files, ranks } = coordLabels('red');
    assert.equal(files.map((f) => squareName(f.square)[0]).join(''), 'abcdefghijklmn');
    assert.deepEqual(
      ranks.map((r) => rankOf(r.square) + 1),
      [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
    );
  });

  test('the ragged edge is real: bottom-row labels are not all on row 13', () => {
    // Files a-c and l-n bottom out at rank 4 because of the cutouts, so a naive
    // "put labels on the last row" implementation would place them off the board.
    const { files } = coordLabels('red');
    const rows = new Set(files.map((f) => f.cell.row));
    assert.ok(rows.size > 1, 'expected labels on more than one screen row');
    assert.equal(files.find((f) => squareName(f.square) === 'a4')?.cell.row, 10);
    assert.equal(files.find((f) => squareName(f.square) === 'd1')?.cell.row, 13);
  });
});

describe('cross-check against the engine', () => {
  test('screen column ordering matches file order for Red and reverses for Yellow', () => {
    const d1 = parseSquare('d1');
    const k1 = parseSquare('k1');
    assert.ok(toCell('red', d1).col < toCell('red', k1).col);
    const d14 = parseSquare('d14');
    const k14 = parseSquare('k14');
    assert.ok(toCell('yellow', d14).col > toCell('yellow', k14).col);
  });

  test('every seat sees its own king on the bottom row at column 7', () => {
    const kings: Record<Army, string> = {
      red: 'h1', blue: 'a7', yellow: 'g14', green: 'n8',
    };
    for (const seat of ARMIES) {
      const cell = toCell(seat, parseSquare(kings[seat]));
      assert.deepEqual(cell, { col: 7, row: 13 }, seat);
    }
  });

  test('file and rank arithmetic stays consistent with the engine', () => {
    for (const sq of SQUARES) {
      assert.equal(squareName(sq), 'abcdefghijklmn'[fileOf(sq)] + String(rankOf(sq) + 1));
    }
  });
});
