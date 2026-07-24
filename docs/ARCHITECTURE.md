# 4-Way Chess — Architecture

Status: living document. Decisions marked **OPEN** are not yet made.

---

## 1. The one rule everything else hangs off

> **The rules engine is a pure, dependency-free TypeScript package with no I/O, no framework, and no
> knowledge of how it is transported or drawn.**

Everything downstream — web client, mobile client, bots, the authoritative server, the analysis board,
puzzle generation, replay — is a consumer of that one package. This is what keeps every other decision
in this document reversible. If we get this wrong, nothing else can be changed cheaply.

Package layout (monorepo):

```
packages/
  engine/        pure TS. board, moves, legality, scoring, FEN4/PGN4. zero deps.
  bots/          consumes engine. personalities + search. zero deps.
  protocol/      wire types + versioning. shared by client and server.
  ui-core/       framework-free view-model: what to draw, not how.
apps/
  web/           Next.js shell + board renderer
  mobile/        (Phase 5)
  server/        (Phase 4) authoritative game host
```

**Test rule:** `engine` must never import from `apps/*`. Enforced in CI, not by convention.

---

## 2. Cross-play between web and mobile

**Verdict: yes, and it is the default outcome of a server-authoritative design — not an extra feature.**

A web player and a mobile player can sit in the same game because the server does not know or care what is
rendering. Three things make it true, and all three are cheap if done from the start and expensive later:

1. **The server is the sole authority.** Clients send *intent* ("move g2→g4"); the server validates against
   the same engine build and broadcasts *resulting state*. Clients never assert outcomes.
2. **One versioned protocol.** Every message carries a protocol version and an engine ruleset version.
   Mixed-version clients in one game is the single most likely source of desync bugs, so the server refuses
   incompatible clients rather than trying to be clever.
3. **One engine package, one ruleset hash.** Both clients and the server import the same `engine` build.
   A ruleset hash is computed at build time and checked on join. If a mobile release ships with different
   rules than the web release, the server rejects it loudly instead of producing two different games.

**Feature parity requirement:** game-affecting features (premoves, takeback offers, draw offers, timers)
must be identical across platforms or the game is not the same game. Cosmetic features (themes, animation
richness, haptics) may differ freely.

**Cross-device continuity** (start on web, resume on phone) requires that live game state live on the
server, keyed by account — not in the client. That is Phase 3 (accounts) gating Phase 4/5, and it is the
reason guest-only play cannot support device switching.

---

## 3. Renderer — a correction to an earlier recommendation

Earlier I recommended **SVG + CSS** for the board. That was correct advice for a web-only product and is
**wrong now that mobile is in scope with shared experience as a goal.** SVG/DOM does not port to React
Native, and rebuilding three themes plus every animation twice is exactly where a polish budget dies.

The split that works:

| Layer | Strategy |
|---|---|
| **Board** (squares, pieces, moves, FX) | **One renderer, shared across platforms.** |
| **Chrome** (menus, panels, dialogs, settings) | Per-platform and idiomatic. Cheap to duplicate. |

The board is the hard part and must be written once. The chrome is the easy part and should feel native
on each platform.

**Decided (D2/D3): one Skia board renderer, Expo/React Native for mobile.** Skia runs natively on mobile
via `@shopify/react-native-skia` and on the web via CanvasKit, so the board is drawn by a single codebase
and is pixel-identical on both. See §7 for the consequences we take on by choosing it — chiefly that
accessibility and hit-testing become ours to build rather than inherit from the DOM.

---

## 4. Backend options

### 4.1 The constraint that drives everything

Next.js on serverless **cannot host the game.** Serverless functions are request-scoped and stateless: they
cannot hold a WebSocket, run a turn clock, or own room state. Next.js is the shell — auth, lobby, profiles,
leaderboards, challenge pages. The live game needs a stateful host. This is not a Next.js flaw; it is a
category difference, and it is the thing teams discover far too late.

