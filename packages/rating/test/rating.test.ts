import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Army } from '@4wc/engine';
import {
  DEFAULT_MU, DEFAULT_SIGMA, PROVISIONAL_GAMES, displayRating, isProvisional, newRating,
  rateGroups,
} from '../src/model.ts';
import { groupsFor, isRated, ranksFor } from '../src/outcome.ts';
import type { GameOutcome, SeatOutcome } from '../src/outcome.ts';
import { applyGame, leaderboard, ratingOf, recompute } from '../src/ladder.ts';
import type { RatingTable } from '../src/ladder.ts';
import type { Rating } from '../src/model.ts';

const ARMY_ORDER: Army[] = ['red', 'blue', 'yellow', 'green'];

/** Build an FFA outcome from per-seat points, in army order. */
function ffa(
  points: [number, number, number, number],
  over: Partial<Record<Army, Partial<SeatOutcome>>> = {},
): GameOutcome {
  const seats: SeatOutcome[] = ARMY_ORDER.map((army, i) => ({
    army,
    playerId: army,
    points: points[i],
    abandoned: false,
    ...over[army],
  }));
  const best = Math.max(...seats.map((s) => s.points));
  return { mode: 'ffa', seats, winners: seats.filter((s) => s.points === best).map((s) => s.army) };
}

function teams(winners: Army[], over: Partial<Record<Army, Partial<SeatOutcome>>> = {}): GameOutcome {
  return {
    mode: 'teams',
    seats: ARMY_ORDER.map((army) => ({
      army, playerId: army, points: 0, abandoned: false, ...over[army],
    })),
    winners,
  };
}

describe('the model behaves like a skill rating', () => {
  test('a fresh player starts at the documented prior and displays 0', () => {
    const r = newRating();
    assert.equal(r.mu, DEFAULT_MU);
    assert.equal(r.sigma, DEFAULT_SIGMA);
    assert.equal(r.games, 0);
    assert.equal(displayRating(r), 0, 'new players earn upward from zero rather than sliding down');
    assert.equal(isProvisional(r), true);
  });

  test('winning raises your mean, losing lowers it, and everyone gets more certain', () => {
    const [[w], [l]] = rateGroups([[newRating()], [newRating()]], [1, 2]);
    assert.ok(w.mu > DEFAULT_MU, 'winner gains');
    assert.ok(l.mu < DEFAULT_MU, 'loser loses');
    assert.ok(w.sigma < DEFAULT_SIGMA && l.sigma < DEFAULT_SIGMA, 'both become more certain');
    assert.equal(w.games, 1);
  });

  test('a four-way result orders the rating changes by finishing place', () => {
    const out = rateGroups([[newRating()], [newRating()], [newRating()], [newRating()]], [1, 2, 3, 4]);
    const mus = out.map((g) => g[0].mu);
    for (let i = 1; i < mus.length; i++) {
      assert.ok(mus[i - 1] > mus[i], `place ${i} must gain more than place ${i + 1}`);
    }
  });

  test('a four-way tie moves nobody', () => {
    const out = rateGroups([[newRating()], [newRating()], [newRating()], [newRating()]], [1, 1, 1, 1]);
    for (const g of out) {
      assert.ok(Math.abs(g[0].mu - DEFAULT_MU) < 1e-9, 'a tie is not information about who is better');
    }
  });

  test('beating a stronger opponent is worth more than beating a weaker one', () => {
    const strong = { mu: 40, sigma: 2, games: 50 };
    const weak = { mu: 10, sigma: 2, games: 50 };
    const me = { mu: 25, sigma: 2, games: 50 };
    const [[vsStrong]] = rateGroups([[me], [strong]], [1, 2]);
    const [[vsWeak]] = rateGroups([[me], [weak]], [1, 2]);
    assert.ok(vsStrong.mu - me.mu > vsWeak.mu - me.mu, 'upsets teach more');
  });

  test('an uncertain player moves further per game than a settled one', () => {
    const fresh = newRating();
    const settled = { mu: DEFAULT_MU, sigma: 1.5, games: 200 };
    const [[f]] = rateGroups([[fresh], [newRating()]], [1, 2]);
    const [[s]] = rateGroups([[settled], [newRating()]], [1, 2]);
    assert.ok(f.mu - fresh.mu > s.mu - settled.mu, 'uncertainty means faster learning');
  });

  test('sigma shrinks toward a floor but never to zero or below', () => {
    let r = newRating();
    for (let i = 0; i < 500; i++) {
      [[r]] = rateGroups([[r], [newRating()]], [i % 2 === 0 ? 1 : 2, i % 2 === 0 ? 2 : 1]);
    }
    assert.ok(r.sigma > 0, `sigma collapsed to ${r.sigma}`);
    assert.ok(Number.isFinite(r.mu) && Number.isFinite(r.sigma));
    assert.ok(r.sigma < DEFAULT_SIGMA / 2, 'but it did converge substantially');
  });

  test('dynamics keep a settled rating able to move again', () => {
    // Without the TAU term a long-settled player would be frozen: sigma decays to nothing and
    // genuine improvement could never show up.
    const settled = { mu: DEFAULT_MU, sigma: 0.3, games: 500 };
    const [[after]] = rateGroups([[settled], [{ mu: 40, sigma: 1, games: 100 }]], [1, 2]);
    assert.ok(after.mu > settled.mu, 'a big upset still moves a settled rating');
  });

  test('rateGroups does not mutate its inputs', () => {
    const a = newRating();
    const snapshot = { ...a };
    rateGroups([[a], [newRating()]], [1, 2]);
    assert.deepEqual(a, snapshot);
  });

  test('mismatched groups and ranks are rejected loudly', () => {
    assert.throws(() => rateGroups([[newRating()], [newRating()]], [1]), /groups but/);
  });
});

