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
 * Candidate: classic max-n with capture-rollout leaves. Incumbent: classic max-n with bare
 * leaves. Both use DEFAULT_WEIGHTS at the same budget — this isolates the leaf-resolution
 * variable, the one piece of the deep-search experiment the arena did not reject.
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

const classic: Picker = (pos, army, seed) => {
  if (pos.turn !== army) return null;
  // Depth 3 is classic's best use of this budget (it will bail on the cap anyway).
  return pickMove(pos, {
    depth: 3, nodeBudget: BUDGET, branchCap: 14, temperature: 0.4,
    weights: uniformWeights(), rng: makeRng(seed),
  }).move;
};

const deep: Picker = (pos, army, seed) => {
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

const tally: Record<'deep' | 'classic', Tally> = {
  deep: { games: 0, wins: 0, points: 0, rivalPoints: 0 },
  classic: { games: 0, wins: 0, points: 0, rivalPoints: 0 },
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
    const picker = turn === candidateSeat ? deep : classic;
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

  tally.deep.games++;
  tally.deep.points += candPts;
  tally.deep.rivalPoints += rivalAvg;
  if (winners.includes(candidateSeat)) tally.deep.wins++;

  tally.classic.games++;
  tally.classic.points += rivalAvg;
  tally.classic.rivalPoints += candPts;
  if (winners.some((w) => w !== candidateSeat)) tally.classic.wins++;

  if ((g + 1) % 8 === 0) {
    const secs = Number(process.hrtime.bigint() - started) / 1e9;
    console.log(
      `  game ${g + 1}/${GAMES}  deep wins ${tally.deep.wins}  ` +
      `avg pts ${(tally.deep.points / tally.deep.games).toFixed(1)} vs ` +
      `${(tally.deep.rivalPoints / tally.deep.games).toFixed(1)}  (${secs.toFixed(0)}s)`,
    );
  }
}

const secs = Number(process.hrtime.bigint() - started) / 1e9;
const d = tally.deep;
console.log('');
console.log(`arena: classic+rollout (candidate, 1 seat) vs classic-bare (3 seats), ${GAMES} games, budget ${BUDGET} nodes/move`);
console.log(`elapsed            : ${secs.toFixed(0)}s  (${(totalPlies / secs).toFixed(0)} plies/s)`);
console.log(`deep win rate      : ${(100 * d.wins / d.games).toFixed(1)}%   (seat-neutral baseline: 25%)`);
console.log(`deep avg points    : ${(d.points / d.games).toFixed(2)}`);
console.log(`classic avg points : ${(d.rivalPoints / d.games).toFixed(2)}   (per-seat average of the other three)`);
const edge = d.points / Math.max(1, d.rivalPoints);
console.log(`points ratio       : ${edge.toFixed(2)}x`);
console.log('');
console.log(d.wins / d.games > 0.25 && edge > 1
  ? 'RESULT: deep outperforms classic at equal budget.'
  : 'RESULT: no clear edge — do not ship without investigating.');
