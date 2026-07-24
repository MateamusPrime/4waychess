import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startingPosition, serializeFen4 } from '../src/fen4.ts';
import { generateLegal } from '../src/movegen.ts';
import { isInCheck, isAttacked } from '../src/attacks.ts';
import { naiveGenerateLegal, naiveIsInCheck, naiveIsAttacked, moveKey } from '../src/naive.ts';
import { ARMIES, SQUARES } from '../src/geometry.ts';
import { FFA_RULES, TEAMS_RULES, Position } from '../src/position.ts';
import type { Army, Ruleset } from '../src/types.ts';

/**
 * The differential test. This is the load-bearing correctness argument for the engine.
 *
 * There is no published perft data for four-way chess (RISKS.md R4), so we cannot check our
 * move generator against an external reference. Instead `naive.ts` implements the rules a
 * second time, sharing no logic with `movegen.ts`, and we demand the two agree over a large
 * number of positions reached by random play.
 *
 * Raise the position budget with WC4_DIFF_NODES to run a deeper sweep.
 */

const NODES = Number(process.env.WC4_DIFF_NODES ?? 2500);

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    // xorshift32 — deterministic, so a failure is always reproducible from its seed.
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

interface SweepOptions {
  rules: Ruleset;
  /** Chance per ply of eliminating a random army, to exercise dead-piece handling. */
  killChance: number;
}

function compareAt(pos: Position, army: Army, context: string): void {
  const fast = generateLegal(pos, army).map(moveKey).sort();
  const slow = naiveGenerateLegal(pos, army).map(moveKey).sort();
  if (fast.length !== slow.length || fast.some((v, i) => v !== slow[i])) {
    const onlyFast = fast.filter((m) => !slow.includes(m));
    const onlySlow = slow.filter((m) => !fast.includes(m));
    assert.fail(
      `Move generators disagree for ${army}\n` +
      `${context}\nFEN4: ${serializeFen4(pos)}\n` +
      `only in fast: ${onlyFast.join(' ') || '(none)'}\n` +
      `only in naive: ${onlySlow.join(' ') || '(none)'}`,
    );
  }
  assert.equal(isInCheck(pos, army), naiveIsInCheck(pos, army),
    `check detection disagrees for ${army}\n${context}\nFEN4: ${serializeFen4(pos)}`);
}

/** Play random games, comparing both generators at every node. Returns positions checked. */
function sweep(seed: number, budget: number, opts: SweepOptions): number {
  const rnd = makeRng(seed);
  let checked = 0;
  let game = 0;

  while (checked < budget) {
    const pos = startingPosition(opts.rules);
    game++;
    for (let ply = 0; ply < 220 && checked < budget; ply++) {
      const ctx = `seed=${seed} game=${game} ply=${ply}`;

      // Compare for every army, not only the side to move: generation must be correct for
      // any army at any time, since bots and analysis query out of turn.
      for (const a of ARMIES) {
        compareAt(pos, a, ctx);
        checked++;
      }

      if (opts.killChance > 0 && rnd() < opts.killChance) {
        const alive = pos.activeArmies();
        if (alive.length > 2) pos.status[alive[Math.floor(rnd() * alive.length)]] = 'checkmated';
      }

      const moves = generateLegal(pos, pos.turn);
      if (moves.length === 0) break;
      pos.makeMove(moves[Math.floor(rnd() * moves.length)]);
      if (pos.activeArmies().length < 2) break;
    }
  }
  return checked;
}

describe('differential: fast vs naive generator', () => {
  test('agree at the opening position for every army', () => {
    const pos = startingPosition();
    for (const a of ARMIES) compareAt(pos, a, 'opening');
  });

  test('attack detection agrees on every square for every army at the opening', () => {
    const pos = startingPosition();
    for (const a of ARMIES) {
      for (const s of SQUARES) {
        assert.equal(isAttacked(pos, s, a), naiveIsAttacked(pos, s, a), `${a} sq ${s}`);
      }
    }
  });

  test(`FFA random play (${NODES} positions)`, () => {
    const n = sweep(0x5eed1234, NODES, { rules: FFA_RULES, killChance: 0 });
    assert.ok(n >= NODES);
  });

  test(`FFA random play with eliminations (${NODES} positions)`, () => {
    const n = sweep(0x1337beef, NODES, { rules: FFA_RULES, killChance: 0.03 });
    assert.ok(n >= NODES);
  });

  test(`Teams random play (${NODES} positions)`, () => {
    const n = sweep(0xabcd0042, NODES, { rules: TEAMS_RULES, killChance: 0 });
    assert.ok(n >= NODES);
  });

  test('multiple independent seeds agree', () => {
    for (const seed of [1, 2, 3, 99, 12345]) {
      sweep(seed, 400, { rules: FFA_RULES, killChance: 0.02 });
    }
  });
});

describe('differential: make/unmake integrity under random play', () => {
  test('every position is restored byte-for-byte after unwinding', () => {
    const rnd = makeRng(0xfeedface);
    const pos = startingPosition();
    const history: string[] = [];
    for (let i = 0; i < 400; i++) {
      const moves = generateLegal(pos, pos.turn);
      if (moves.length === 0) break;
      history.push(serializeFen4(pos));
      pos.makeMove(moves[Math.floor(rnd() * moves.length)]);
    }
    while (history.length > 0) {
      pos.unmakeMove();
      assert.equal(serializeFen4(pos), history.pop());
    }
  });
});