### 4.2 Option A — SpacetimeDB

*Researched July 2026. Verify before committing; this product moves fast.*

The database **is** the server. You upload a module containing your tables and `reducers` (atomic
server-side transactions); clients connect directly over WebSocket and subscribe to SQL queries. When rows
change, updates are pushed to subscribers automatically.

**What it genuinely solves for us:**

- **Stateful host** — removes the "Next.js can't hold a socket" problem entirely.
- **Authoritative validation** — reducers *are* validated mutations. This is the thing Supabase Realtime
  cannot do (it broadcasts; it does not adjudicate).
- **Server-authoritative clocks** — scheduled reducers / schedule tables run reducers at a time or on an
  interval. Turn timers and timeout-forfeits become first-class instead of bolted on.
- **Reconnection and cross-device resume** — a client that drops just re-subscribes and receives current
  state. This is *extremely* well-matched to mobile, where the OS suspends your app constantly, and to the
  start-on-web-finish-on-phone requirement.
- **Spectators** — a subscription query. Effectively free.
- **TypeScript modules exist** (added v1.6, and one of four supported module languages alongside Rust, C#,
  C++). That is what makes it interesting *for us specifically*: our shared TS engine could run inside the
  database as the authority, preserving the one-engine rule.

**Real risks:**

- **TypeScript modules are beta.** Betting the authoritative server on a beta runtime is a genuine risk.
- **No advertised React Native client SDK.** The TS SDK targets web frameworks. RN may work — it is
  WebSocket plus a binary encoding — but it is not a supported target. **This needs a spike before mobile
  commits**, and it is the single most likely thing to break the cross-play plan.
- **Young ecosystem, single vendor.** Fewer developers know it; less prior art for our problem shape.
- **BSL 1.1** converting to AGPLv3 after several years, with a linking exception so our code stays closed.
  Acceptable, but read it before signing up.
- **Not an analytics store.** Explicitly optimised for low-latency OLTP, not OLAP. Leaderboard aggregates
  and product analytics likely still want Postgres → see Decision D5.
- **Scale ceiling per instance** is stated around 1,000+ concurrent clients, with multi-module distribution
  on the roadmap. Fine for a long time; not free forever.

**Honest assessment:** for the *realtime layer specifically*, this is probably the best-fitting product
available for this game, and it collapses three of the six limitations I listed into one dependency. The
beta status and the RN gap mean it should be **spiked, not adopted**, and the spike costs nothing if the
engine stays pure.

### 4.3 Option B — dedicated Node WebSocket server + Postgres

Boring, proven, hireable. A long-lived Node process on Fly.io/Railway/Render holds rooms and clocks;
Postgres (Supabase or plain) holds accounts, games, ratings, achievements. Every problem has a
Stack Overflow answer.

Costs: you build reconnection, state sync, presence, subscription fan-out, and scheduled timers yourself —
all of which SpacetimeDB gives you. That is real work, and it is the *unglamorous* kind that eats months.

### 4.4 Option C — correspondence first, realtime later

**The overlooked option, and possibly the best first move.** Async 4PC — hours or days per move — needs
**no realtime server at all**: plain HTTP endpoints, a database, and push notifications.

Why it deserves serious consideration:

- It eliminates the entire stateful-host problem for the first online release.
- It sidesteps the clock-drift and background-suspension problems completely.
- **It solves the 4-player matchmaking problem**, which is the biggest existential product risk here:
  finding four *simultaneous* live humans is brutally hard at low population; finding four humans willing to
  move within a day is easy.
- It is naturally cross-device — the state is already server-side by construction.
- It is the mode most native to mobile (notification → one move → close app).

Costs: it is a different *feel* from live play, and it makes push notifications load-bearing — which is
precisely where a web-only PWA on iOS is weakest.

---

## 5. Data split — OPEN (D5)