describe('ranking a game (the anti-farming rules)', () => {
  test('FFA ranks by points, not by survival', () => {
    // The signature FFA outcome: an eliminated player still wins on points (RULES.md §12).
    const r = ranksFor(ffa([10, 40, 25, 5]));
    assert.equal(r.get('blue'), 1);
    assert.equal(r.get('yellow'), 2);
    assert.equal(r.get('red'), 3);
    assert.equal(r.get('green'), 4);
  });

  test('equal points share a place, and the next place skips', () => {
    const r = ranksFor(ffa([30, 30, 20, 10]));
    assert.equal(r.get('red'), 1);
    assert.equal(r.get('blue'), 1);
    assert.equal(r.get('yellow'), 3, 'standard competition ranking: 1, 1, 3, 4');
    assert.equal(r.get('green'), 4);
  });

  test('MARGIN IS IGNORED: a 1-point win rates exactly like a 70-point win', () => {
    // Margin-sensitive rating would reward running up the score on a beaten opponent — the
    // same state-farming failure as the check bonus (RISKS.md R22), and it would push players
    // toward cruelty instead of toward winning.
    const narrow = applyGame(new Map(), ffa([31, 30, 20, 10]));
    const blowout = applyGame(new Map(), ffa([100, 30, 20, 10]));
    assert.equal(ratingOf(narrow, 'red').mu, ratingOf(blowout, 'red').mu);
    assert.equal(ratingOf(narrow, 'green').mu, ratingOf(blowout, 'green').mu);
  });

  test('ABANDONING ranks last even when winning on points', () => {
    // Otherwise the optimal response to a game going wrong is to stop responding, which would
    // make rage-quitting a rating strategy and actively incentivise RISKS.md R2.
    const r = ranksFor(ffa([90, 30, 20, 10], { red: { abandoned: true } }));
    assert.equal(r.get('red'), 4, 'the points leader forfeits their place by abandoning');
    assert.equal(r.get('blue'), 1);
  });

  test('resigning is NOT abandoning — it keeps your points and your place', () => {
    // Resignation is a legal strategic act (RULES.md §12); only silence is punished.
    const r = ranksFor(ffa([90, 30, 20, 10]));
    assert.equal(r.get('red'), 1);
  });

  test('quitting is never better than playing on and losing', () => {
    const played = applyGame(new Map(), ffa([5, 40, 30, 20]));
    const quit = applyGame(new Map(), ffa([5, 40, 30, 20], { red: { abandoned: true } }));
    assert.ok(
      ratingOf(quit, 'red').mu <= ratingOf(played, 'red').mu,
      'abandoning must never pay better than finishing last honestly',
    );
  });

  test('Teams ranks by team result, and both partners share it', () => {
    const g = groupsFor(teams(['red', 'yellow']));
    assert.deepEqual(g[0].armies.sort(), ['red', 'yellow']);
    assert.equal(g[0].rank, 1);
    assert.equal(g[1].rank, 2);
  });

  test('a Teams partner abandoning loses the exchange for the whole team', () => {
    const g = groupsFor(teams(['red', 'yellow'], { yellow: { abandoned: true } }));
    const teamA = g.find((x) => x.armies.includes('red'));
    assert.equal(teamA?.rank, 2, 'you cannot win a rated game by having your partner vanish');
  });

  test('Teams partners gain equally when they start equal', () => {
    const table = applyGame(new Map(), teams(['red', 'yellow']));
    assert.equal(ratingOf(table, 'red').mu, ratingOf(table, 'yellow').mu);
    assert.ok(ratingOf(table, 'red').mu > ratingOf(table, 'blue').mu);
  });

  test('the less certain partner learns more from a team result', () => {
    let table: RatingTable = new Map([
      ['red', { mu: DEFAULT_MU, sigma: DEFAULT_SIGMA, games: 0 }],
      ['yellow', { mu: DEFAULT_MU, sigma: 1, games: 100 }],
    ]);
    table = applyGame(table, teams(['red', 'yellow']));
    const newcomer = ratingOf(table, 'red').mu - DEFAULT_MU;
    const veteran = ratingOf(table, 'yellow').mu - DEFAULT_MU;
    assert.ok(newcomer > veteran, 'credit follows uncertainty, not seniority');
  });
});

