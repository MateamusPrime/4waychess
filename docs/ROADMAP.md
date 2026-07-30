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

### 1b — Renderer and app ▸ *mostly complete*

- [x] `packages/pieces`: custom piece family as pure SVG path data — one geometry, themed by
      treatment, so three themes do not triple the art budget. Validated by a path parser in tests.
- [x] `packages/board-render`: command interpreter over a `Surface` port. Canvas2D adapter ships
      first; CanvasKit and react-native-skia implement the same port (it is shaped around what
      those APIs share: path strings, save/restore, 2D transforms). Tests run on a recording
      mock — no canvas in CI. Path2D objects are cached (6 objects across any number of frames).
- [x] `apps/web`: playable hotseat app, both modes, bundled with esbuild (~80 KB incl. engine).
      Verified end to end in a live browser: tap g2→g4 plays, board rotates to Blue, Blue's taps
      hit-test correctly in the rotated frame, move list records, themes switch live
      (Atelier centre pixel sampled at exactly #a97a4e).
- [x] Settings UI wired to the persisted store: theme, colour-blind mode + markers, coordinates,
      rotate-on-handoff, sound, reduced motion (also honours `prefers-reduced-motion`).
- [x] Sound design, fully synthesized with WebAudio — zero asset files. Piece weight (pitch-dropping
      thump + filtered noise), capture, check, promotion, elimination, rotation, game over.
- [x] Promotion picker overlay; keyboard play (arrows / Enter / Escape); aria-live announcements.
- [x] Zoom and pan: wheel + pinch, double-tap toggles fit ↔ comfortable-touch zoom, pan only when
      zoomed so tap stays unambiguous. (R7)
- [ ] Piece silhouettes need a visual polish pass once seen on a real screen (knight especially).
- [ ] Pinch/pan validated **on a real phone**, in this phase and not Phase 5. (R7)
- [ ] Sound levels balanced by ear on real speakers.
- [ ] Next.js shell arrives with Phase 3 (lobby/auth); the board is a canvas component either way.

**Verified live:** frame self-heals a 0×0 canvas at boot (hidden tabs report no rect and never
fire rAF — the first paint is now synchronous), full move pipeline, seat rotation, theme switching.

**Gate:** a stranger can be handed a phone and a laptop, plays a full hotseat game on each without
instruction, and wants to play again. If that is not true, do not proceed.

---

## Phase 2 — Bots  ▸ *core complete, gate pending play-testing*

**Goal:** a solo player always has a good game.

- [x] `packages/bots` — engine-only dependency, no clock, no Math.random: budgets are node
      counts and randomness is seeded, so every bot decision is reproducible (tests today,
      server-side move verification later).
- [x] 4PC evaluation: our piece values, banked FFA points as a first-class term, king danger
      from three directions, centralisation, pawn advancement, promoted-queen = 1. Weights are
      **per army**, which is how four personalities sit at one table.
- [x] Shallow max-n with MVV move ordering, branch caps and node budgets.
- [x] **Race-aware utility** — each node maximises own score minus the enemies' mean.
- [x] **Capture points credited during search** (Position deliberately doesn't bank points;
      the search must, or bots shrug at free queens — found live, see below).
- [x] Personalities: Reaper (aggressive) / Bastion (turtle) / Magpie (opportunist) /
      Leveller (kingmaker), distinct weight profiles, softmax variance **windowed to 2.5
      points** so temperature varies play but can never blunder a hanging queen.
- [x] Difficulty tiers: easy d1 / medium d2 / hard d3. Teams-aware via the engine's
      `areEnemies` plus partner-score folding.
- [x] App wiring: per-seat Human/personality picker, difficulty select, bot think-delay, board
      rotation only for **human** hand-offs, default table = you vs Reaper/Magpie/Bastion.
- [x] Measured: ~8ms per medium move in-browser; four-bot 80-ply stress run clean, close score
      race (25/24/22/26). (R16)
- [ ] **Gate:** fun to lose to, no broken-looking blunders — needs human play-testing.

### Phase 2.5 — search engineering ("Lever 1")

- [x] FEN4 carries en passant rights, so wire-transferred positions lose no legal moves.
- [x] `deep.ts`: iterative deepening, transposition table, capture rollout at the horizon
      (true turn order with passes — resolves the three-plies-away recapture exactly), and a
      **rational-reply layer** standing in for all three opponents' turns.
- [x] Arena harness (`arena-cli.ts`) — candidate vs incumbent at EQUAL node budgets, seats
      rotated. Doubles as the skeleton of the Lever-2 self-play tuner.
- [x] Bot search moved off the UI thread into a Web Worker; replies re-validated on the main
      thread against its own legal moves (the worker is compute, never authority).
- [x] Easy stays on the classic engine (the on-ramp opponent); medium and hard use deep.

### What Lever 1 taught us — every variant measured, every variant rejected

Final arena results, 48 games each, candidate in one rotating seat vs three incumbents,
equal 2,500-node budgets (seat-neutral win baseline 25%):

| Variant | Wins | Points ratio | Why it lost |
|---|---|---|---|
| Paranoid BRS | 10.4% | 0.69x | Models 3 opponents colluding against you; paranoia is passivity, and passivity loses a points race |
| Rational-reply BRS | 29.2% | 0.98x | Truer opponent model, but ANY reply compression hands the root two moves per round — tempo distortion caps it at parity |
| Classic + capture rollout | 2.1% | 0.50x | Every node spent settling a leaf is a node not spent growing the tree; breadth dominates leaf accuracy by 2x |

The converged law for this game at these budgets: **spend the entire budget on breadth of the
true turn-order max-n model.** The static hanging-piece term already carries exchange risk.
Difficulty tiers ship on the exact classic configs that were play-tested; `deep.ts` and
`rollout.ts` remain in-tree as documented, tested, arena-refuted baselines.

What genuinely shipped from Lever 1: the **arena harness** (it prevented three bad ships and
is the skeleton of the Lever-2 self-play tuner), the **Web Worker** (bots think off the UI
thread — engine-agnostic, and it means budgets can now scale with hardware rather than
UI-thread politeness), **FEN4 en passant rights** (wire-transferred positions lose no legal
moves), and the meta-lesson now pinned to the wall: **two-player search wisdom does not
transfer to four-player FFA. Measure, never assume.**

Smaller findings: replyCap is the BRS affordability lever (depth-2 at the opening: ~750k
nodes at cap 24, ~10k at cap 5); a saturated-budget A/B proves nothing (both runs stop at the
cap — comparisons must complete); block-buffered background runs must not share a log file.

### Lever 2 — self-play weight tuning

- [x] `tune-cli.ts`: SPSA over the eval weights, with `points` pinned at 1.0 as the unit of
      account (the eval is scale-invariant for move selection, so tuning every weight together
      would let the vector random-walk in magnitude while learning nothing).
- [x] `--null` calibration: plays IDENTICAL weights against themselves to measure the
      harness's own bias and noise before any result is trusted.
- [x] The arena now reports a standard error and a t statistic, and refuses to call a result
      either way when |t| ≤ 2.

**The finding that governs all future bot work: this game is extremely noisy.** Null
calibration over 80 games shows no significant harness bias (|mean|/SEM = 0.87, seat-pair bias
1.0 points) but a per-game standard deviation of **38.6 points**. Detecting a 5-point
improvement needs ~240 games; a 2-point improvement needs ~1,500.

Two implementation bugs worth remembering:
- Textbook SPSA gains drove `kingSafety` from 0.35 to 9.56 in two iterations, because the
  objective is in points (tens) while the weights are order 0.1–1. Fixed with objective
  normalisation plus a hard per-iteration step cap.
- An early 6-game null sample suggested a large structural bias (+22) and a Red+Yellow seat
  advantage. Both evaporated at 80 games. **Small samples in this game produce confident
  nonsense**, which is precisely why the calibration mode now exists.

Remaining strength levers: larger worker budgets (the worker means bot thinking no longer
competes with the UI thread), and eventually Lever 3 (learned eval over the game corpus that
Phase 3 persistence is now accumulating).

### What building it taught us

- **The search couldn't see points.** `Position.makeMove` doesn't bank capture points — that is
  the Game layer's job — so the search evaluated a queen capture at +0.5 over a king shuffle.
  In FFA, points ARE the game; the search now credits `captureValue` on make and removes it on
  unmake. The general rule: any consumer that explores moves without the Game layer must model
  the scoring consequences itself.
- **Max-n over absolute own-score misses half the game.** Capturing lowers the VICTIM's score,
  not yours. Utility is now relative: own score minus the enemies' mean.
- **Recaptures live three plies away.** After you take a defended piece, two other players move
  before the owner recaptures. Depth 2 is structurally greedy against the army that moves
  before you; depth 3 is the first depth that plays sound exchanges. A two-player instinct
  that is simply false here.
- **Raw xorshift32 betrays small seeds** (seed 1 → first output ≈ 6e-5): every bot opened
  identically. Seeds are now hash-mixed and the generator warmed up.
- **Temperature needs a floor.** Softmax over raw scores gave a 9-point-worse move ~2% of the
  mass at easy tier — a missed free queen that reads as a bug, not as an easy opponent. Bounded
  by a 2.5-point candidate window.
- **Search depth cannot protect against the player three seats away — the eval must.** First
  human play-test (thank you): Magpie's queen captured a knight on a square guarded by a PAWN,
  and lost queen-for-knight next round. At depth 2 a bot sees only the next mover's reply;
  covering all three opponents needs depth 4, which no budget affords. Fix: `attackMap` in the
  engine (differentially tested against both attack detectors) plus a static hanging-piece
  term in the eval — an undefended piece on an attacked square is scored as ~45% lost at any
  depth. Timing unchanged (7.8ms/move) because the map-based term is O(pieces) per leaf.
- **Fixtures keep hanging kings.** Twice in one test, a hand-placed queen had a clean 14-square
  line to a king the author forgot — and the bot "failed" the test by correctly grabbing +20.
  On this board, always trace a placed slider's eight lines against all four kings.

---

## Phase 3 — Accounts and persistence  ▸ *local half complete*

**Goal:** identity, saved games, and the substrate for everything in Phase 6.

- [x] `packages/store` — persistence **ports** (profiles, settings sync, game history) plus the
      local adapter. The app depends only on the ports, so the cloud backend decision stays
      reversible until the adapter is written.
- [x] **Guest play before signup**: a guest identity is created on boot with a readable name
      (never `User4711`), renameable, and persisted. When accounts land, the cloud adapter
      implements the same bundle and the account **claims** the guest id rather than replacing
      it — so pre-signup history survives signup. Designed now because it is free now and a
      data-loss incident later.
- [x] Game history: every finished game stored as replayable PGN4 under a queryable envelope
      (mode, seats with human/bot identity, points, winners, end reason, timestamps), with
      eviction, orphan tolerance, and a "Recent games" panel.
- [x] Human **resignation** — found missing while testing the save path: without it a losing
      player could only close the tab, and an unfinished game is never saved.
- [x] Hostile-storage handling: private browsing, exhausted quota and disabled storage all
      degrade to a session-only profile rather than an exception.
- [ ] Auth provider (**D4**) and the cloud adapter (**D5**).
- [x] **Rating model designed and implemented** — `packages/rating`, documented in
      `docs/RATING.md`. Weng-Lin Bayesian approximation (closed form, no dependencies),
      chosen over Elo because Elo is pairwise and over TrueSkill because closed form is
      auditable and trivially deterministic. Ships in Phase 6; built now because the model
      must be fixed before live data exists to invalidate. (R3)
- [x] Anti-farming rules, each with a named test: all-human games only, rank by points not
      survival, margin ignored, abandonment ranks last while resignation does not, and a
      conservative μ − 3σ leaderboard that a lucky newcomer cannot leap.
- [x] Retroactive recomputation proven end to end — `recomputeLadder()` rebuilds the whole
      ladder from stored records, order-independently and byte-identically.
- [ ] Cross-device resume: live state server-side, keyed by account.

**Gate:** a player signs up, plays on two devices, and their history and settings follow them.

### What building it taught us

- **A stored game is only worth storing if it replays.** The integration test does not check
  that a record round-trips as JSON — it replays the movetext through the engine and demands
  the identical final position, points and army statuses. Everything Phase 6 promises is
  replay over history, so that is the property with real value.
- **ui-core and store share one settings key and payload format on purpose** — the synchronous
  path exists because the first paint needs settings before any promise resolves, and the
  async port exists for the cloud adapter. They agree so the adapter can upload settings the
  app already wrote, with no migration. That agreement is invisible in both codebases, so a
  cross-package contract test pins it.
- Verified live end to end: a 72-round game saved with status
  `resigned,checkmated,active,resigned` (human resigned, one bot mated, one bot conceded,
  Yellow won on 69 points), player tags `Mateamus` and `bot:aggressive:medium`, all surviving
  a page reload.

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
