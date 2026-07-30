# Rating Model

**Status: DECIDED.** Implemented in `packages/rating`. Ships in Phase 6; designed in Phase 3
because a rating model must be chosen *before* there is live rating data to invalidate
(RISKS.md R3).

---

## Why not Elo

Elo is a two-player pairwise system. Four-way FFA produces a **ranking of four players**, and
the usual adaptation — decompose each game into six pairwise Elo matches — double-counts every
game and makes the ladder farmable.

That is not a cosmetic problem. In FFA the points race *is* the win condition, and the
leaderboard is the entire Phase-6 retention loop. A farmable rating poisons everything built on
top of it, and by the time it is obvious there is a live population whose ratings are all wrong.

## The model: Weng–Lin Bayesian approximation

Each player holds a belief about their skill: a mean **μ** and an uncertainty **σ**.

Both TrueSkill and Weng–Lin are Bayesian skill models that handle N-way free-for-alls and teams
natively. TrueSkill needs factor-graph message passing with truncated-Gaussian moment matching;
Weng–Lin gets comparable quality from a **closed-form** update (Weng & Lin, *JMLR* 12, 2011).
Closed form means no dependencies, no iteration limits, trivial determinism, and an
implementation short enough to audit line by line — which matters because this code must be
able to rebuild the entire ladder from history on demand.

| Constant | Value | Meaning |
|---|---|---|
| μ₀ | 25 | Starting mean. Only differences matter. |
| σ₀ | 25/3 ≈ 8.33 | Starting uncertainty. Chosen so μ − 3σ ≈ 0 for a new player. |
| β | σ₀/2 ≈ 4.17 | Performance noise. Four-way FFA is noisier than 1v1. |
| τ | σ₀/100 ≈ 0.083 | Dynamics — uncertainty added back per game so settled ratings can still move. |
| κ | 1e-4 | Variance floor, so σ² can never reach zero. |

**Displayed rating = max(0, round((μ − 3σ) × 40)).** New players start at **0 and earn
upward**, which reads far better than starting at 1500 and sliding.

Observed trajectory for a player winning every game: 0 → 416 (1 game) → 804 (3) → 1270 (10) →
1524 (20) → 1974 (80).

## The anti-farming rules

Each of these is a decision with a reason, and each has a named test.

### 1. Only all-human games are rated

Bots are *our* code, so a table containing them is a controllable environment — and anything a
player can control, a player can farm. This also means a bot filling an abandoned seat
correctly **de-rates** the game: it is no longer the game people entered.

The permissive alternative (rate the humans among themselves, ignore bot seats) yields more
rated games, which is tempting given how hard four-player matchmaking is (R1). It is rejected
because two friends plus two bots would be a controllable environment. **A ladder that starts
trustworthy and loosens is recoverable; one that starts farmable is not.**

### 2. Rank by points, not by survival

An eliminated player can still win a game (RULES.md §12). Ranking by who survived longest would
rate a different game than the one being played.

### 3. Margin is deliberately ignored

Winning by 70 points counts exactly as winning by 1. Margin-sensitive rating rewards running up
the score against an already-beaten opponent — the same state-farming failure that broke the
check bonus (RISKS.md R22) — and it would push players toward cruelty rather than toward
winning.

### 4. Abandonment ranks last; resignation does not

**Timing out ranks you last regardless of points.** Otherwise the optimal response to a game
going badly is to stop responding, rage-quitting becomes a rating strategy, and R2 (one player
quitting ruins it for three others) becomes actively *incentivised*.

**Resigning is not abandoning.** It is a legal strategic act that keeps your points and your
points-based place. Only silence is punished.

This distinction is why `SeatRecord.status` is denormalised out of the PGN4 and stored on the
seat: recomputing the ladder must never require parsing every stored game's movetext to recover
something this load-bearing.

### 5. The leaderboard is conservative

Ordering by **μ − 3σ** means a fresh account cannot leap the board on a handful of lucky games —
its uncertainty is still enormous. Provisional players (fewer than 10 rated games) sort below
established ones and can be hidden entirely, because the top of a public ladder is exactly
where a smurf does the most damage to trust.

Verified as a *delay, not a ceiling*: the same account overtakes an established rival once it
has played the uncertainty off.

## Teams

Partners share a pooled (μ, σ²); the update is distributed back in proportion to each member's
own variance, so the **least certain partner learns the most** from a shared result. A team
whose member abandons loses the rating exchange regardless of the board result — you cannot win
a rated game by having your partner vanish.

## The property that makes it fixable

Every function in `packages/rating` is **pure**: no clock, no randomness, no I/O, no storage
access. This is enforced by an architecture test, and it is the feature rather than tidiness.

A rating system's real risk is not getting the maths wrong once — it is being **unable to fix
it later**, because ratings were accumulated in place and the inputs were discarded. Here the
ladder is a pure function of the ordered game history, so a bad model, a badly chosen constant,
or a discovered exploit can be corrected and the whole ladder rebuilt from stored games.

`recomputeLadder(records)` in `@4wc/store` is that path, and it sorts by end time because
ratings are path-dependent and a storage listing is newest-first by design.

## Open for Phase 6

- **Seasons / decay** — whether ratings reset or drift toward the mean over time.
- **Matchmaking use** — rating-banded queues, and whether the band widens with queue time (R1).
- **Collusion detection** — four-player games make feeding easy; move-time and result telemetry
  are being collected from Phase 4 so detection can be built against real data (R17).
- **Constant tuning** — β and τ are principled defaults, not measured ones. Once real games
  exist they can be fitted, and every historical rating recomputed with the better values.
