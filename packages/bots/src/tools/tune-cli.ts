/**
 * Lever 2 — self-play weight tuning by SPSA.
 *
 * Every eval weight shipped today is a hand-guess of mine. Search engineering was measured and
 * rejected (Lever 1), which leaves the evaluation as the one axis nothing has yet optimised —
 * and unlike search, it needs no new algorithms, just compute and an honest fitness function.
 *
 * SPSA (Simultaneous Perturbation Stochastic Approximation) is the standard choice for noisy,
 * expensive, high-dimensional objectives like "does this weight vector win more games". Each
 * iteration perturbs EVERY weight at once by a random ±, plays a mini-match between the two
 * perturbed vectors, and steps along the measured difference. Two matches per iteration
 * regardless of dimension count is what makes it affordable here.
 *
 *   node src/tools/tune-cli.ts [iterations] [gamesPerIteration] [nodeBudget]
 *
 * IMPORTANT: this tool only PROPOSES weights. Nothing ships until the proposal beats the
 * incumbent in `arena-cli.ts` at equal budget — the same discipline that rejected all three
 * Lever 1 search variants.
 */

import { ARMIES, FFA_RULES, Game } from '@4wc/engine';
import type { Army } from '@4wc/engine';
import { DEFAULT_WEIGHTS } from '../eval.ts';
import type { EvalWeights, WeightsByArmy } from '../eval.ts';
import { pickMove } from '../search.ts';
import { makeRng } from '../rng.ts';

const ITERATIONS = Number(process.argv[2] ?? 40);
const GAMES_PER_ITER = Number(process.argv[3] ?? 4);
const BUDGET = Number(process.argv[4] ?? 800);
const MAX_PLIES = 200;

/**
 * Weights tuned, and the one that is NOT.
 *
 * `points` is pinned at 1.0 as the unit of account. The evaluation is scale-invariant for move
 * selection — multiplying every weight by a constant leaves the argmax unchanged — so tuning
 * all of them together would let the whole vector random-walk in magnitude while learning
 * nothing. Fixing one reference weight removes that degeneracy and makes every other number
 * interpretable as "worth this many points".
 */
const TUNED: (keyof EvalWeights)[] = [
  'material', 'center', 'pawnAdvance', 'kingSafety', 'aggression', 'hanging',
];

/**
 * SPSA gains. Classic Spall decay: a/(k+1+A)^alpha and c/(k+1)^gamma.
 *
 * The gains are small because the objective and the parameters live on wildly different
 * scales: a game's points differential swings by tens, while the weights are order 0.1–1.
 * The first version used textbook gains and drove kingSafety from 0.35 to 9.56 in two
 * iterations — a "tuner" that only destroys the vector it was given. Two fixes below:
 * DIFF_SCALE normalises the objective to roughly ±1, and MAX_STEP_FRACTION hard-caps how far
 * any single iteration may move a weight, which keeps the run stable even if the objective
 * scale changes again.
 */
const A_GAIN = 0.02;
const C_GAIN = 0.08;
const A_STABILITY = ITERATIONS * 0.1;
const ALPHA = 0.602;
const GAMMA = 0.101;
/** Typical magnitude of a points differential, used to normalise the objective. */
const DIFF_SCALE = 40;
/** No weight may move more than this fraction of its own magnitude in one iteration. */
const MAX_STEP_FRACTION = 0.15;
/** Floor so a weight that reaches zero can still recover. */
const MIN_STEP_BASE = 0.05;

/** Weights must stay non-negative; a negative kingSafety would mean "seek danger". */
const clampWeights = (w: EvalWeights): EvalWeights => {
  const out = { ...w };
  for (const k of TUNED) out[k] = Math.max(0, out[k]);
  return out;
};

function perturb(base: EvalWeights, delta: Record<string, number>, scale: number): EvalWeights {
  const out = { ...base };
  for (const k of TUNED) out[k] = base[k] + scale * delta[k];
  return clampWeights(out);
}

