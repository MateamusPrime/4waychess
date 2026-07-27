import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARMIES, FFA_RULES, Game, Position, TEAMS_RULES, generateLegal, parseSquare, squareName,
  startingPosition,
} from '@4wc/engine';
import type { Army, PieceType, Ruleset } from '@4wc/engine';
import { DEFAULT_WEIGHTS, evaluate, uniformWeights } from '../src/eval.ts';
import { pickMove } from '../src/search.ts';
import type { SearchOptions } from '../src/search.ts';
import {
  DIFFICULTIES, PERSONALITIES, PERSONALITY_IDS, makeBot,
} from '../src/personalities.ts';
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

function opts(over: Partial<SearchOptions> = {}): SearchOptions {
  return {
    depth: 2,
    nodeBudget: 10_000,
    branchCap: 18,
    temperature: 0,
    weights: uniformWeights(),
    rng: makeRng(42),
    ...over,
  };
}

describe('evaluation', () => {
  test('the opening position is symmetric: all four armies score equal', () => {
    const scores = evaluate(startingPosition(), uniformWeights());
    for (const a of ARMIES) {
      assert.ok(Math.abs(scores[a] - scores.red) < 1e-9, `${a}: ${scores[a]} vs ${scores.red}`);
    }
  });

  test('losing a rook lowers your score and nobody else\'s material term', () => {
    const pos = startingPosition();
    const before = evaluate(pos, uniformWeights());
    pos.remove(parseSquare('a4')); // Blue rook
    const after = evaluate(pos, uniformWeights());
    assert.ok(after.blue < before.blue, 'Blue is worse off');
    assert.ok(Math.abs(after.yellow - before.yellow) < 0.5, 'Yellow barely moves');
  });

  test('banked points count: the score race is the win condition', () => {
    const pos = startingPosition();
    const before = evaluate(pos, uniformWeights());
    pos.points.green = 25;
    const after = evaluate(pos, uniformWeights());
    assert.ok(Math.abs(after.green - (before.green + 25 * DEFAULT_WEIGHTS.points)) < 1e-9);
  });

  test('a dead army scores its banked points and nothing else', () => {
    const pos = startingPosition();
    pos.points.blue = 30;
    pos.status.blue = 'checkmated';
    const scores = evaluate(pos, uniformWeights());
    assert.equal(scores.blue, 30 * DEFAULT_WEIGHTS.points);
  });

  test('dead pieces threaten nobody', () => {
    // A Yellow rook parked next to the Red king is terrifying alive and furniture dead.
    const alive = build({ ...FAR_KINGS, e4: 'yR' });
    const dead = build({ ...FAR_KINGS, e4: 'yR' });
    dead.status.yellow = 'checkmated';
    assert.ok(evaluate(alive, uniformWeights()).red < evaluate(dead, uniformWeights()).red);
  });

  test('a promoted 1-point queen is valued at 1, not 9', () => {
    const real = build({ ...FAR_KINGS, h7: 'rQ' });
    const promo = build(FAR_KINGS);
    promo.put(parseSquare('h7'), 'red', 'q', true);
    assert.ok(
      evaluate(real, uniformWeights()).red > evaluate(promo, uniformWeights()).red + 5,
      'the 8-point difference must show up in the eval',
    );
  });

  test('in Teams your partner\'s standing is your own', () => {
    const pos = startingPosition(TEAMS_RULES);
    const scores = evaluate(pos, uniformWeights());
    assert.ok(Math.abs(scores.red - scores.yellow) < 1e-9, 'partners share a fate');
    // Removing Yellow material must hurt Red too.
    pos.remove(parseSquare('d14'));
    const after = evaluate(pos, uniformWeights());
    assert.ok(after.red < scores.red, 'Red feels the partner\'s loss');
  });

  test('kingmaker aversion punishes lines where the leader stands taller', () => {
    const pos = startingPosition();
    pos.points.yellow = 40; // Yellow leads
    const plain = evaluate(pos, uniformWeights());
    const km = evaluate(pos, {
      ...uniformWeights(),
      red: { ...DEFAULT_WEIGHTS, leaderAversion: 0.5 },
    });
    assert.ok(km.red < plain.red, 'the leader\'s standing drags the kingmaker\'s score down');
  });
});

