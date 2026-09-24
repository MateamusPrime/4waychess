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
import { pickMoveDeep } from './deep.ts';
import { makeRng } from './rng.ts';

export type PersonalityId = 'aggressive' | 'turtle' | 'opportunist' | 'kingmaker';
export type Difficulty = 'easy' | 'medium' | 'hard' | 'expert';

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
  engine: 'classic' | 'deep';
  depth: number;
  nodeBudget: number;
  branchCap: number;
  replyCap: number;
  rolloutPlies: number;
  temperature: number;
  /** Deepen until the node budget runs out, with `depth` as the ceiling. */
  iterative: boolean;
}

/**
 * All tiers use CLASSIC max-n with BARE leaves. This is a measured decision, not a default:
 * the arena rejected every Lever-1 search variant at equal node budget —
 *
 *   paranoid BRS      10.4% wins, 0.69x points   (paranoia is passivity in a race)
 *   rational-reply    29.2% wins, 0.98x points   (reply compression distorts tempo)
 *   classic+rollout    2.1% wins, 0.50x points   (leaf cost starves tree breadth)
 *
 * — converging on one law for this game at these budgets: spend everything on breadth of the
 * true turn-order model. The static hanging-piece term already covers exchange risk. The
 * experiments live on in deep.ts / rollout.ts as arena-refuted baselines for future work;
 * the WORKER survives regardless (it is engine-agnostic), which means budgets here can grow
 * with hardware headroom rather than UI-thread politeness.
 *
 * What DID buy strength is spending the classic budget on the right moves: threat-aware
 * ordering plus a root that ranks every legal move (61.5% wins vs the old Hard at identical
 * depth and cap), and iterative deepening so the budget rather than a fixed depth sets the
 * horizon (new Hard: 70.8% wins, +37 points per game vs the old Hard; ROADMAP Phase 2.5).
 */
export const DIFFICULTIES: Readonly<Record<Difficulty, DifficultyParams>> = {
  easy: {
    engine: 'classic', depth: 1, nodeBudget: 2_000, branchCap: 16,
    replyCap: 0, rolloutPlies: 0, temperature: 2.2, iterative: false,
  },
  medium: {
    engine: 'classic', depth: 2, nodeBudget: 12_000, branchCap: 18,
    replyCap: 0, rolloutPlies: 0, temperature: 0.9, iterative: false,
  },
  hard: {
    engine: 'classic', depth: 4, nodeBudget: 30_000, branchCap: 10,
    replyCap: 0, rolloutPlies: 0, temperature: 0, iterative: true,
  },
  expert: {
    engine: 'classic', depth: 5, nodeBudget: 120_000, branchCap: 8,
    replyCap: 0, rolloutPlies: 0, temperature: 0, iterative: true,
  },
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
      if (pos.turn !== army) return null;
      const weights: WeightsByArmy = {
        ...uniformWeights(),
        [army]: p.weights,
      };
      if (params.engine === 'deep') {
        return pickMoveDeep(pos, army, {
          maxDepth: params.depth,
          nodeBudget: params.nodeBudget,
          branchCap: params.branchCap,
          replyCap: params.replyCap,
          rolloutPlies: params.rolloutPlies,
          temperature: params.temperature,
          weights,
          rng,
        }).move;
      }
      return pickMove(pos, {
        depth: params.depth,
        nodeBudget: params.nodeBudget,
        branchCap: params.branchCap,
        temperature: params.temperature,
        rolloutPlies: params.rolloutPlies,
        iterative: params.iterative,
        weights,
        rng,
      }).move;
    },
  };
}