describe('what counts as rated', () => {
  test('four humans: rated', () => {
    assert.equal(isRated(ffa([10, 20, 30, 40])), true);
  });

  test('any bot at the table makes the game unrated', () => {
    // Bots are our code, so a table containing them is a controllable environment — and
    // anything a player can control, a player can farm. This also means a bot filling an
    // abandoned seat correctly de-rates the game: it is no longer the game people entered.
    for (const army of ARMY_ORDER) {
      const outcome = ffa([10, 20, 30, 40], { [army]: { playerId: null } });
      assert.equal(isRated(outcome), false, `${army} as a bot must de-rate the game`);
    }
  });

  test('an unrated game returns the table unchanged, by identity', () => {
    const table: RatingTable = new Map([['red', newRating()]]);
    const after = applyGame(table, ffa([10, 20, 30, 40], { blue: { playerId: null } }));
    assert.equal(after, table, 'callers can cheaply detect that nothing happened');
  });

  test('a bot-stuffed table cannot move a rating at all', () => {
    let table: RatingTable = new Map();
    const stuffed = ffa([99, 0, 0, 0], {
      blue: { playerId: null }, yellow: { playerId: null }, green: { playerId: null },
    });
    for (let i = 0; i < 100; i++) table = applyGame(table, stuffed);
    assert.equal(table.size, 0, 'a hundred wins against bots produce no rating whatsoever');
  });
});

describe('the ladder is fixable — pure and recomputable', () => {
  test('recompute reproduces incremental application exactly', () => {
    const history = [
      ffa([10, 40, 25, 5]), ffa([50, 10, 20, 30]), teams(['blue', 'green']),
      ffa([5, 5, 60, 20], { green: { abandoned: true } }), ffa([33, 31, 30, 29]),
    ];
    let incremental: RatingTable = new Map();
    for (const o of history) incremental = applyGame(incremental, o);

    const rebuilt = recompute(history);
    assert.equal(rebuilt.size, incremental.size);
    for (const [id, r] of incremental) {
      assert.deepEqual(rebuilt.get(id), r, `${id} must rebuild identically`);
    }
  });

  test('recompute is deterministic across runs — no clock, no randomness', () => {
    const history = [ffa([10, 40, 25, 5]), ffa([50, 10, 20, 30])];
    assert.deepEqual([...recompute(history)], [...recompute(history)]);
  });

  test('order matters, and is therefore part of the stored input', () => {
    const a = ffa([40, 10, 20, 30]);
    const b = ffa([10, 40, 30, 20]);
    const forward = recompute([a, b]);
    const backward = recompute([b, a]);
    assert.notDeepEqual(ratingOf(forward, 'red'), ratingOf(backward, 'red'));
  });

  test('applyGame does not mutate the table it was given', () => {
    const table: RatingTable = new Map([['red', newRating()]]);
    const before = new Map(table);
    applyGame(table, ffa([40, 10, 20, 30]));
    assert.deepEqual([...table], [...before]);
  });
});

