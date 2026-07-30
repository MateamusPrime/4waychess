/**
 * Turning a finished game into ranks — where the anti-farming rules live.
 *
 * The model in `model.ts` is neutral machinery; every decision that determines whether the
 * ladder is trustworthy is made here, and each one is written down with its reasoning because
 * a rating system's failure mode is silent (RISKS.md R3, R22).
 */

import type { Army, Mode } from '@4wc/engine';

export interface SeatOutcome {
  army: Army;
  /** Account id for a human, null for a bot. */
  playerId: string | null;
  /** Final banked points. In FFA this is the win condition (RULES.md §12). */
  points: number;
  /**
   * The seat stopped responding — timeout or disconnect. Distinct from RESIGNING, which is a
   * legal strategic act that keeps your points (RULES.md §12).
   */
  abandoned: boolean;
}

export interface GameOutcome {
  mode: Mode;
  seats: SeatOutcome[];
  /** Winning armies as the engine reported them. Teams uses this; FFA derives from points. */
  winners: Army[];
}

/** Teams pairing, as in the rules: Red + Yellow versus Blue + Green. */
const TEAM_A: Army[] = ['red', 'yellow'];

/**
 * Is this game rated?
 *
 * **All four seats must be human.** The permissive alternative — rate the humans among
 * themselves and ignore bot seats — gives more rated games, which is tempting given how hard
 * four-player matchmaking is (R1). It is rejected because bots are *our* code: two friends
 * plus two bots is a controllable environment, and anything a player can control they can
 * farm. Requiring four humans also aligns with the matchmaking design, where a bot filling an
 * abandoned seat SHOULD make the game unrated — that game is no longer the one people entered.
 *
 * This is deliberately the strict end of the trade-off. It can be relaxed once there is real
 * data; a ladder that starts trustworthy and loosens is recoverable, one that starts farmable
 * is not.
 */
export function isRated(outcome: GameOutcome): boolean {
  return outcome.seats.length === 4 && outcome.seats.every((s) => s.playerId !== null);
}

/**
 * Finishing places, 1 = best, equal numbers = a tie.
 *
 * FFA ranks by POINTS, not by survival — an eliminated player can still win the game
 * (RULES.md §12), so ranking by who lived longest would rate a different game than the one
 * being played.
 *
 * MARGIN IS DELIBERATELY IGNORED. Winning by 70 points counts exactly as much as winning by 1.
 * Margin-sensitive rating rewards running up the score against an already-beaten opponent,
 * which is the same state-farming failure that broke the check bonus (RISKS.md R22) — and here
 * it would also push players toward cruelty rather than toward winning.
 *
 * ABANDONMENT IS RANKED LAST regardless of points. Otherwise the optimal play when a game
 * turns against you is to stop responding, and rage-quitting becomes a rating strategy — which
 * would also make R2 (one player quitting ruins it for three others) actively incentivised.
 * Resigning is not abandoning: it keeps your points and your points-based rank.
 */
export function ranksFor(outcome: GameOutcome): Map<Army, number> {
  const ranks = new Map<Army, number>();

  if (outcome.mode === 'teams') {
    const aWon = outcome.winners.some((w) => TEAM_A.includes(w));
    const bWon = outcome.winners.some((w) => !TEAM_A.includes(w));
    // A team that abandons cannot win the rating exchange, whatever the board said.
    const aQuit = outcome.seats.some((s) => TEAM_A.includes(s.army) && s.abandoned);
    const bQuit = outcome.seats.some((s) => !TEAM_A.includes(s.army) && s.abandoned);

    let aRank: number;
    let bRank: number;
    if (aQuit !== bQuit) {
      aRank = aQuit ? 2 : 1;
      bRank = aQuit ? 1 : 2;
    } else if (aWon === bWon) {
      aRank = 1;
      bRank = 1;
    } else {
      aRank = aWon ? 1 : 2;
      bRank = aWon ? 2 : 1;
    }
    for (const s of outcome.seats) {
      ranks.set(s.army, TEAM_A.includes(s.army) ? aRank : bRank);
    }
    return ranks;
  }

  // FFA: order by points descending, with abandoners forced behind everyone who played on.
  const sorted = [...outcome.seats].sort((a, b) => {
    if (a.abandoned !== b.abandoned) return a.abandoned ? 1 : -1;
    return b.points - a.points;
  });

  let place = 1;
  for (let i = 0; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const tied = prev !== undefined
      && prev.abandoned === cur.abandoned
      && prev.points === cur.points;
    if (!tied) place = i + 1; // standard competition ranking: 1, 2, 2, 4
    ranks.set(cur.army, place);
  }
  return ranks;
}

/** Competing units for the model: one seat each in FFA, two in Teams. */
export function groupsFor(outcome: GameOutcome): { armies: Army[]; rank: number }[] {
  const ranks = ranksFor(outcome);

  if (outcome.mode === 'teams') {
    const a = outcome.seats.filter((s) => TEAM_A.includes(s.army)).map((s) => s.army);
    const b = outcome.seats.filter((s) => !TEAM_A.includes(s.army)).map((s) => s.army);
    return [
      { armies: a, rank: ranks.get(a[0]) ?? 1 },
      { armies: b, rank: ranks.get(b[0]) ?? 2 },
    ];
  }

  return outcome.seats.map((s) => ({ armies: [s.army], rank: ranks.get(s.army) ?? 1 }));
}
