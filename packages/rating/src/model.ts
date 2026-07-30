/**
 * The rating model: Weng–Lin Bayesian approximation, Bradley–Terry full pairing.
 *
 * WHY NOT ELO: Elo is a two-player pairwise system. Four-way FFA produces a RANKING of four
 * players, and the usual fix — decompose into six pairwise Elo matches — double-counts every
 * game and makes the ladder farmable (RISKS.md R3). A farmable ladder is not a cosmetic
 * problem: in FFA the points race is the win condition and the leaderboard is the whole
 * retention loop, so a broken rating poisons everything built on it.
 *
 * WHY WENG–LIN over TrueSkill: both are Bayesian skill models with (μ, σ) per player that
 * handle N-way free-for-alls and teams natively. TrueSkill needs factor-graph message passing
 * with truncated-Gaussian moment matching; Weng–Lin gets ~the same quality from a CLOSED FORM
 * update (Weng & Lin, JMLR 12, 2011). Closed form means: no dependencies, no iteration limits,
 * trivially deterministic, and short enough to audit line by line — which matters because this
 * package must be able to recompute the entire ladder from history at any time.
 *
 * Every function here is pure. No clock, no randomness, no I/O — enforced by the architecture
 * test — because retroactive recomputation is only possible if ratings are a pure function of
 * the ordered game history.
 */

/** A player's skill belief: mean estimate and uncertainty. */
export interface Rating {
  /** Mean skill estimate. */
  mu: number;
  /** Standard deviation — how unsure we are. Starts high, shrinks with games played. */
  sigma: number;
  /** Rated games contributing to this rating. Display and provisional logic use it. */
  games: number;
}

/** Starting mean. The absolute value is arbitrary; only differences matter. */
export const DEFAULT_MU = 25;
/** Starting uncertainty. The convention μ/3 makes μ − 3σ ≈ 0 for a brand-new player. */
export const DEFAULT_SIGMA = DEFAULT_MU / 3;
/**
 * Performance variance: how much a single game's outcome is luck rather than skill. Higher
 * means results move ratings less. Four-way FFA is noisier than 1v1 — three opponents, a
 * points race, kingmaking — so this sits at the standard σ0/2 rather than lower.
 */
export const BETA = DEFAULT_SIGMA / 2;
/**
 * Dynamics: uncertainty added back before each game so a settled rating can still move when a
 * player genuinely improves. Without it σ collapses and the rating freezes forever.
 */
export const TAU = DEFAULT_SIGMA / 100;
/** Floor on the variance multiplier, so σ² can never go negative or vanish. */
export const KAPPA = 1e-4;

/** Games needed before a rating is shown without a "provisional" marker. */
export const PROVISIONAL_GAMES = 10;

export function newRating(): Rating {
  return { mu: DEFAULT_MU, sigma: DEFAULT_SIGMA, games: 0 };
}

/**
 * The number shown to players and used for leaderboard ordering.
 *
 * Conservative by construction: μ − 3σ is the bottom of the belief interval, so a player must
 * both perform well AND play enough games for the ladder to be sure. That single choice is
 * also the main anti-farming defence at the top of the board — a new or smurf account cannot
 * leap the leaderboard on a handful of lucky games, because its σ is still enormous.
 *
 * Scaled by 40 and floored at 0 so a new player starts at 0 and earns upward, which reads
 * far better than starting at 1500 and sliding.
 */
export function displayRating(r: Rating): number {
  return Math.max(0, Math.round((r.mu - 3 * r.sigma) * 40));
}

export function isProvisional(r: Rating): boolean {
  return r.games < PROVISIONAL_GAMES;
}

/** Add dynamics uncertainty. Applied once per rated game, before the update. */
function withDynamics(r: Rating): Rating {
  return { ...r, sigma: Math.sqrt(r.sigma * r.sigma + TAU * TAU) };
}

/**
 * Rate one game.
 *
 * `groups` are the competing units — one player each in FFA, two in Teams — and `ranks` gives
 * each group's finishing place, 1 = best, equal numbers = a tie. Returns new ratings in the
 * same shape; inputs are not mutated.
 *
 * The maths, per Weng & Lin Algorithm 1 (Bradley–Terry, full pairing): each group is compared
 * against every other, contributing a mean adjustment Ω weighted by how surprising the result
 * was, and a variance reduction Δ. Teams share a pooled (μ, σ²) and the update is distributed
 * back to members in proportion to their own variance — so the least certain member of a team
 * learns the most from the result, which is exactly right.
 */
export function rateGroups(groups: Rating[][], ranks: number[]): Rating[][] {
  if (groups.length !== ranks.length) {
    throw new Error(`rateGroups: ${groups.length} groups but ${ranks.length} ranks`);
  }
  if (groups.length < 2) return groups.map((g) => g.map((r) => ({ ...r })));

  const primed = groups.map((g) => g.map(withDynamics));

  // Pool each group into a single competitor.
  const mu = primed.map((g) => g.reduce((s, r) => s + r.mu, 0));
  const sigmaSq = primed.map((g) => g.reduce((s, r) => s + r.sigma * r.sigma, 0));

  const out: Rating[][] = [];

  for (let i = 0; i < primed.length; i++) {
    let omega = 0;
    let delta = 0;

    for (let q = 0; q < primed.length; q++) {
      if (q === i) continue;

      const c = Math.sqrt(sigmaSq[i] + sigmaSq[q] + 2 * BETA * BETA);
      // Logistic form rather than exp(μ/c)/(exp(μ/c)+exp(μ_q/c)): algebraically identical and
      // numerically stable, since the exponent stays bounded as ratings grow.
      const pIQ = 1 / (1 + Math.exp((mu[q] - mu[i]) / c));
      const pQI = 1 - pIQ;

      // Lower rank number is better, so i beat q when q's rank is the larger number.
      const score = ranks[q] > ranks[i] ? 1 : ranks[q] === ranks[i] ? 0.5 : 0;

      const gamma = Math.sqrt(sigmaSq[i]) / c;
      omega += (sigmaSq[i] / c) * (score - pIQ);
      delta += ((gamma * sigmaSq[i]) / (c * c)) * pIQ * pQI;
    }

    // Distribute the group's update to its members, weighted by each member's own variance.
    out.push(primed[i].map((r) => {
      const share = (r.sigma * r.sigma) / sigmaSq[i];
      const nextSigmaSq = r.sigma * r.sigma * Math.max(1 - share * delta, KAPPA);
      return {
        mu: r.mu + share * omega,
        sigma: Math.sqrt(nextSigmaSq),
        games: r.games + 1,
      };
    }));
  }

  return out;
}
