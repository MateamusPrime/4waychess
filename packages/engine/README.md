# @4wc/engine

Pure four-way chess rules engine. **Zero dependencies — including dev dependencies.**

Tests run on Node 24's native TypeScript type stripping and built-in test runner, so there is no
build step, no bundler and nothing to install.

```bash
npm test            # 83 tests
npm run perft       # frozen perft baselines
node src/tools/differential-cli.ts 1000000    # deep correctness sweep
```

## What this package is

Everything downstream — web client, mobile client, bots, the authoritative server, analysis,
replay — is a consumer of this one package. That is what keeps every other architectural decision
reversible, so the purity rules below are enforced by `test/architecture.test.ts` rather than by
convention:

- no external imports, only relative paths and `node:` builtins
- no I/O, no network, no `console`, no browser globals, no `Buffer`
- no `Math.random`, no `Date.now` — the engine is deterministic
- no imports from `apps/*`
- erasable syntax only (no enums, namespaces or parameter properties)
- `naive.ts` may not import `movegen.ts`, `attacks.ts` or `perft.ts`

## The army-local frame

The single idea that makes four-way chess tractable. Each army gets a local frame where `ownFile`
runs 1–8 from its own left and `ownRank` runs 1–14 forward from its own back line:

| Army | ownFile | ownRank |
|---|---|---|
| red | `x − 2` | `y + 1` |
| blue | `11 − y` | `x + 1` |
| yellow | `11 − x` | `14 − y` |
| green | `y − 2` | `14 − x` |

In that frame **all four armies are identical**: every back line reads `RNBQKBNR`, every king starts
on own(5,1), and castling and promotion are ordinary chess rules. Transform once, then write
conventional logic — rather than special-casing four directions through every rule, which is where
four-way engines usually go wrong.

One caveat worth knowing: pawns capture diagonally into the side arms, so **`ownFile` is not bounded
to 1–8**. It legitimately reaches 0 and below. Code that assumes otherwise is wrong.

## How correctness is established

Standard chess engines validate move generation against published `perft` counts. **No such
reference data exists for four-way chess**, and our queen-left house rule diverges from chess.com
anyway. So correctness rests on three legs:

1. **Differential testing.** `naive.ts` implements the rules a second time, sharing no logic with
   `movegen.ts` — brute-forcing every ordered square pair and re-deriving paths from scratch, where
   the fast path uses reverse attack detection and precomputed tables. The two must agree over
   millions of positions reached by random play, across both modes, with random eliminations.
2. **Frozen perft baselines.** Not externally verified, but any change that moves them is caught
   immediately. Note the opening is a *weak* target — the armies cannot reach each other in the
   first round, so perft to depth 4 has zero captures. A tactical position is frozen alongside it.
3. **Named rule tests.** Every rule in `docs/RULES.md` has a test that cites its section.

## Layout

| File | Contents |
|---|---|
| `types.ts` | Value types. No logic. |
| `geometry.ts` | Board, cutouts, direction vectors, the army-local frame. |
| `position.ts` | Packed board, make/unmake, castling rights, en passant, turn order. |
| `fen4.ts` | Versioned position serialisation. `OUR_START` and `CHESSCOM_START`. |
| `attacks.ts` | Reverse attack detection, check and multi-check. |
| `movegen.ts` | Pseudo-legal generation, legality filter, turn outcome. |
| `naive.ts` | Independent reference implementation. Test-only in spirit. |
| `perft.ts` | Node counting, breakdowns, divide. |