Live game state and product data have different shapes. Either one datastore holds both (simpler, fewer
moving parts) or the realtime store holds live games while Postgres holds accounts, finished games,
ratings, achievements, and analytics (better tools, but a sync boundary — and sync boundaries are where
bugs live). No decision yet.

---

## 6. Bots

Confirmed direction: **heuristic evaluation plus shallow max-n search, differentiated by personality**
(aggressive / turtle / opportunist / kingmaker), not raw strength. A 14×14 board with four movers has a
branching factor that makes deep classical search impractical, and in a points-based FFA game a
*characterful* opponent is more fun than a strong one.

Bots are also **infrastructure, not just content**: they are the backfill that makes matchmaking viable and
the substitute that rescues a game when a player quits. Execution location is **OPEN (D6)** — client-side is
free but cheatable and inconsistent; server-side is fair but costs CPU per game.

---

## 7. Decision register

| ID | Decision | Status |
|---|---|---|
| D1 | Realtime backend | **SPIKE** — timeboxed SpacetimeDB spike in parallel with Phase 0, explicitly testing the React Native client path. Decide with evidence at Phase 4. |
| D2 | Board renderer | **DECIDED** — one Skia renderer, shared. Native on mobile, CanvasKit on web. |
| D3 | Mobile strategy | **DECIDED** — Expo / React Native. Board shared via Skia; chrome native per platform. |
| D4 | Auth provider, and guest play before signup | **OPEN** — Phase 3. Guest play itself is decided: yes. |
| D5 | One datastore or two | **OPEN** — Phase 3/4 |
| D6 | Bot execution: client or server | **OPEN** — moot until Phase 4 |
| D7 | First online mode | **DECIDED** — correspondence first. Realtime follows. |
| D8 | Rating system for 4-player FFA | **OPEN** — model chosen in Phase 3, ships Phase 6. See RISKS.md R3. |
| D9 | Ruleset: chess.com-compatible + house queen-left rule | **DECIDED** |
| D10 | Modes: FFA and Teams both from v1 | **DECIDED** |
| D11 | Themes: all three, user-selectable, Midnight default | **DECIDED** |
| D12 | Orientation: viewing player always at bottom; hotseat rotates to next human | **DECIDED** |
| D13 | Team: solo (you + me), no hard deadline | **DECIDED** — scope for sustainable increments; stage art rather than batch it |
| D14 | Web host | **DECIDED** — Cloudflare Pages, **not Vercel**. Vercel's free plan forbids commercial use and is enforced; this project is commercial by design. See COSTS.md. |
| D15 | Mobile store order | **DECIDED** — Android first. Removes the macOS build dependency (you are on Windows) and Apple's $99/yr from the first mobile release. iOS follows once the app has proven itself. |

### Consequences of D2 + D3

- `packages/board-render` is a **Skia drawing layer that imports nothing platform-specific.** It receives a
  view-model from `ui-core` and draws. Web mounts it via CanvasKit; mobile via `@shopify/react-native-skia`.
- **Accessibility must be built, not inherited.** A canvas has no DOM, so keyboard navigation, screen-reader
  announcements, and focus order are our responsibility. Budget this in Phase 1 — retrofitting it is far worse.
- **CanvasKit is a multi-MB WASM payload on web.** Lazy-load it behind the lobby so first paint is not held
  hostage to it.
- Hit-testing, drag, pinch and pan are ours to own end to end (see RISKS.md R7).
- Upside: the board is written **once**, and all three themes, every animation and every effect are
  automatically identical on web and mobile. This is what makes "the same experience across devices" real
  rather than aspirational.

### Consequences of D7

Phase 4 becomes materially smaller: HTTP endpoints, a database, and push notifications — **no stateful
host, no clock authority, no reconnection protocol.** The SpacetimeDB decision (D1) therefore does not
gate the first online release at all, which is why spiking rather than committing costs us nothing.