const seatWeights = (self: EvalWeights, army: Army): WeightsByArmy => {
  const table = {} as Record<Army, EvalWeights>;
  for (const a of ARMIES) table[a] = a === army ? self : DEFAULT_WEIGHTS;
  return table;
};

/**
 * Play one game: two seats run `plus`, two run `minus`. Returns plus-points minus minus-points.
 *
 * Two-versus-two rather than one-versus-three because it doubles the signal per game at no
 * extra cost, and pairing DIAGONAL seats (red+yellow vs blue+green) keeps the split symmetric
 * — adjacent pairs would give one side both of another's neighbours and bias the comparison.
 */
function playMatch(plus: EvalWeights, minus: EvalWeights, seed: number, swap: boolean): number {
  const plusSeats: Army[] = swap ? ['blue', 'green'] : ['red', 'yellow'];
  const game = Game.create(FFA_RULES);
  let plies = 0;

  while (!game.result().over && plies < MAX_PLIES) {
    const turn = game.pos.turn;
    const isPlus = plusSeats.includes(turn);
    const w = isPlus ? plus : minus;
    const move = pickMove(game.pos, {
      depth: 2,
      nodeBudget: BUDGET,
      branchCap: 14,
      temperature: 0.5,
      weights: seatWeights(w, turn),
      rng: makeRng((seed ^ Math.imul(plies + 1, 2654435761)) >>> 0),
    }).move;
    if (move === null) break;
    game.play(move);
    plies++;
  }

  const sum = (seats: Army[]): number => seats.reduce((s, a) => s + game.pos.points[a], 0);
  const minusSeats = ARMIES.filter((a) => !plusSeats.includes(a));
  return sum(plusSeats) - sum(minusSeats);
}

/** Average points differential for `plus` over several games, seats swapped to cancel bias. */
function evaluatePair(plus: EvalWeights, minus: EvalWeights, iter: number): number {
  let total = 0;
  for (let g = 0; g < GAMES_PER_ITER; g++) {
    const seed = (0xabc123 ^ Math.imul(iter * 131 + g, 2246822519)) >>> 0;
    total += playMatch(plus, minus, seed, g % 2 === 1);
  }
  return total / GAMES_PER_ITER;
}

/* ------------------------------------------------------------------ *
 * Null calibration
 * ------------------------------------------------------------------ */

/**
 * Measure the harness's own bias and noise by playing IDENTICAL weights against themselves.
 *
 * Run this before trusting any tuning session. A gradient estimate is only meaningful if the
 * effect being measured is larger than the noise floor, and the first version of this tuner
 * was confidently stepping on a signal that turned out to be indistinguishable from zero:
 * identical weights produced a mean differential of +22 points with a per-game spread of ±35.
 *
 * Reports the standard error of the mean, which is what actually decides how many games an
 * iteration needs: to detect an effect of E points you need roughly (2·sd/E)² games.
 */
function calibrate(samples: number): void {
  console.log(`null calibration: ${samples} games, identical weights on both sides\n`);
  const diffs: number[] = [];
  const started = process.hrtime.bigint();

  for (let i = 0; i < samples; i++) {
    const seed = (0xca11b ^ Math.imul(i * 977, 2246822519)) >>> 0;
    diffs.push(playMatch(theta, theta, seed, i % 2 === 1));
    if ((i + 1) % 10 === 0) {
      const secs = Number(process.hrtime.bigint() - started) / 1e9;
      console.log(`  ${i + 1}/${samples} games (${secs.toFixed(0)}s)`);
    }
  }

  const n = diffs.length;
  const mean = diffs.reduce((a, b) => a + b, 0) / n;
  const variance = diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1);
  const sd = Math.sqrt(variance);
  const sem = sd / Math.sqrt(n);

  // Split by seat assignment: a difference here is genuine seat/turn-order bias rather than noise.
  const unswapped = diffs.filter((_, i) => i % 2 === 0);
  const swapped = diffs.filter((_, i) => i % 2 === 1);
  const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

  console.log('');
  console.log(`mean differential : ${mean >= 0 ? '+' : ''}${mean.toFixed(2)}  (should be ~0)`);
  console.log(`std deviation     : ${sd.toFixed(2)} points per game`);
  console.log(`standard error    : ±${sem.toFixed(2)} on this sample`);
  console.log(`|mean| / SEM      : ${(Math.abs(mean) / Math.max(1e-9, sem)).toFixed(2)}  (> 2 suggests real bias)`);
  console.log('');
  console.log(`red+yellow as plus: ${avg(unswapped).toFixed(2)}`);
  console.log(`blue+green as plus: ${avg(swapped).toFixed(2)}`);
  console.log(`seat-pair bias    : ${((avg(unswapped) - avg(swapped)) / 2).toFixed(2)} points`);
  console.log('');
  for (const effect of [2, 5, 10]) {
    const needed = Math.ceil((2 * sd / effect) ** 2);
    console.log(`  to detect a ${String(effect).padStart(2)}-point effect: ~${needed} games per iteration`);
  }
}

