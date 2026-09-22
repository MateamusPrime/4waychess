# @4wc/advisor

A training advisor for **standard chess**, built on Stockfish. Not part of the four-way game:
it is ordinary 8×8 chess, and it lives in this monorepo because the tooling (Node 24, native
type stripping, `node --test`) is already here.

Stockfish is stronger than any human and has been for twenty years. What it is not is a
teacher: raw UCI output is a wall of `info depth 22 multipv 2 score cp -35 ...` lines. This
package turns that into something a player can learn from.

## What it does

- **MultiPV candidates.** For any position, the top N moves with evaluation, win probability,
  and the principal variation in SAN.
- **Move grading.** Every move you play is graded `best / good / inaccuracy / mistake /
  blunder` by the win-probability it gave up, using the same curve and thresholds as Lichess
  computer analysis, so the verdicts match what you already know from lichess.org.
- **Trap detection.** The one thing here that is more than a presentation of Stockfish output.
  A second, deliberately shallow search finds moves that *look* best at a glance but lose at
  depth: the queen grab that walks into mate, the "free" pawn that drops a piece. Those are the
  mistakes humans actually make, and they are invisible in a plain MultiPV list because the
  deep search has already discarded them.
- **Sparring.** Play a strength-limited Stockfish at a chosen Elo with hints available, every
  move graded live.
- **Game review.** Feed it a PGN file, or pull your latest games straight from Lichess or
  chess.com through their public APIs, and get a per-move report with accuracy, average
  centipawn loss, and the moves where the game turned.

## Running it

```bash
npm install                     # once, from the repo root

npm run advisor -- play                             # analysis board, you play both sides
npm run advisor -- spar --elo 1500 --color white    # play the engine, get graded
npm run advisor -- review game.pgn --traps 6        # review a finished game
npm run advisor -- review --lichess <username> --max 3
npm run advisor -- review --chesscom <username> --max 3
```

In `play` and `spar`, type moves as `Nf3`, `e4`, `O-O` or `e2e4`. `?` shows the candidates
for the side to move. Other commands: `board`, `fen`, `pgn`, `undo`, `new`, `summary`,
`depth <n>`, `multipv <n>`, `quit`.

### Making it stronger

The advisor always analyses at full strength. Only the sparring **opponent** is limited, so
that games are playable at your level; `--elo 3190` removes the limit in practice.

Analysis strength is a ladder of independent knobs:

| Knob | Default | Effect |
|---|---|---|
| `--depth <n>` | 18 | More plies. Cost grows roughly 2× per ply. |
| `--movetime <ms>` | off | Fixed time per position instead of depth. |
| `--flavor full` | `lite-single` | The full-size neural network (≈100 MB) instead of the 1 MB lite net. Stronger evaluation at the same depth. `lite` and `full` are multi-threaded, `lite-single` and `single` are not. |
| `--threads <n>` | 1 | With a multi-threaded flavour or a native binary. |
| `--hash <mb>` | 16 | Transposition table. 256 or more for long analysis. |
| `--engine <path>` | off | A native Stockfish binary from [stockfishchess.org](https://stockfishchess.org). Several times faster than WASM at the same settings. The best option if you can install one. |
| `--syzygy <path>` | off | Endgame tablebases, for perfect play with seven or fewer pieces. |

Every flavour in the `stockfish` npm package is already far beyond human strength; the lite
single-threaded default reaches depth 16 from the opening in under half a second.

## Using it from code

```ts
import { Advisor, openEngine, formatCandidate } from '@4wc/advisor';

const engine = await openEngine({ flavor: 'lite-single' });
const advisor = new Advisor({ engine, multipv: 3, limits: { depth: 18 }, trapDepth: 6 });

const analysis = await advisor.analyse();          // candidates, traps, criticality
for (const c of analysis.candidates) console.log(formatCandidate(c));

const report = await advisor.play('e4');           // graded against that analysis
console.log(report.classification, report.loss);   // 'best', 0

await engine.quit();
```

`reviewPgn(pgn, { engine, ... })` grades a whole game; `fetchLichessGames` and
`fetchChesscomGames` download recent games as PGN.

In the browser, import from `@4wc/advisor/browser`: the same `Advisor`, with
`openWorkerEngine(url)` driving a WASM Stockfish in a Web Worker instead of a child process.
`apps/trainer` is the live UI built on that: play, get graded as you go, ask for hints.

## What it is not

Do not use this during a game against another person, online or over the board, rated or
casual. Every platform's rules forbid engine assistance in any game against a human, and
detection is statistical (how closely your moves track an engine), not a matter of spotting
software. The legitimate loop is: play unaided, then review here; or spar against the engine
with hints on.

## Layout

```
src/
  uci.ts        UCI client over a line transport, no platform imports
  node-process.ts  child-process transport: native binary or the WASM build under Node
  browser.ts    Web Worker transport and the browser-safe exports
  engine.ts     locating a Stockfish (native path or the `stockfish` npm package) and options
  score.ts      pure arithmetic: perspectives, win probability, classification, accuracy
  advisor.ts    the Advisor: live game, MultiPV analysis, move grading, trap detection
  review.ts     PGN review and text formatting
  fetch.ts      Lichess and chess.com game download
  tools/advisor-cli.ts
test/           29 tests; the engine ones run the bundled WASM Stockfish at low depth
```

Stockfish is GPL-3.0; the `stockfish` npm package bundles it as WASM. chess.js (BSD-2) handles
move legality, SAN and PGN.