describe('leaderboard', () => {
  test('a lucky newcomer cannot leap a steadier veteran it currently out-scores', () => {
    // The single most important property of the public board, and it has to be tested at the
    // point where it actually bites: a newcomer whose MEAN is genuinely HIGHER than a
    // veteran's. displayRating is μ − 3σ, so the newcomer's uncertainty still keeps it below
    // until it has played the doubt off. (An earlier version of this test compared a 3-game
    // newcomer with a 40-game veteran of the same win rate — the veteran had the higher μ too,
    // so it passed without ever exercising the σ penalty.)
    let lucky: RatingTable = new Map();
    for (let i = 0; i < 3; i++) lucky = applyGame(lucky, ffa([40, 30, 20, 10]));
    const newcomer = ratingOf(lucky, 'red');

    const veteran: Rating = { mu: newcomer.mu - 4, sigma: 1.5, games: 120 };

    assert.ok(newcomer.mu > veteran.mu, 'precondition: the newcomer really is scoring higher');
    assert.ok(newcomer.sigma > veteran.sigma * 3, 'and is far less certain');
    assert.ok(
      displayRating(newcomer) < displayRating(veteran),
      `newcomer ${displayRating(newcomer)} (mu ${newcomer.mu.toFixed(1)}) must not out-rank `
      + `veteran ${displayRating(veteran)} (mu ${veteran.mu.toFixed(1)})`,
    );
  });

  test('the same newcomer DOES overtake once it has played the uncertainty off', () => {
    // The guard must be a delay, not a permanent ceiling, or the ladder would be unclimbable.
    let table: RatingTable = new Map();
    for (let i = 0; i < 40; i++) table = applyGame(table, ffa([40, 30, 20, 10]));
    const grown = ratingOf(table, 'red');
    const veteran: Rating = { mu: 45, sigma: 1.5, games: 120 };
    assert.ok(
      displayRating(grown) > displayRating(veteran),
      `after 40 games ${displayRating(grown)} should pass ${displayRating(veteran)}`,
    );
  });

  test('provisional players sort below established ones and can be hidden', () => {
    const table: RatingTable = new Map([
      ['vet', { mu: 30, sigma: 1, games: PROVISIONAL_GAMES + 5 }],
      ['newbie', { mu: 45, sigma: 1, games: 2 }],
    ]);
    const rows = leaderboard(table);
    assert.equal(rows[0].playerId, 'vet', 'a high provisional score does not top the board');
    assert.equal(rows[1].provisional, true);
    assert.equal(leaderboard(table, { includeProvisional: false }).length, 1);
  });

  test('ranks are dense from 1 and the limit is honoured', () => {
    const table: RatingTable = new Map(
      ['a', 'b', 'c'].map((id, i) => [id, { mu: 30 + i, sigma: 1, games: 50 }]),
    );
    const rows = leaderboard(table);
    assert.deepEqual(rows.map((r) => r.rank), [1, 2, 3]);
    assert.deepEqual(rows.map((r) => r.playerId), ['c', 'b', 'a']);
    assert.equal(leaderboard(table, { limit: 2 }).length, 2);
  });

  test('equal ratings order deterministically rather than by insertion', () => {
    const same = { mu: 30, sigma: 1, games: 50 };
    const one = leaderboard(new Map([['zed', same], ['abe', same]]));
    const two = leaderboard(new Map([['abe', same], ['zed', same]]));
    assert.deepEqual(one.map((r) => r.playerId), two.map((r) => r.playerId));
  });
});

describe('a plausible season stays sane', () => {
  test('consistent skill ordering emerges from mixed results', () => {
    // Four players of genuinely different strength: the strongest wins most, the weakest
    // loses most, with noise. The ladder should recover the true order.
    const ids: Army[] = ['red', 'blue', 'yellow', 'green'];
    const skill = { red: 4, blue: 3, yellow: 2, green: 1 };
    let seed = 12345;
    const rnd = (): number => {
      seed ^= seed << 13; seed >>>= 0; seed ^= seed >> 17; seed ^= seed << 5; seed >>>= 0;
      return seed / 0x100000000;
    };

    const history: GameOutcome[] = [];
    for (let g = 0; g < 60; g++) {
      const points = ids.map((a) => skill[a] * 10 + rnd() * 25) as unknown as
        [number, number, number, number];
      history.push(ffa(points));
    }
    const table = recompute(history);
    const board = leaderboard(table);
    assert.deepEqual(
      board.map((r) => r.playerId),
      ['red', 'blue', 'yellow', 'green'],
      'the ladder recovered the true skill order',
    );
    assert.ok(board.every((r) => !r.provisional), '60 games is well past provisional');
    assert.ok(board[0].display > board[3].display + 100, 'and it separated them meaningfully');
  });
});
