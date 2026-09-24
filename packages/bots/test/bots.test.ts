import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARMIES, FFA_RULES, Game, Position, TEAMS_RULES, attackMap, generateLegal, parseSquare,
  squareName,
  startingPosition,
} from '@4wc/engine';
import type { Army, PieceType, Ruleset } from '@4wc/engine';
import { DEFAULT_WEIGHTS, evaluate, uniformWeights } from '../src/eval.ts';
import { pickMove } from '../src/search.ts';
import type { SearchOptions } from '../src/search.ts';
import {
  DIFFICULTIES, PERSONALITIES, PERSONALITY_IDS, makeBot, wantsResign,
} from '../src/personalities.ts';
import { makeRng } from '../src/rng.ts';
import { orderByThreat } from '../src/core.ts';

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

  test('finishing: a dominant army scores higher with its king nearer a beaten opponent', () => {
    // Red has K+Q+R (14) against Green's bare king; Blue and Yellow retain enough material
    // that the finishing condition only fires for the Red/Green pair. The near position has
    // Red's king marching toward n11; the far position leaves it home. Everything else equal.
    const common = {
      a4: 'bK', b5: 'bQ', k12: 'yK', j11: 'yQ', n11: 'gK', h7: 'rQ', h6: 'rR',
    } as const;
    const far = build({ ...common, e2: 'rK' });
    const near = build({ ...common, k9: 'rK' });
    const sFar = evaluate(far, uniformWeights());
    const sNear = evaluate(near, uniformWeights());
    assert.ok(
      sNear.red > sFar.red + 0.3,
      `approaching the beaten king must pay: near=${sNear.red.toFixed(2)} far=${sFar.red.toFixed(2)}`,
    );
  });

  test('finishing never fires between healthy armies', () => {
    // At the opening everyone holds full material, so the term is zero and symmetry holds
    // (also covered by the symmetry test, but the condition boundary deserves its own name).
    const scores = evaluate(startingPosition(), uniformWeights());
    for (const a of ARMIES) assert.ok(Math.abs(scores[a] - scores.red) < 1e-9, a);
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

  test('declines a poisoned pawn at ANY depth — the threat term sees what search cannot', () => {
    // A defining four-player fact: after Red grabs Yellow's defended pawn, Blue moves, THEN
    // Yellow recaptures — the punishment is 3 plies deep, and a full round is depth 4. No
    // affordable depth covers all three opponents, which is why the evaluation carries a
    // static hanging-piece term: the rook standing on a bishop-guarded square is scored as
    // partly lost the moment it lands, with no search at all.
    const pos = build({ ...FAR_KINGS, h5: 'rR', h9: 'yP', i10: 'yB' });
    pos.turn = 'red';
    for (const depth of [1, 2, 3]) {
      const r = pickMove(pos, opts({ depth, nodeBudget: 60_000, branchCap: 14 }));
      assert.notEqual(squareName(r.move!.to), 'h9', `depth ${depth} must decline Rxh9`);
    }
  });

  test('REGRESSION: the queen-into-pawn blunder from the reported game', () => {
    // Live game, round 10: Yellow's queen captured a Red knight on i5 — a square guarded by
    // Red's h4 pawn — and the pawn took the queen next round. Queen for knight, minus 6 on
    // the exchange, invisible to depth 2 because Red moves three plies after Yellow. The
    // hanging term must make every depth refuse the capture.
    // The queen sits on i9 — chosen by tracing all eight of its lines against every king: on i11 it would see Green's king along rank 11 and
    // correctly prefer the +20 king capture — the first version of this fixture hung a king
    // and the bot outplayed the test.
    const pos = build({
      ...FAR_KINGS, i9: 'yQ', i5: 'rN', h4: 'rP',
    });
    pos.turn = 'yellow';
    for (const depth of [1, 2]) {
      const r = pickMove(pos, opts({ depth, nodeBudget: 30_000 }));
      assert.ok(r.move !== null);
      assert.notEqual(
        squareName(r.move.to), 'i5',
        `depth ${depth}: Qxi5 walks into h4xi5 and must be refused`,
      );
    }
    // Sanity: with the pawn gone the knight really is free, and the queen should take it.
    const free = build({ ...FAR_KINGS, i9: 'yQ', i5: 'rN' });
    free.turn = 'yellow';
    const r = pickMove(free, opts({ depth: 2 }));
    assert.equal(squareName(r.move!.to), 'i5', 'an actually-free knight is still taken');
  });

  test('threat ordering: captures first, then rescuing an attacked piece, never walking into one', () => {
    // Red's queen on h5 is attacked by Yellow's i6 pawn (Yellow captures toward Red's side).
    const pos = build({ ...FAR_KINGS, h5: 'rQ', i6: 'yP', b2: 'rN' });
    pos.turn = 'red';
    const ordered = orderByThreat(pos, generateLegal(pos, 'red'));
    assert.equal(squareName(ordered[0].to), 'i6', 'the free pawn capture leads');
    const firstQuiet = ordered.find((m) => m.captured === null)!;
    assert.equal(firstQuiet.piece, 'q', 'the attacked queen moves before anything else');
    const enemyAttacks = ['blue', 'yellow', 'green'].map((a) => attackMap(pos, a as Army));
    const unsafe = (sq: number): boolean => enemyAttacks.some((m) => m[sq] === 1);
    assert.ok(!unsafe(firstQuiet.to), 'and moves somewhere safe');
    const queenQuiet = ordered.filter((m) => m.piece === 'q' && m.captured === null);
    const lastSafe = queenQuiet.map((m) => !unsafe(m.to)).lastIndexOf(true);
    const firstUnsafe = queenQuiet.findIndex((m) => unsafe(m.to));
    assert.ok(firstUnsafe === -1 || firstUnsafe > lastSafe,
      'queen moves onto attacked squares rank below every safe queen move');
  });

  test('the root ranks EVERY legal move, so a small branchCap cannot hide the best one', () => {
    // Under the legacy ordering the root kept captures plus the first quiet moves in
    // generation order (a board scan from Red's back rank), so here — queen attacked by a
    // pawn, the only capture a poisoned one, and a dozen quiet moves scanned before the
    // queen's — the rescue fell outside the cap and the bot took the defended pawn.
    const pos = build({
      ...FAR_KINGS, h5: 'rQ', i6: 'yP', j7: 'yP', e2: 'rP', f2: 'rP', g2: 'rP', d2: 'rN',
      e1: 'rB',
    });
    pos.turn = 'red';
    const safe = (o: Partial<SearchOptions>): boolean => {
      const m = pickMove(pos, opts({ depth: 1, branchCap: 8, ...o })).move!;
      return m.piece === 'q' && m.captured === null;
    };
    assert.ok(safe({}), 'the attacked queen retreats');
    assert.ok(!safe({ ordering: 'mvv' }), 'legacy ordering never even looked at the retreat');
  });

  test('iterative deepening: reaches the ceiling with room to spare, stops inside the budget', () => {
    const roomy = pickMove(startingPosition(), opts({
      depth: 3, nodeBudget: 60_000, branchCap: 10, iterative: true,
    }));
    assert.equal(roomy.depthReached, 3);
    assert.ok(roomy.move !== null);

    const tight = pickMove(startingPosition(), opts({
      depth: 6, nodeBudget: 3_000, branchCap: 10, iterative: true,
    }));
    assert.ok(tight.depthReached >= 2 && tight.depthReached < 6, `depth ${tight.depthReached}`);
    assert.ok(tight.nodes <= 3_000 + 50, `nodes ${tight.nodes}`);
    assert.ok(tight.move !== null);
  });

  test('iterative deepening is deterministic under a seed', () => {
    const run = (): string => {
      const r = pickMove(startingPosition(), opts({
        depth: 4, nodeBudget: 5_000, branchCap: 10, iterative: true, temperature: 1,
        rng: makeRng(3),
      }));
      return `${r.move!.from}-${r.move!.to}/${r.nodes}`;
    };
    assert.equal(run(), run());
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
    assert.ok(DIFFICULTIES.hard.depth <= DIFFICULTIES.expert.depth);
    assert.ok(DIFFICULTIES.easy.nodeBudget < DIFFICULTIES.hard.nodeBudget);
    assert.ok(DIFFICULTIES.hard.nodeBudget < DIFFICULTIES.expert.nodeBudget);
    assert.equal(DIFFICULTIES.expert.temperature, 0);
    assert.ok(DIFFICULTIES.easy.temperature > DIFFICULTIES.medium.temperature);
    assert.equal(DIFFICULTIES.hard.temperature, 0);
  });

  for (const tier of ['hard', 'expert'] as const) {
    test(`${tier} is defined by depth: its budget always completes its depth`, () => {
      // No tier has a time cap (apps/web never resizes budgets), so each iterative tier's node
      // budget must cover a full search to its depth in ANY position. With branch cap b the
      // iterations cost at most sum over d<=depth of sum over k<=d of b^k nodes, plus one
      // static eval per root legal move — independent of the position, which is what makes a
      // fixed depth affordable on every device.
      const e = DIFFICULTIES[tier];
      assert.equal(e.iterative, true);
      let worst = 0;
      for (let d = 1; d <= e.depth; d++) {
        for (let k = 1; k <= d; k++) worst += e.branchCap ** k;
      }
      worst += 200; // root ranking: one eval per legal move, far above any real move count
      assert.ok(worst <= e.nodeBudget, `worst case ${worst} must fit the ${e.nodeBudget} budget`);

      for (let seed = 1; seed <= 4; seed++) {
        const pos = startingPosition();
        const rnd = makeRng(seed);
        for (let i = 0; i < 12 + seed * 9; i++) {
          const ms = generateLegal(pos, pos.turn);
          if (ms.length === 0) break;
          pos.makeMove(ms[Math.floor(rnd() * ms.length)]);
        }
        const r = pickMove(pos, opts({
          depth: e.depth, nodeBudget: e.nodeBudget, branchCap: e.branchCap, iterative: true,
        }));
        assert.equal(r.depthReached, e.depth, `seed ${seed}: reached depth ${r.depthReached}`);
        assert.ok(r.nodes <= worst, `seed ${seed}: ${r.nodes} nodes`);
      }
    });
  }

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

describe('resignation (RULES.md §12)', () => {
  test('a bare king hopelessly behind resigns', () => {
    const pos = build({ ...FAR_KINGS, h7: 'yQ', h6: 'yR' });
    pos.points.yellow = 40;
    pos.points.red = 5;
    assert.equal(wantsResign(pos, 'red'), true);
  });

  test('within one checkmate bonus of the leader, it keeps playing', () => {
    // A +20 king capture could still close an 18-point gap, so the seat is not hopeless.
    const pos = build({ ...FAR_KINGS, h7: 'yQ' });
    pos.points.yellow = 23;
    pos.points.red = 5;
    assert.equal(wantsResign(pos, 'red'), false);
  });

  test('any material at all means playing on', () => {
    const pos = build({ ...FAR_KINGS, e4: 'rP', h7: 'yQ' });
    pos.points.yellow = 60;
    assert.equal(wantsResign(pos, 'red'), false, 'even a lone pawn can promote');
  });

  test('the points leader never resigns, and neither does a Teams player', () => {
    const lead = build({ ...FAR_KINGS, h7: 'yQ' });
    lead.points.red = 50;
    assert.equal(wantsResign(lead, 'red'), false);

    const teams = build({ ...FAR_KINGS, h7: 'yQ' }, TEAMS_RULES);
    teams.points.yellow = 60;
    assert.equal(wantsResign(teams, 'red'), false, 'in Teams your pieces outlive you');
  });

  test('resignations collapse a decided endgame to the correct winner', () => {
    // The soak-test scenario in miniature: three bare kings, one leader, nothing anyone can
    // do. Both hopeless seats resign, the game ends by elimination, the leader wins.
    const g = new Game(build({ ...FAR_KINGS, h7: 'yQ' }));
    g.pos.points.yellow = 55;
    g.pos.points.red = 10;
    g.pos.points.blue = 12;
    g.pos.points.green = 30;
    for (const a of ['red', 'blue', 'green'] as Army[]) {
      if (wantsResign(g.pos, a)) g.resign(a);
    }
    assert.deepEqual(g.result(), { over: true, reason: 'elimination', winners: ['yellow'] });
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
