/**
 * Stored games → rating inputs.
 *
 * The dependency runs one way on purpose: persistence knows about ratings, ratings know
 * nothing about persistence. `@4wc/rating` stays pure and storage-agnostic (its architecture
 * test forbids importing this package), so the ladder remains a pure function of history that
 * can be rebuilt from any source — this adapter is simply how the stored history is read.
 *
 * This is the concrete answer to RISKS.md R3's requirement that we "store enough per-game
 * detail to recompute ratings retroactively": if this file can build a complete `GameOutcome`
 * from a `GameRecord`, then the ladder can be rebuilt from scratch at any time.
 */

import type { GameOutcome, RatingTable, SeatOutcome } from '@4wc/rating';
import { recompute } from '@4wc/rating';
import type { GameRecord } from './ports.ts';

/**
 * Statuses that count as ABANDONMENT for rating purposes.
 *
 * Only `timeout` qualifies. Resigning is a legal strategic act that keeps your points and your
 * place (RULES.md §12); being checkmated or stalemated is just losing. Silence is the one
 * behaviour the ladder punishes, because it is the one that ruins the game for the other three
 * (RISKS.md R2) — and if quitting rated better than finishing, it would become a strategy.
 *
 * Takes `unknown` on purpose: stored data outlives the types that wrote it. Records written
 * before `status` existed have no such field, and a rating recomputation running over years of
 * history must not throw on them. Anything unrecognised is treated as "did not abandon" —
 * the direction that cannot invent a punishment for a player who never earned one.
 */
function isAbandonment(status: unknown): boolean {
  return status === 'timeout';
}

export function outcomeFromRecord(record: GameRecord): GameOutcome {
  const seats: SeatOutcome[] = (record.seats ?? []).map((s) => ({
    army: s.army,
    playerId: s.profileId ?? null,
    points: record.points?.[s.army] ?? 0,
    abandoned: isAbandonment(s.status),
  }));
  return { mode: record.mode, seats, winners: [...(record.winners ?? [])] };
}

/**
 * Rebuild the entire ladder from stored games.
 *
 * Sorts by end time so callers need not guarantee order — ratings are path-dependent, and a
 * history replayed out of order silently produces different numbers.
 */
export function recomputeLadder(records: readonly GameRecord[]): RatingTable {
  const ordered = [...records].sort((a, b) => a.endedAtMs - b.endedAtMs);
  return recompute(ordered.map(outcomeFromRecord));
}
