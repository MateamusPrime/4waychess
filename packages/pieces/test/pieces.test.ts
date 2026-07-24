import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  PIECE_FILL_RULE, PIECE_PATHS, PIECE_VIEWBOX, PROMOTED_BADGE,
} from '../src/index.ts';
import type { PieceType } from '@4wc/engine';

const TYPES: PieceType[] = ['p', 'n', 'b', 'r', 'q', 'k'];

/**
 * Minimal SVG path tokenizer — enough to prove the hand-authored paths are well-formed
 * without pulling in a real SVG library. Supports the command set the paths actually use.
 */
interface Parsed {
  commands: string[];
  points: { x: number; y: number }[];
  subpaths: number;
  closed: number;
}

function parsePath(d: string): Parsed {
  const out: Parsed = { commands: [], points: [], subpaths: 0, closed: 0 };
  const tokens = d.match(/[MLCZ]|-?\d+(?:\.\d+)?/gi);
  assert.ok(tokens !== null, 'path is empty');

  let i = 0;
  const num = (): number => {
    const t = tokens[i++];
    const n = Number(t);
    assert.ok(Number.isFinite(n), `expected number, got "${t}"`);
    return n;
  };

  while (i < tokens.length) {
    const cmd = tokens[i++];
    out.commands.push(cmd);
    switch (cmd) {
      case 'M':
        out.subpaths++;
        out.points.push({ x: num(), y: num() });
        break;
      case 'L':
        out.points.push({ x: num(), y: num() });
        break;
      case 'C':
        out.points.push({ x: num(), y: num() });
        out.points.push({ x: num(), y: num() });
        out.points.push({ x: num(), y: num() });
        break;
      case 'Z':
        out.closed++;
        break;
      default:
        assert.fail(`unsupported path command "${cmd}" — the renderers only handle M/L/C/Z`);
    }
  }
  return out;
}

describe('piece path data', () => {
  test('every piece type has a path', () => {
    for (const t of TYPES) {
      assert.equal(typeof PIECE_PATHS[t], 'string', t);
      assert.ok(PIECE_PATHS[t].length > 20, t);
    }
  });

  test('every path parses cleanly with only M/L/C/Z commands', () => {
    for (const t of TYPES) {
      assert.doesNotThrow(() => parsePath(PIECE_PATHS[t]), t);
    }
  });

  test('every subpath is explicitly closed — open contours fill unpredictably', () => {
    for (const t of TYPES) {
      const p = parsePath(PIECE_PATHS[t]);
      assert.equal(p.closed, p.subpaths, `${t}: ${p.subpaths} subpaths but ${p.closed} Z`);
    }
  });

  test('all coordinates stay inside the viewBox', () => {
    for (const t of TYPES) {
      for (const { x, y } of parsePath(PIECE_PATHS[t]).points) {
        assert.ok(x >= 0 && x <= PIECE_VIEWBOX, `${t} x=${x}`);
        assert.ok(y >= 0 && y <= PIECE_VIEWBOX, `${t} y=${y}`);
      }
    }
  });

  test('every piece stands on the shared plinth', () => {
    // The plinth is what makes six silhouettes read as one family. Its bottom edge is the
    // common ground line.
    for (const t of TYPES) {
      const ys = parsePath(PIECE_PATHS[t]).points.map((p) => p.y);
      assert.equal(Math.max(...ys), 95, `${t} should stand on y=95`);
    }
  });

  test('pieces are visually distinct: no two paths are identical', () => {
    const seen = new Set(TYPES.map((t) => PIECE_PATHS[t]));
    assert.equal(seen.size, TYPES.length);
  });

  test('every piece is roughly centred on x=50', () => {
    for (const t of TYPES) {
      const xs = parsePath(PIECE_PATHS[t]).points.map((p) => p.x);
      const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
      assert.ok(Math.abs(mid - 50) <= 3, `${t} centre is x=${mid}`);
    }
  });

  test('taller pieces are taller: height ordering matches rank', () => {
    // King and queen must top the family; the pawn must be the shortest. Height here is
    // distance from the ground line at 95 up to the piece's highest point.
    const top: Record<string, number> = {};
    for (const t of TYPES) {
      top[t] = Math.min(...parsePath(PIECE_PATHS[t]).points.map((p) => p.y));
    }
    assert.ok(top.k < top.b && top.q < top.b, 'king and queen above bishop');
    assert.ok(top.b < top.p && top.n < top.p, 'bishop and knight above pawn');
    assert.ok(top.p >= 14, 'pawn is the shortest');
  });

  test('only the bishop needs evenodd — its mitre slit is a real hole', () => {
    assert.equal(PIECE_FILL_RULE.b, 'evenodd');
    for (const t of TYPES) {
      if (t !== 'b') assert.equal(PIECE_FILL_RULE[t], 'nonzero', t);
    }
  });

  test('the promoted-queen badge sits inside the queen silhouette bounds', () => {
    const q = parsePath(PIECE_PATHS.q);
    const xs = q.points.map((p) => p.x);
    const ys = q.points.map((p) => p.y);
    assert.ok(PROMOTED_BADGE.cx - PROMOTED_BADGE.r > Math.min(...xs));
    assert.ok(PROMOTED_BADGE.cx + PROMOTED_BADGE.r < Math.max(...xs));
    assert.ok(PROMOTED_BADGE.cy - PROMOTED_BADGE.r > Math.min(...ys));
    assert.ok(PROMOTED_BADGE.cy + PROMOTED_BADGE.r < Math.max(...ys));
  });
});