describe('search', () => {
  test('takes a hanging queen', () => {
    const pos = build({ ...FAR_KINGS, h5: 'rR', h9: 'yQ' });
    pos.turn = 'red';
    const r = pickMove(pos, opts({ depth: 1 }));
    assert.ok(r.move !== null);
    assert.equal(squareName(r.move.to), 'h9');
    assert.equal(r.move.captured, 'q');
  });

  test('prefers the queen over the pawn when both hang', () => {
    const pos = build({ ...FAR_KINGS, h5: 'rR', h9: 'yQ', e5: 'yP' });
    pos.turn = 'red';
    const r = pickMove(pos, opts({ depth: 1 }));
    assert.equal(squareName(r.move!.to), 'h9', 'nine points beat one');
  });

  test('prefers a real queen over a 1-point promoted queen', () => {
    const pos = build({ ...FAR_KINGS, h7: 'rR', h10: 'yQ' });
    pos.put(parseSquare('e7'), 'yellow', 'q', true);
    pos.turn = 'red';
    const r = pickMove(pos, opts({ depth: 1 }));
    assert.equal(squareName(r.move!.to), 'h10', 'the real queen is worth 9, the promoted 1');
  });

  test('recaptures live THREE plies away, and depth 3 is what sees them', () => {
    // A defining four-player fact: after Red grabs Yellow's defended pawn, Blue moves, THEN
    // Yellow recaptures — the punishment is 3 plies deep, not 1 as two-player instinct says.
    // So depth 2 is structurally greedy against the army that moves before you, and depth 3
    // (the hard tier) is the first depth that plays sound exchanges against everyone.
    const pos = build({ ...FAR_KINGS, h5: 'rR', h9: 'yP', i10: 'yB' });
    pos.turn = 'red';
    const d2 = pickMove(pos, opts({ depth: 2 }));
    const d3 = pickMove(pos, opts({ depth: 3, nodeBudget: 60_000, branchCap: 14 }));
    assert.equal(squareName(d2.move!.to), 'h9', 'depth 2 cannot see Yellow\'s reply yet');
    assert.notEqual(squareName(d3.move!.to), 'h9', 'depth 3 sees Bxh9 coming and declines');
  });

  test('respects the node budget', () => {
    const r = pickMove(startingPosition(), opts({ depth: 3, nodeBudget: 500 }));
    assert.ok(r.nodes <= 600, `nodes ${r.nodes}`);
    assert.ok(r.move !== null, 'still returns a move when the budget bites');
  });

  test('is deterministic under a seed, and varies across seeds at high temperature', () => {
    const a = pickMove(startingPosition(), opts({ temperature: 2, rng: makeRng(7) }));
    const b = pickMove(startingPosition(), opts({ temperature: 2, rng: makeRng(7) }));
    assert.deepEqual(a.move, b.move, 'same seed, same move');

    const picks = new Set<string>();
    for (let seed = 1; seed <= 12; seed++) {
      const r = pickMove(startingPosition(), opts({ temperature: 2.5, rng: makeRng(seed) }));
      picks.add(`${r.move!.from}-${r.move!.to}`);
    }
    assert.ok(picks.size >= 2, 'high temperature should vary the opening move across seeds');
  });

  test('temperature 0 always plays the top-scoring candidate', () => {
    const pos = build({ ...FAR_KINGS, h5: 'rR', h9: 'yQ' });
    pos.turn = 'red';
    for (let seed = 1; seed <= 6; seed++) {
      const r = pickMove(pos, opts({ depth: 1, temperature: 0, rng: makeRng(seed) }));
      assert.equal(squareName(r.move!.to), 'h9', `seed ${seed}`);
    }
  });

  test('returns null only when there is genuinely no legal move', () => {
    const mate = build({ d1: 'rK', d14: 'yR', e14: 'yR', a4: 'bK', k12: 'yK', n11: 'gK' });
    mate.turn = 'red';
    assert.equal(generateLegal(mate, 'red').length, 0);
    assert.equal(pickMove(mate, opts()).move, null);
  });

  test('never returns an illegal move across random midgame positions', () => {
    let seed = 777;
    const rnd = (n: number): number => {
      seed ^= seed << 13; seed >>>= 0; seed ^= seed >> 17; seed ^= seed << 5; seed >>>= 0;
      return seed % n;
    };
    for (let g = 0; g < 6; g++) {
      const pos = startingPosition();
      for (let ply = 0; ply < 30; ply++) {
        const ms = generateLegal(pos, pos.turn);
        if (ms.length === 0) break;
        pos.makeMove(ms[rnd(ms.length)]);
      }
      const r = pickMove(pos, opts({ depth: 2, nodeBudget: 4000 }));
      if (r.move === null) continue;
      const legal = generateLegal(pos, pos.turn).map((m) => `${m.from}-${m.to}-${m.promotion}`);
      assert.ok(legal.includes(`${r.move.from}-${r.move.to}-${r.move.promotion}`));
    }
  });
});

