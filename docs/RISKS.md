# 4-Way Chess — Pre-Discovered Headaches

Ordered by *when they bite*, not by severity. Severity is marked separately.
The point of this file is that none of these should be a surprise.

---

## Existential (these can kill the product)

### R1 — Four-player matchmaking is brutally harder than two
**Bites: Phase 4.** Severity: **critical.**
A 2-player game needs one other person online. A 4-player game needs *three*, simultaneously, in your
rating band, in your time control. Queue time scales viciously against you at low population, and a game
that makes you wait four minutes to start is a game people stop opening. This is the number one reason
4-player variants fail as products.

*Mitigations:* bot backfill after a short queue timeout (bots are infrastructure, not content — see R2);
far fewer time-control options than feels natural; a correspondence mode where "four humans" is easy
(see Architecture §4.4); regional/global pooling from day one; never show an empty lobby.

### R2 — One player quitting ruins the game for three others
**Bites: Phase 4.** Severity: **critical.**
In 2-player chess a resignation ends the game cleanly. In FFA it distorts the remaining game and hands a
scoring windfall to whoever is adjacent. The chess.com rule (army dies, king stays live and moves randomly)
is a *scoring* answer, not an *experience* answer.

*Mitigations:* bot substitution on abandonment; abandonment penalties that bite; rating protection for the
remaining players; make hotseat and bot games good enough that a stalled online queue is not the only
option.

### R3 — Rating for 4-player free-for-all is an unsolved-by-default problem
**Bites: Phase 6, designed in Phase 3.** Severity: **high.**
Elo is a two-player pairwise system. FFA produces a *ranking* of four players with a *score margin*, plus
partial games (someone left), plus team games. Naively averaging pairwise Elo produces ratings people can
farm, and a farmable ladder destroys the leaderboard you are building the whole retention loop on.

*Mitigations:* use a multiplayer-native model (TrueSkill-style, or a Plackett–Luce / rank-ordered
likelihood). Decide **before** you have live rating data, because re-rating an existing population is
painful and visible. Store enough per-game detail to recompute ratings retroactively from raw results —
this single decision buys you the ability to fix a bad rating system later.

---

## Correctness

### R4 — There is no reference implementation to validate the engine against
**Bites: Phase 0.** Severity: **high.**
Standard chess engines validate move generation with published `perft` counts. **No such reference data
exists for 4-player chess**, and our house queen-left rule means even chess.com's games would not match at
the starting position.

*Mitigations:* write a second, deliberately naive and slow move generator and differential-test it against
the fast one over millions of random positions; hand-verify a corpus of positions covering every rule;
generate our own perft numbers and freeze them as regression baselines from the first correct build.
This is genuinely the highest-leverage testing decision in the project.

### R5 — Rule edge cases with no published answer
**Bites: Phase 0.** Severity: medium, but each is a source of "the game did something wrong" reports.
- **En passant across four armies** — the capture window spans two intervening turns. Who may capture, and
  for how long?
- **Threefold repetition with four players** — the state space is vastly larger and cycles are longer.
  Detection is cheap; *deciding what counts as a repetition* when a third player's position changed is not.
- **Castling** with the corner cutouts.
- **Checkmate is only evaluated when the mated player's turn arrives** — this interacts with dead armies,
  with a player being mated by someone who is themselves mated first, and with simultaneous checks.
- **Simultaneous check on two or three players** and the associated bonuses.

*Mitigation:* every one of these gets an explicit written decision in `RULES.md` with a test, before code.
Undocumented behaviour becomes accidental canon the moment players see it.

### R6 — Teams mode doubles the rules surface
**Bites: Phase 0 onward.** Severity: medium — accepted deliberately.
Different promotion rank (11th vs 8th), different win condition, no friendly fire, piece inheritance on
partner resignation, different scoring, partner-aware UI, and a second bot evaluation function.

*Mitigation:* mode is *configuration* over one engine, never a fork. If a `if (mode === 'teams')` branch
appears outside the ruleset config, that is a design smell to fix immediately.

---

## Client and platform

### R7 — Pinch-to-zoom fights drag-to-move
**Bites: Phase 1 (mobile layout) and Phase 5.** Severity: **high** — most likely thing to make the app
feel bad.
Native pinch zooms the whole page including UI chrome. Custom pinch means owning every touch gesture, and
then a one-finger drag is ambiguous between "pan the board" and "drag a piece." iOS Safari's `touch-action`
handling is genuinely finicky.

*Mitigation:* **tap-to-select then tap-to-move as the primary mobile interaction**, not drag. Confine
pinch/pan to the board container only. Prototype this on a real phone in Phase 1, not Phase 5 — it may
influence the renderer decision.

### R8 — 160 squares on a phone
**Bites: Phase 1.** Severity: medium.
A 14×14 board at phone width gives ~24px squares. Legible pieces, tap targets, and readable coordinates all
fight each other.

*Mitigation:* design the mobile board layout *first*, not as a responsive afterthought; consider a
focus/zoom viewport that follows the action; test with real thumbs.

### R9 — Clocks cannot be trusted to the client
**Bites: Phase 4.** Severity: high.
Mobile browsers suspend backgrounded tabs and timers stop dead. A client-authoritative clock is both
wrong and exploitable.

