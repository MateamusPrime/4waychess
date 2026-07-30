/**
 * @4wc/rating — multiplayer-native skill rating for four-way chess.
 *
 * Pure and deterministic: no clock, no randomness, no I/O. That is not tidiness, it is the
 * requirement that makes the ladder fixable — every rating is a pure function of the ordered
 * game history, so a bad model or a discovered exploit can be corrected and the whole ladder
 * rebuilt from stored games (RISKS.md R3).
 *
 * Ships in Phase 6; designed in Phase 3 because a rating model must be chosen BEFORE there is
 * live rating data to invalidate.
 */

export type { Rating } from './model.ts';
export {
  BETA, DEFAULT_MU, DEFAULT_SIGMA, KAPPA, PROVISIONAL_GAMES, TAU,
  displayRating, isProvisional, newRating, rateGroups,
} from './model.ts';

export type { GameOutcome, SeatOutcome } from './outcome.ts';
export { groupsFor, isRated, ranksFor } from './outcome.ts';

export type { LeaderboardEntry, RatingTable } from './ladder.ts';
export { applyGame, leaderboard, ratingOf, recompute } from './ladder.ts';