/* ------------------------------------------------------------------ */

const rng = makeRng(0x5eeded);
let theta = clampWeights({ ...DEFAULT_WEIGHTS, points: 1.0, leaderAversion: 0 });

if (process.argv.includes('--null')) {
  calibrate(ITERATIONS);
  process.exit(0);
}

console.log(`SPSA: ${ITERATIONS} iterations x ${GAMES_PER_ITER} games, budget ${BUDGET} nodes`);
console.log(`tuning ${TUNED.join(', ')} with points pinned at 1.0\n`);
console.log('start:', TUNED.map((k) => `${k}=${theta[k].toFixed(3)}`).join(' '));

const started = process.hrtime.bigint();
let games = 0;

for (let k = 0; k < ITERATIONS; k++) {
  const ak = A_GAIN / Math.pow(k + 1 + A_STABILITY, ALPHA);
  const ck = C_GAIN / Math.pow(k + 1, GAMMA);

  // Rademacher perturbation: each weight moves by exactly ±ck this iteration.
  const delta: Record<string, number> = {};
  for (const key of TUNED) delta[key] = rng() < 0.5 ? -1 : 1;

  const plus = perturb(theta, delta, ck);
  const minus = perturb(theta, delta, -ck);

  const diff = evaluatePair(plus, minus, k);
  games += GAMES_PER_ITER;

  // g ≈ (y+ − y−) / (2 c Δ); with Rademacher deltas, 1/Δ = Δ.
  const normalised = diff / DIFF_SCALE;
  for (const key of TUNED) {
    const raw = ak * (normalised / (2 * ck)) * delta[key];
    const cap = Math.max(MIN_STEP_BASE, Math.abs(theta[key])) * MAX_STEP_FRACTION;
    theta[key] = Math.max(0, theta[key] + Math.max(-cap, Math.min(cap, raw)));
  }

  const secs = Number(process.hrtime.bigint() - started) / 1e9;
  console.log(
    `  iter ${String(k + 1).padStart(3)}/${ITERATIONS}  diff ${diff >= 0 ? '+' : ''}${diff.toFixed(1)}  ` +
    `${TUNED.map((key) => `${key.slice(0, 4)}=${theta[key].toFixed(2)}`).join(' ')}  (${secs.toFixed(0)}s)`,
  );
}

const secs = Number(process.hrtime.bigint() - started) / 1e9;
console.log('');
console.log(`done: ${games} games in ${secs.toFixed(0)}s`);
console.log('');
console.log('proposed weights (points pinned at 1.0):');
console.log(JSON.stringify(
  Object.fromEntries([['points', 1], ...TUNED.map((k) => [k, Number(theta[k].toFixed(3))])]),
  null, 2,
));
console.log('');
console.log('baseline for comparison:');
console.log(JSON.stringify(
  Object.fromEntries([['points', 1], ...TUNED.map((k) => [k, DEFAULT_WEIGHTS[k]])]),
  null, 2,
));
console.log('');
console.log('NOTHING SHIPS until this beats the incumbent in arena-cli at equal budget.');
