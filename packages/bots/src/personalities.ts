/**
 * Bot personalities and difficulty tiers.
 *
 * The confirmed product direction (ROADMAP Phase 2): CHARACTERFUL beats strong. An opponent
 * with visible temperament — the one who always comes for you, the one who turtles, the one
 * who only wants points, the one who hunts the leader — is more fun to lose to than a
 * stronger anonymous engine. Personality lives in the evaluation weights; difficulty lives in
 * search depth, node budget and root temperature.
 */

import { ARMIES, generateLegal, materialValue } from '@4wc/engine';
import type { Army, Move, Position } from '@4wc/engine';
import { DEFAULT_WEIGHTS, uniformWeights } from './eval.ts';
import type { EvalWeights, WeightsByArmy } from './eval.ts';
import { pickMove } from './search.ts';
import { makeRng } from './rng.ts';

export type PersonalityId = 'aggressive' | 'turtle' | 'opportunist' | 'kingmaker';
export type Difficulty = 'easy' | 'medium' | 'hard';

export interface Personality {
  id: PersonalityId;
  name: string;
  /** One-liner shown in the seat picker. */
  blurb: string;
  weights: EvalWeights;
}

export const PERSONALITIES: Readonly<Record<PersonalityId, Personality>> = {
  aggressive: {
    id: 'aggressive',
    name: 'Reaper',
    blurb: 'Comes straight for your king and never apologises.',
    weights: {
      ...DEFAULT_WEIGHTS,
      aggression: 0.55,
      kingSafety: 0.18,
      material: 0.8,
      center: 0.04,
      // Reaper accepts sharper positions, but "careless" must never mean "hangs queens".
      hanging: 0.85,
    },
  },
  turtle: {
    id: 'turtle',
    name: 'Bastion',
    blurb: 'Castles early, hides deep, waits for you to blunder.',
    weights: {
      ...DEFAULT_WEIGHTS,
      kingSafety: 0.8,
      aggression: 0.05,
      material: 1.0,
      pawnAdvance: 0.03,
      hanging: 1.3,
    },
  },
  opportunist: {
    id: 'opportunist',
    name: 'Magpie',
    blurb: 'Cares only about the score. Will rob whoever is nearest.',
    weights: {
      ...DEFAULT_WEIGHTS,
      points: 1.4,
      material: 1.0,
      aggression: 0.18,
      kingSafety: 0.3,
    },
  },
  kingmaker: {
    id: 'kingmaker',
    name: 'Leveller',
    blurb: 'Hunts whoever is winning. Nothing personal.',
    weights: {
      ...DEFAULT_WEIGHTS,
      leaderAversion: 0.45,
      aggression: 0.3,
      kingSafety: 0.3,
    },
  },
};

export const PERSONALITY_IDS: readonly PersonalityId[] =
  ['aggressive', 'turtle', 'opportunist', 'kingmaker'];

interface DifficultyParams {
  depth: number;
  nodeBudget: number;
  branchCap: number;
  temperature: number;
}

/**
 * Budgets are node counts (≈1k nodes/ms — search runs on the UI thread in Phase 2, so hard
 * stays around ~40ms per move). Easy is softened by temperature, not by playing junk: it
 * still picks from the top candidates, just less sharply.
 */
export const DIFFICULTIES: Readonly<Record<Difficulty, DifficultyParams>> = {
  easy: { depth: 1, nodeBudget: 2_000, branchCap: 16, temperature: 2.2 },
  medium: { depth: 2, nodeBudget: 12_000, branchCap: 18, temperature: 0.9 },
  hard: { depth: 3, nodeBudget: 40_000, branchCap: 14, temperature: 0 },
};

export interface Bot {
  personality: Personality;
  difficulty: Difficulty;
  /** Choose a move for `army` in this position. Null only when there is no legal move. */
  pick(pos: Position, army: Army): Move | null;
}

/**
 * Should this bot resign?
 *
 * Found in an all-bot soak: a finished game refused to end. Three near-bare kings shuffled
 * around one rook for dozens of rounds — the points race was long decided, no shuffle could
 * change it, and the fifty-round rule was most of an hour away. A human in that seat resigns,
 * and under our rules (RULES.md §12) that is the CORRECT collapse: when the hopeless players
 * concede, the game ends and the points leader wins.
 *
 * Deliberately strict, because resigning a winnable game reads far worse than shuffling:
 *  - bare king only (no material at all);
 *  - more than CHECKMATE_BONUS points behind the leader, so even a miracle +20 king capture
 *    could not close the gap;
 *  - FFA only — in Teams your pieces outlive you via your partner, so the seat still matters.
 */
export function wantsResign(pos: Position, army: Army): boolean {
  if (pos.rules.mode !== 'ffa') return false;
  if (!pos.isActive(army)) return false;
  if (materialValue(pos, army) > 0) return false;
  const best = Math.max(...ARMIES.filter((a) => a !== army).map((a) => pos.points[a]));
  return best - pos.points[army] > 20;
}

/**
 * Build a bot for one seat.
 *
 * `weightsByArmy` gives EVERY army this bot's model of the table (opponents are assumed
 * default-weighted); its own seat uses its personality weights. Deterministic under `seed`.
 */
export function makeBot(
  personality: PersonalityId,
  difficulty: Difficulty,
  seed: number,
): Bot {
  const p = PERSONALITIES[personality];
  const params = DIFFICULTIES[difficulty];
  const rng = makeRng(seed);

  return {
    personality: p,
    difficulty,
    pick(pos: Position, army: Army): Move | null {
      if (pos.turn !== army || generateLegal(pos, army).length === 0) {
        if (pos.turn !== army) return null;
      }
      const weights: WeightsByArmy = {
        ...uniformWeights(),
        [army]: p.weights,
      };
      const result = pickMove(pos, {
        depth: params.depth,
        nodeBudget: params.nodeBudget,
        branchCap: params.branchCap,
        temperature: params.temperature,
        weights,
        rng,
      });
      return result.move;
    },
  };
}
