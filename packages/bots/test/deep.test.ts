import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  FFA_RULES, Game, Position, generateLegal, parseSquare, serializeFen4, squareName,
  startingPosition,
} from '@4wc/engine';
import type { Army, PieceType, Ruleset } from '@4wc/engine';
import { uniformWeights } from '../src/eval.ts';
import { pickMove } from '../src/search.ts';
import { pickMoveDeep } from '../src/deep.ts';
import type { DeepOptions } from '../src/deep.ts';
import { makeBot } from '../src/personalities.ts';
import { makeRng } from '../src/rng.ts';

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

function opts(over: Partial<DeepOptions> = {}): DeepOptions {
  // replyCap is the lever that keeps BRS affordable: at the opening, depth 2 with a cap of 24
  // is ~750k nodes; with a cap of 5 it is ~10k. Tests that need wide reply coverage on a
  // sparse position override it explicitly.
  return {
    maxDepth: 2,
    nodeBudget: 8_000,
    branchCap: 12,
    replyCap: 5,
    rolloutPlies: 8,
    temperature: 0,
    weights: uniformWeights(),
    rng: makeRng(42),
    ...over,
  };
}

describe('capture rollout resolves horizons the static term cannot', () => {
  test('declines a pawn guarded twice but defended once', () => {
    // Rxh9 wins a pawn on a square that LOOKS survivable to the static term (defended, so
    // only a 12% value penalty) — but two attackers versus one defender loses the full
    // exchange: Rxh9, Bxh9, Bxh9, Nxh9 nets about -4. Only playing the sequence reveals it,
    // which is exactly what the rollout does and depth-1 classic cannot.
    const pos = build({
      ...FAR_KINGS, h5: 'rR', h9: 'yP', i10: 'yB', g11: 'yN', f7: 'rB',
    });
    pos.turn = 'red';

    const classic = pickMove(pos, {
      depth: 1, nodeBudget: 4000, branchCap: 18, temperature: 0,
      weights: uniformWeights(), rng: makeRng(1),
    });
    assert.equal(squareName(classic.move!.to), 'h9', 'classic depth 1 falls for it');

    const deep = pickMoveDeep(pos, 'red', opts({ maxDepth: 1 }));
    assert.notEqual(squareName(deep.move!.to), 'h9', 'the rollout plays out the exchange');
  });

  test('still takes a genuinely free pawn', () => {
    const pos = build({ ...FAR_KINGS, h5: 'rR', h9: 'yP' });
    pos.turn = 'red';
    const deep = pickMoveDeep(pos, 'red', opts({ maxDepth: 1 }));
    assert.equal(squareName(deep.move!.to), 'h9');
  });

  test('the rollout leaves the position untouched', () => {
    const pos = build({ ...FAR_KINGS, h5: 'rR', h9: 'yP', i10: 'yB', g11: 'yN', f7: 'rB' });
    pos.turn = 'red';
    const before = serializeFen4(pos);
    pickMoveDeep(pos, 'red', opts());
    assert.equal(serializeFen4(pos), before);
  });
});

describe('best-reply layers see threats from ANY opponent', () => {
  test('avoids a knight fork prepared by the army two seats away', () => {
    // Red is offered a free pawn on d5. Taking it walks into Yellow's Ne6-f4+: a fork of the
    // d3 king and the d5 rook, delivered by an army classic depth-2 NEVER expands (it only
    // considers Blue, the next mover). The reply layer considers every enemy, so the fork is
    // visible and the pawn is declined.
    const pos = build({ ...FAR_KINGS, h5: 'rR', d5: 'yP', e6: 'yN' });
    pos.turn = 'red';

    const classic = pickMove(pos, {
      depth: 2, nodeBudget: 8000, branchCap: 18, temperature: 0,
      weights: uniformWeights(), rng: makeRng(1),
    });
    assert.equal(squareName(classic.move!.to), 'd5', 'classic cannot see Yellow at depth 2');

    const deep = pickMoveDeep(pos, 'red', opts({ maxDepth: 2 }));
    assert.notEqual(squareName(deep.move!.to), 'd5', 'the fork is inside the reply layer');
  });
});

