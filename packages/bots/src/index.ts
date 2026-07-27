/**
 * @4wc/bots — bot opponents for four-way chess.
 *
 * Depends on @4wc/engine and nothing else. No clock, no Math.random: budgets are node counts
 * and randomness is seeded, so every bot decision is reproducible — which tests need today and
 * server-side verification will need later (bots are matchmaking infrastructure, RISKS.md R1).
 */

export type { EvalWeights, WeightsByArmy } from './eval.ts';
export { DEFAULT_WEIGHTS, evaluate, uniformWeights } from './eval.ts';

export type { SearchOptions, SearchResult } from './search.ts';
export { pickMove } from './search.ts';

export type { Bot, Difficulty, Personality, PersonalityId } from './personalities.ts';
export { DIFFICULTIES, PERSONALITIES, PERSONALITY_IDS, makeBot } from './personalities.ts';

export type { Rng } from './rng.ts';
export { makeRng } from './rng.ts';
