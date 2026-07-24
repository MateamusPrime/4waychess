# 4-Way Chess — Roadmap

Each phase has a **gate**: what must be true before starting the next one. Gates exist so that a phase
cannot be "mostly done" forever. Risk references point at `RISKS.md`.

---

## Phase 0 — Spec and engine  ▸ **COMPLETE**

**Goal:** a rules engine that is provably correct and knows nothing about screens or networks.

- [x] `RULES.md` — every constant pinned, every edge case decided in writing *before* code. (R5)
- [x] Monorepo scaffold, npm workspaces, Node 24 native type stripping (**zero dependencies,
      including dev dependencies** — the engine builds and tests with nothing but Node).
- [x] Board geometry: 160 squares, corner cutouts treated as true interior edges.
- [x] **Army-local frame** — the transform that reduces all four armies to standard chess. (§3)
- [x] FEN4 read + write, versioned, with both `OUR_START` and `CHESSCOM_START`. (R18)
- [x] Move generation: all pieces, per-army pawn direction, double step, promotion in both modes,
      **multi-right en passant**, castling.
- [x] Four-way legality — illegal if the mover's king is left attacked by *any* opponent.
- [x] Check / checkmate / stalemate, evaluated on the affected player's own turn. (§8)
- [x] Dead armies: block, never check, remain capturable, skipped in turn order. (§9)
- [x] Teams mode as configuration — no friendly fire, no partner check, rank-11 promotion. (R6)
- [x] Independent naive generator + differential harness. (R4)
- [x] Frozen perft baselines — opening **and** a tactical position.
- [x] Architecture purity enforced in CI rather than by convention.
- [x] PGN4 read + write, versioned, recording ruleset and engine version per game. (§15)
- [x] Scoring: FFA point table, check bonuses, checkmate and stalemate awards. (§10)
- [x] Repetition and fifty-round detection. (§13)
- [x] Game-end conditions, elimination transitions, Teams piece inheritance. (§11, §12)
- [x] `Game` layer separating "playing a game" from "exploring a tree".

**Gate:** differential test runs clean over millions of positions; every rule in `RULES.md` has a named
test; engine has zero dependencies and zero imports from `apps/*`.

**Gate status: PASSED.** 127 tests passing. Purity check green. Engine has zero dependencies.

Deep differential sweep **PASSED**: 3,000,000 positions across 4,109 games and 748,600 plies, covering
both modes and random eliminations — **0 mismatches** between the fast and naive generators
(548s, 5,472 positions/sec, seed `3735928559`). Reproduce with:

```
node packages/engine/src/tools/differential-cli.ts 3000000 3735928559
```

Every rule in `RULES.md` has a named test that cites its section.

### What building it actually taught us

- **The army-local frame is stronger than the spec claimed.** All four back lines reduce to
  `RNBQKBNR` and all four kings to own(5,1), so castling and promotion are *literally* standard chess.
  This should propagate outward: bots, renderer and notation should all work in the local frame rather
  than re-deriving four rotations. Promoted from a rules footnote to a core abstraction.
- **Pawns leave the eight-file home corridor.** Capturing diagonally carries a pawn into the side arms,
  where its ownFile legitimately goes to 0 and below. Any code assuming ownFile ∈ 1..8 is wrong — this
  bug was found in our own naive generator. Now documented in RULES.md §6.
- **Opening perft is a weak regression target.** The armies cannot reach each other in the first round,
  so perft to depth 4 yields *zero* captures, en passant, castles or promotions. A tactical position is
  now frozen alongside it (11,646 captures and 32 en passant at depth 3).
- **Cross-army pins exist from move one.** Red's `f2-f3` unveils the diagonal `g1-f2-e3-d4-c5-b6-a7`,
  pinning Blue's `b6` pawn against the Blue king — between two armies that never face each other. This
  is the most alien concept in the game and belongs near the front of the tutorial. (R20)
- **The purity check earned its keep immediately**, catching a `Buffer.from()` in the engine that would
  have worked in tests and on a server, then failed in the browser and React Native.
- **Standing checks made the multi-check bonus farmable.** Because two opponents move between your check
  and the victim's reply, a check you delivered earlier is still standing on your next turn. Counting it
  would have let a player park one permanent check and collect the two-player bonus forever. Bonuses now
  count only checks a move *delivers*. Written up as RULES.md §10.1 — and it is a warning about the whole
  scoring surface: **anything that pays out per-turn rather than per-event is farmable in a four-player
  game**, and the FFA points race is the win condition, so this is a leaderboard-integrity issue, not a
  cosmetic one. Every future scoring rule needs checking against it. (R3)
- **Long lines make hand-built test positions treacherous.** Diagonals run up to 14 squares, so pieces
  placed "well away" from a king routinely check it by accident. Several test positions had to be
  rebuilt. Constructed positions should be asserted clean (`armiesCheckedBy(...) === []`) before use.

---

## Phase 1 — The board that feels like a million bucks  ▸ *in progress*

**Goal:** hotseat play that people want to touch. This is the phase the whole product is judged on.

### 1a — View model (`packages/ui-core`) ▸ **COMPLETE**, 165 tests

The seam that makes this phase testable: ui-core emits a pure **draw-command list**, and the renderer
only walks it. Appearance is therefore unit-testable with no canvas, no browser and no snapshots — and
the renderer stays dumb enough to port between CanvasKit and react-native-skia essentially unchanged,
which is what makes "one board on web and mobile" real rather than aspirational.