describe('discipline: budget, determinism, transposition table', () => {
  test('respects the node budget and yields a move even from a partial first iteration', () => {
    const r = pickMoveDeep(startingPosition(), 'red', opts({ maxDepth: 4, nodeBudget: 900 }));
    assert.ok(r.nodes <= 1000, `nodes ${r.nodes}`);
    assert.ok(r.move !== null, 'a partial first iteration still yields a move');
  });

  test('deterministic under a seed, including at temperature', () => {
    const a = pickMoveDeep(startingPosition(), 'red', opts({ temperature: 0.8, rng: makeRng(9) }));
    const b = pickMoveDeep(startingPosition(), 'red', opts({ temperature: 0.8, rng: makeRng(9) }));
    assert.deepEqual(a.move, b.move);
    assert.equal(a.nodes, b.nodes);
  });

  test('the transposition table changes cost, never the answer', () => {
    // The budget must be generous enough for BOTH runs to complete: two saturated runs both
    // stop at the cap and the node comparison proves nothing (found the hard way — 100001 vs
    // 100000). Depth 2 on this sparse position finishes with lots of headroom.
    const pos = build({ ...FAR_KINGS, h5: 'rR', h9: 'yP', e6: 'yN', g2: 'rP' });
    pos.turn = 'red';
    const withTT = pickMoveDeep(pos, 'red', opts({ maxDepth: 2, nodeBudget: 500_000 }));
    const without = pickMoveDeep(pos, 'red', opts({ maxDepth: 2, nodeBudget: 500_000, noTT: true }));
    assert.ok(withTT.nodes < 500_000 && without.nodes < 500_000, 'both runs must complete');
    assert.deepEqual(withTT.move, without.move, 'TT must be invisible in the result');
    assert.ok(withTT.nodes <= without.nodes, `TT ${withTT.nodes} vs ${without.nodes}`);
  });

  test('iterative deepening reports the deepest completed iteration', () => {
    // A sparse position, not the opening: full-width depth 2 from the start position costs
    // six figures of nodes, and this test is about ID bookkeeping, not throughput.
    const pos = build({ ...FAR_KINGS, h5: 'rR', h9: 'yP' });
    pos.turn = 'red';
    const r = pickMoveDeep(pos, 'red', opts({ maxDepth: 2, nodeBudget: 100_000 }));
    assert.equal(r.depthReached, 2);
    const starved = pickMoveDeep(pos, 'red', opts({ maxDepth: 2, nodeBudget: 300 }));
    assert.ok(starved.depthReached <= 1, 'a starved search cannot claim depth it did not finish');
  });
});

describe('integration through makeBot', () => {
  test('every difficulty plays legal moves (all ship on classic — the arena refuted deep)', () => {
    // The deep engine remains exported and tested as an arena-refuted baseline, but no
    // difficulty tier routes through it: all three variants lost to classic max-n at equal
    // budget (see DIFFICULTIES doc). This test pins the tiers to legal play regardless of
    // which engine they route to, so future re-routing keeps a safety net.
    for (const difficulty of ['easy', 'medium', 'hard'] as const) {
      const bot = makeBot('opportunist', difficulty, 77);
      const pos = startingPosition();
      const m = bot.pick(pos, 'red');
      assert.ok(m !== null, difficulty);
      const legal = generateLegal(pos, 'red').map((x) => `${x.from}-${x.to}`);
      assert.ok(legal.includes(`${m.from}-${m.to}`), difficulty);
    }
  });

  test('a four-bot deep-engine game runs clean for 60 plies', () => {
    const bots = {
      red: makeBot('aggressive', 'medium', 11),
      blue: makeBot('turtle', 'medium', 22),
      yellow: makeBot('opportunist', 'medium', 33),
      green: makeBot('kingmaker', 'medium', 44),
    };
    const game = Game.create(FFA_RULES);
    for (let ply = 0; ply < 60 && !game.result().over; ply++) {
      const turn = game.pos.turn;
      const move = bots[turn].pick(game.pos, turn);
      if (move === null) break;
      game.play(move);
    }
    assert.ok(game.moves.length >= 40, `only ${game.moves.length} plies`);
  });
});
