/**
 * The ladder: applying games to a rating table, and rebuilding it from history.
 *
 * `recompute` is the reason this whole package is pure. A rating system's real risk is not
 * getting the maths wrong once — it is being UNABLE to fix it later, because ratings were
 * accumulated in place and the inputs were never kept (RISKS.md R3). Here the table is always
 * a pure function of the ordered outcome list, so a bad model, a bad constant or a discovered
 * exploit can be corrected and the entire ladder rebuilt from stored games.
 */

import type { Army } from '@4wc/engine';
import type { GameOutcome } from './outcome.ts';
import { groupsFor, isRated } from './outcome.ts';
import {
  PROVISIONAL_GAMES, displayRating, newRating, rateGroups,
} from './model.ts';
import type { Rating } from './model.ts';

/** playerId → rating. Treated as immutable; every function returns a new table. */
export type RatingTable = ReadonlyMap<string, Rating>;

export function ratingOf(table: RatingTable, playerId: string): Rating {
  return table.get(playerId) ?? newRating();
}

/**
 * Apply one finished game. Unrated games (see `isRated`) return the table unchanged, by
 * identity, so callers can cheaply detect that nothing happened.
 */
export function applyGame(table: RatingTable, outcome: GameOutcome): RatingTable {
  if (!isRated(outcome)) return table;

  const byArmy = new Map<Army, string>();
  for (const s of outcome.seats) {
    if (s.playerId !== null) byArmy.set(s.army, s.playerId);
  }

  const groups = groupsFor(outcome);
  const ids: string[][] = groups.map((g) => g.armies.map((a) => byArmy.get(a) ?? ''));
  if (ids.some((g) => g.some((id) => id === ''))) return table;

  const before: Rating[][] = ids.map((g) => g.map((id) => ratingOf(table, id)));
  const after = rateGroups(before, groups.map((g) => g.rank));

  const next = new Map(table);
  ids.forEach((group, gi) => {
    group.forEach((id, pi) => {
      next.set(id, after[gi][pi]);
    });
  });
  return next;
}

/**
 * Rebuild the whole ladder from an ordered history. Chronological order matters — ratings are
 * path-dependent — so callers must pass games oldest-first.
 */
export function recompute(outcomes: readonly GameOutcome[]): RatingTable {
  let table: RatingTable = new Map<string, Rating>();
  for (const o of outcomes) table = applyGame(table, o);
  return table;
}

export interface LeaderboardEntry {
  playerId: string;
  rating: Rating;
  display: number;
  provisional: boolean;
  rank: number;
}

/**
 * Leaderboard, best first.
 *
 * Provisional players are listed but sorted BELOW every established player at the same display
 * rating, and `includeProvisional: false` hides them entirely — because the top of a public
 * ladder is exactly where a fresh account with a lucky run does the most damage to trust.
 */
export function leaderboard(
  table: RatingTable,
  opts: { includeProvisional?: boolean; limit?: number } = {},
): LeaderboardEntry[] {
  const includeProvisional = opts.includeProvisional ?? true;
  const rows = [...table.entries()]
    .map(([playerId, rating]) => ({
      playerId,
      rating,
      display: displayRating(rating),
      provisional: rating.games < PROVISIONAL_GAMES,
      rank: 0,
    }))
    .filter((r) => includeProvisional || !r.provisional);

  rows.sort((a, b) => {
    if (a.provisional !== b.provisional) return a.provisional ? 1 : -1;
    if (b.display !== a.display) return b.display - a.display;
    // Stable, deterministic tie-break so the same table always renders the same order.
    return a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0;
  });

  rows.forEach((r, i) => { r.rank = i + 1; });
  return opts.limit === undefined ? rows : rows.slice(0, opts.limit);
}