- [x] All three themes as pure tokens, validated against the visual mockup.
- [x] Persisted theme preference through an injected store port; Midnight default; corrupt or
      partial stored settings degrade to defaults instead of breaking the app.
- [x] Seat orientation for all four seats, with the inverse transform for hit-testing.
- [x] Animated 90° seat spin that always takes the short way round — and the scene, not the host,
      owns the outgoing/incoming projection switch so a hand-off cannot flash the wrong orientation.
- [x] Tap-to-select → tap-to-move reducers, including the promotion picker and view-only mode.
- [x] Pixel layout, camera with zoom and clamped pan, and gap-tolerant hit-testing.
- [x] Colour-blind-safe palette **plus** per-army marker glyphs, so armies never depend on hue alone.
- [x] Animation as a pure function of time — deterministic, no timers, no clock.
- [x] Accessibility: keyboard cursor that steps over cut corners, and spoken descriptions for
      squares, moves, turns, scores and army status.

### 1b — Renderer and app ▸ *next*

- [ ] `packages/board-render`: Skia command interpreter (CanvasKit on web, react-native-skia on mobile).
- [ ] Custom SVG piece family — a large share of the "million bucks" feel. (R10)
- [ ] `apps/web`: Next.js shell, settings UI, player panels, move list.
- [ ] Local hotseat wired end to end, both modes.
- [ ] Sound design: piece weight, capture, check, promotion, elimination.
- [ ] Pinch/pan validated **on a real phone**, in this phase and not Phase 5. (R7)
- [ ] Mobile layout designed first, not retrofitted. (R8)

**Gate:** a stranger can be handed a phone and a laptop, plays a full hotseat game on each without
instruction, and wants to play again. If that is not true, do not proceed.

---

## Phase 2 — Bots

**Goal:** a solo player always has a good game.

- Heuristic eval + shallow max-n; 4PC-specific evaluation (bishops > knights, centre control, king safety
  against three attackers, score-margin awareness).
- Personalities: aggressive / turtle / opportunist / kingmaker. Difficulty tiers.
- Teams-aware evaluation. (R6)
- Per-move time budgets measured now, because they become a cost line later. (R16)

**Gate:** bots are *fun* to lose to and do not blunder in ways that read as broken. Measured by play, not
by strength metrics.

---

## Phase 3 — Accounts and persistence

**Goal:** identity, saved games, and the substrate for everything in Phase 6.

- Auth (per **D4**), including **guest play before signup** — never gate the first game behind a form.
- Profiles, settings sync (themes move server-side here), game history.
- Game storage with ruleset id + engine version per game. (R18)
- **Design the rating model now even though it ships in Phase 6**, and store enough per-game detail to
  recompute ratings retroactively. (R3)
- Cross-device resume requires live state server-side and keyed by account.

**Gate:** a player signs up, plays on two devices, and their history and settings follow them.

---

## Phase 4 — Online play

**Goal:** other humans. Order depends on **D7**.

**If correspondence first** (recommended path): HTTP endpoints, no realtime host, notifications drive
re-engagement. Sidesteps the stateful-server problem, clock drift, and — critically — four-simultaneous-
humans matchmaking. (R1, R9)

**If realtime first:** stateful host per **D1**, rooms, server-authoritative clocks, reconnection,
presence, spectating.

Both paths need:
- Protocol version + ruleset hash checked on join; incompatible clients refused clearly. (R14)
- Matchmaking with **bot backfill after a short timeout** — bots are infrastructure here. (R1)
- Abandonment handling with bot substitution and rating protection. (R2)
- Server-side move validation on every move. (R17)

**Gate:** a four-player game completes end-to-end with one deliberate disconnect and one deliberate
abandonment, and the remaining players report it felt fair.

---

## Phase 5 — Mobile app

**Goal:** store presence, real push, and a web↔mobile game that is genuinely the same game.

- Per **D3**. Board renderer shared; chrome native and idiomatic.
- Real push notifications — load-bearing if correspondence is a core mode. (R12)
- Version-skew handling proven with a deliberately stale client. (R14)

**Gate:** a web player and a mobile player finish a game together, and one of them switches devices
mid-game without losing anything.

---

## Phase 6 — Retention systems

**Goal:** reasons to come back tomorrow.

- Rating system per **D8**, using the model designed in Phase 3. (R3)
- Leaderboards on a separate read model, never live RLS aggregates. (R15)
- Achievements, daily and weekly challenges, 4PC puzzles generated from stored games.
- Anti-cheat built against the move-time telemetry collected since Phase 4. (R17)

**Gate:** measured day-7 return rate, not shipped feature count.

---

## Cross-cutting, from day one

- **Tutorial and onboarding.** 4PC strategy does not transfer from chess and this is routinely
  underestimated. Budget real time, do not leave it to the end. (R20)
- **Telemetry.** Move times, abandonment points, queue times, session length. You cannot fix R1, R2, or
  R17 without data you started collecting before you needed it.
- **The engine stays pure.** Every phase that adds an import to `packages/engine` makes every later
  decision more expensive.

---

## Suggested near-term order

1. Resolve **D2** and **D3** (renderer + mobile strategy — they are coupled and they gate Phase 1).
2. Resolve **D7** (correspondence vs realtime first — it reorders Phase 4 and changes D1's urgency).
3. Write `RULES.md`.
4. Build the engine test-first.
5. Spike SpacetimeDB **with a React Native client** in parallel, cheaply, while the engine is being built.
   That spike answers D1 with evidence instead of speculation, and costs nothing if the engine stays pure.