*Mitigation:* server owns clock truth; client renders an interpolated estimate; reconcile on every message.
Never let a client assert elapsed time.

### R10 — Three themes multiply the art cost
**Bites: Phase 1.** Severity: medium — accepted deliberately.
A custom piece set is a large share of the "million bucks" feel, and three visual directions can mean three
piece treatments, three FX palettes, three sound palettes.

*Mitigation:* one piece *geometry*, three *treatments* (fill, stroke, shadow, glow) driven by tokens. If a
theme needs different piece silhouettes, that is a scope decision made explicitly, not by drift.

### R11 — Colour accessibility
**Bites: Phase 1.** Severity: medium, and a real exclusion issue.
Red/blue/yellow/green is canonical for 4PC, and red/green is the most common colour vision deficiency.
Four armies must be distinguishable by more than hue.

*Mitigation:* shape or pattern differentiation on top of colour (corner glyph, piece-base marker), plus a
colourblind-safe alternate palette as a user setting. Ships with the theme system, not after it.

### R12 — App store and push notifications
**Bites: Phase 5.** Severity: medium–high depending on D3/D7.
iOS PWA push is limited and unreliable. If correspondence play is a core mode, push is load-bearing for
re-engagement, and a web-only strategy undercuts exactly the retention loop this product is built around.
Apple review can also be sceptical of thin web wrappers.

*Mitigation:* if correspondence ships, plan real native push. Decide D3 with this in mind.

---

## Backend and operations

### R13 — Betting on a beta runtime
**Bites: Phase 4.** Severity: medium, fully mitigable.
SpacetimeDB TypeScript modules are beta, and there is no advertised React Native client SDK.

*Mitigation:* spike before committing, specifically testing the RN client path. Keep the engine pure so
the module is a thin wrapper and the fallback (plain Node WS server) costs days, not months.

### R14 — Mixed client versions in one game
**Bites: Phase 5.** Severity: high once two app stores are in play.
Mobile users update on their own schedule; web users are always current. Two clients disagreeing about the
rules in the same game produces desyncs that are miserable to debug.

*Mitigation:* protocol version + ruleset hash checked on join; server refuses incompatible clients with a
clear "update required" message. Build this in Phase 4, before mobile exists.

### R15 — Leaderboards on row-level security will not scale
**Bites: Phase 6.** Severity: medium.
RLS is excellent per-user and poor for global aggregates. A live top-100 query over a large table with RLS
on will crawl.

*Mitigation:* separate read model — materialised views or periodic rollups plus a cache — designed
alongside the write schema, not bolted on.

### R16 — Bot CPU is a real cost line
**Bites: Phase 4.** Severity: medium.
If bots backfill matchmaking (R1) and substitute for quitters (R2), bot games may outnumber human games.
Server-side search on a 14×14 board with four movers is not cheap.

*Mitigation:* hard per-move time budgets; worker pool; measure cost per bot-game early and let it inform
how aggressively bots are used.

### R17 — Anti-cheat
**Bites: Phase 6.** Severity: medium.
Client-side bots can be tampered with. Engine assistance in 4PC is less studied than in chess but will
arrive the moment there is a ladder worth climbing.

*Mitigation:* server-side validation of every move (free if the server is authoritative); server-side bots
for rated play; move-time telemetry stored from day one so detection can be built later against real data.

---

## Data and format

### R18 — Notation and persistence format churn
**Bites: Phase 0, hurts in Phase 6.** Severity: medium.
FEN4/PGN4 is the substrate for saved games, analysis, sharing, replays, puzzles, achievements, and
retroactive rating recomputation. Changing it after games exist means migrating everything.

*Mitigation:* version the format from the first write. Store the ruleset id and engine version with every
game. Assume you will want to recompute something over the entire game history someday, and make that
possible now.

### R19 — Our house rule diverges from chess.com
**Bites: whenever import/interop is wanted.** Severity: low, known and accepted.
Queen-left-for-all differs from the real game at exactly four squares (`a7 a8 n7 n8` — Blue and Green swap
king and queen). Shared FEN4 strings and imported chess.com games will not match.

*Mitigation:* `CHESSCOM_START` is kept alongside `OUR_START`; an import shim is a small job. Ruleset id is
recorded per game so both can coexist if we ever want them to.

---

## Product

### R20 — Nobody knows how to play
**Bites: launch.** Severity: high and routinely underestimated.
4PC strategy does not transfer from chess. Pawn structure theory evaporates, bishops outrank knights,
and the social dynamics (ganging up on the leader, kingmaking) are invisible to a newcomer.

*Mitigation:* an interactive tutorial, not a rules page; bot games as the on-ramp; surface *why* a move
scored what it scored. This is content work and needs real time budgeted, not a week at the end.

### R21 — Kingmaking and leader-bashing feel unfair
**Bites: after launch, in reviews.** Severity: medium, inherent to the genre.
In FFA the leader gets ganged up on, and an eliminated-in-spirit player can decide who wins. Some players
find this the best part; some find it infuriating.

*Mitigation:* this is a design property, not a bug — but it should be *explained* in the tutorial, and
Teams mode should be visibly offered as the alternative for players who dislike it.
