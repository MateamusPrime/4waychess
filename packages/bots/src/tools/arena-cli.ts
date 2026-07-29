/**
 * Arena — bot-vs-bot A/B testing.
 *
 * The only honest way to claim a search change is stronger: play it against the incumbent at
 * EQUAL node budgets, rotating seats so no colour bias leaks in, over enough games for the
 * signal to clear the noise. This harness is also the skeleton of the Lever-2 self-play tuner:
 * swap "candidate search" for "candidate weights" and the same loop optimises the eval.
 *
 *   node src/tools/arena-cli.ts [games] [nodeBudget]
 *
 * As configured, `candidate` and `incumbent` below differ only in leaf resolution
 * (capture-rollout vs bare eval) — the last of the three Lever-1 hypotheses, and like the
 * other two it LOST (2.1% wins, 0.50x points). Swap the two pickers to test anything else;
 * the harness cares only that both sides get the same budget and rotate through every seat.
 */

import { ARMIES, FFA_RULES, Game } from '@4wc/engine';
import type { Army, Move, Position } from '@4wc/engine';
import { uniformWeights } from '../eval.ts';
import { pickMove } from '../search.ts';
import { makeRng } from '../rng.ts';

const GAMES = Number(process.argv[2] ?? 48);
const BUDGET = Number(process.argv[3] ?? 2_500);
const MAX_PLIES = 320;

type Picker = (pos: Position, army: Army, seed: number) => Move | null;

/** The shipped configuration: classic max-n, bare leaves, everything spent on breadth. */
const incumbent: Picker = (pos, army, seed) => {
  if (pos.turn !== army) return null;
  return pickMove(pos, {
    depth: 3, nodeBudget: BUDGET, branchCap: 14, temperature: 0.4,
    weights: uniformWeights(), rng: makeRng(seed),
  }).move;
};

/** Whatever is being tested this run. Edit freely; keep the budget identical. */
const candidate: Picker = (pos, army, seed) => {
  if (pos.turn !== army) return null;
  return pickMove(pos, {
    depth: 3, nodeBudget: BUDGET, branchCap: 14, temperature: 0.4, rolloutPlies: 8,
    weights: uniformWeights(), rng: makeRng(seed),
  }).move;
};

interface Tally {
  games: number;
  wins: number;
  points: number;
  rivalPoints: number;
}

const tally: Record<'candidate' | 'incumbent', Tally> = {
  candidate: { games: 0, wins: 0, points: 0, rivalPoints: 0 },
  incumbent: { games: 0, wins: 0, points: 0, rivalPoints: 0 },
};

const started = process.hrtime.bigint();
let totalPlies = 0;

for (let g = 0; g < GAMES; g++) {
  // Rotate the candidate through every seat; the other three run the incumbent.
  const candidateSeat: Army = ARMIES[g % 4];
  const game = Game.create(FFA_RULES);
  const baseSeed = 0x5eed0 + g * 7919;

  let plies = 0;
  while (!game.result().over && plies < MAX_PLIES) {
    const turn = game.pos.turn;
    const picker = turn === candidateSeat ? candidate : incumbent;
    const move = picker(game.pos, turn, (baseSeed ^ (plies * 2654435761)) >>> 0);
    if (move === null) break;
    game.play(move);
    plies++;
  }
  totalPlies += plies;

  const winners = game.result().over
    ? game.result().winners
    : ARMIES.filter((a) => game.pos.points[a] === Math.max(...ARMIES.map((x) => game.pos.points[x])));

  const candPts = game.pos.points[candidateSeat];
  const rivalAvg = ARMIES.filter((a) => a !== candidateSeat)
    .reduce((s, a) => s + game.pos.points[a], 0) / 3;

  tally.candidate.games++;
  tally.candidate.points += candPts;
  tally.candidate.rivalPoints += rivalAvg;
  if (winners.includes(candidateSeat)) tally.candidate.wins++;

  tally.incumbent.games++;
  tally.incumbent.points += rivalAvg;
  tally.incumbent.rivalPoints += candPts;
  if (winners.some((w) => w !== candidateSeat)) tally.incumbent.wins++;

  if ((g + 1) % 8 === 0) {
    const secs = Number(process.hrtime.bigint() - started) / 1e9;
    console.log(
      `  game ${g + 1}/${GAMES}  candidate wins ${tally.candidate.wins}  ` +
      `avg pts ${(tally.candidate.points / tally.candidate.games).toFixed(1)} vs ` +
      `${(tally.candidate.rivalPoints / tally.candidate.games).toFixed(1)}  (${secs.toFixed(0)}s)`,
    );
  }
}

const secs = Number(process.hrtime.bigint() - started) / 1e9;
const d = tally.candidate;
console.log('');
console.log(`arena: candidate (1 rotating seat) vs incumbent (3 seats), ${GAMES} games, budget ${BUDGET} nodes/move`);
console.log(`elapsed            : ${secs.toFixed(0)}s  (${(totalPlies / secs).toFixed(0)} plies/s)`);
console.log(`candidate win rate : ${(100 * d.wins / d.games).toFixed(1)}%   (seat-neutral baseline: 25%)`);
console.log(`candidate avg pts  : ${(d.points / d.games).toFixed(2)}`);
console.log(`incumbent avg pts  : ${(d.rivalPoints / d.games).toFixed(2)}   (per-seat average of the other three)`);
const edge = d.points / Math.max(1, d.rivalPoints);
console.log(`points ratio       : ${edge.toFixed(2)}x`);
console.log('');
console.log(d.wins / d.games > 0.25 && edge > 1
  ? 'RESULT: candidate outperforms the incumbent at equal budget.'
  : 'RESULT: no clear edge — do not ship without investigating.');