describe('personalities', () => {
  test('all four exist with distinct weight profiles and names', () => {
    assert.equal(PERSONALITY_IDS.length, 4);
    const profiles = PERSONALITY_IDS.map((id) => JSON.stringify(PERSONALITIES[id].weights));
    assert.equal(new Set(profiles).size, 4, 'no two personalities share weights');
    const names = new Set(PERSONALITY_IDS.map((id) => PERSONALITIES[id].name));
    assert.equal(names.size, 4);
  });

  test('the profiles encode their temperament', () => {
    const p = PERSONALITIES;
    assert.ok(p.aggressive.weights.aggression > p.turtle.weights.aggression * 3);
    assert.ok(p.turtle.weights.kingSafety > p.aggressive.weights.kingSafety * 2);
    assert.ok(p.opportunist.weights.points > DEFAULT_WEIGHTS.points);
    assert.ok(p.kingmaker.weights.leaderAversion > 0);
    assert.equal(p.aggressive.weights.leaderAversion, 0);
  });

  test('difficulty tiers escalate depth and budget, and sharpen selection', () => {
    assert.ok(DIFFICULTIES.easy.depth < DIFFICULTIES.medium.depth);
    assert.ok(DIFFICULTIES.medium.depth <= DIFFICULTIES.hard.depth);
    assert.ok(DIFFICULTIES.easy.nodeBudget < DIFFICULTIES.hard.nodeBudget);
    assert.ok(DIFFICULTIES.easy.temperature > DIFFICULTIES.medium.temperature);
    assert.equal(DIFFICULTIES.hard.temperature, 0);
  });

  test('a bot picks legal moves for its own seat and refuses to move out of turn', () => {
    const bot = makeBot('aggressive', 'medium', 123);
    const pos = startingPosition();
    assert.equal(bot.pick(pos, 'blue'), null, 'not Blue\'s turn');
    const move = bot.pick(pos, 'red');
    assert.ok(move !== null);
    const legal = generateLegal(pos, 'red').map((m) => `${m.from}-${m.to}`);
    assert.ok(legal.includes(`${move.from}-${move.to}`));
  });

  test('bots are reproducible under a seed', () => {
    const a = makeBot('opportunist', 'medium', 55);
    const b = makeBot('opportunist', 'medium', 55);
    const pos = startingPosition();
    assert.deepEqual(a.pick(pos, 'red'), b.pick(pos, 'red'));
  });

  test('an easy bot still takes an outright hanging queen', () => {
    // Softened selection must never look broken: a free queen one square away is the kind of
    // miss that reads as a bug, not as an easy opponent (Phase 2 gate).
    const pos = build({ ...FAR_KINGS, h5: 'rR', h9: 'yQ' });
    pos.turn = 'red';
    for (let seed = 1; seed <= 10; seed++) {
      const bot = makeBot('turtle', 'easy', seed);
      const m = bot.pick(pos, 'red');
      assert.equal(squareName(m!.to), 'h9', `seed ${seed}`);
    }
  });
});

describe('full games: bots against each other', () => {
  test('four medium bots complete a game without an illegal move or a stall', () => {
    const bots = {
      red: makeBot('aggressive', 'medium', 1),
      blue: makeBot('turtle', 'medium', 2),
      yellow: makeBot('opportunist', 'medium', 3),
      green: makeBot('kingmaker', 'medium', 4),
    };
    const game = Game.create(FFA_RULES);
    let plies = 0;
    while (!game.result().over && plies < 240) {
      const turn = game.pos.turn;
      const move = bots[turn].pick(game.pos, turn);
      if (move === null) break;
      game.play(move);
      plies++;
    }
    assert.ok(plies >= 40, `game stalled after ${plies} plies`);
    for (const a of ARMIES) {
      assert.ok(game.pos.points[a] >= 0 && Number.isFinite(game.pos.points[a]));
    }
    // Bots must actually interact: some points should have been scored by someone.
    const total = ARMIES.reduce((s, a) => s + game.pos.points[a], 0);
    assert.ok(total > 0, 'a 60-round bot game with zero captures means nobody is playing chess');
  });
});
