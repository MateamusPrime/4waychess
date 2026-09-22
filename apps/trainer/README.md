# @4wc/trainer

A live move trainer for **standard chess**, in the browser. You play on the board; Stockfish
analyses every position the moment it appears, grades each move you make, warns you when a
natural-looking move is a trap, and shows the engine's candidate moves when you ask for them.

Nothing leaves the page: Stockfish runs as a WebAssembly Web Worker, so it works from any
static host and offline once loaded. All of the analysis logic is `@4wc/advisor`; this app is
the board and the panels around it.

## Running it

```bash
npm install            # once, from the repo root
npm run trainer        # http://127.0.0.1:8735
```

## How to train with it

- **Opponent: Engine.** Play a strength-limited Stockfish at the Elo you set. The opponent is
  limited; the analysis is not. Every move you make is graded the moment it lands, against the
  full-strength engine's view of the position.
- **Opponent: Both sides.** An analysis board: play through a line or a game with a partner
  and get the same live grading on both sides.
- **Hints: On request.** The default, and the setting that actually trains. Candidates stay
  hidden until you press *Show hint*, so you commit to a move first and learn from the grade.
  *Always* shows the candidates and a best-move arrow before you move.
- **Warn about traps.** With hints hidden you still get a warning when the position contains
  a move that looks good at a glance but loses at depth. It does not say which move, so the
  warning is a prompt to calculate, not an answer.
- **Think time** is how long the engine analyses each position. One second on the bundled
  lite engine reaches roughly depth 14 to 18, well beyond what a human sees. Raise it for
  sharper grading, lower it for a snappier game.

The verdict bar grades each move `best / good / inaccuracy / mistake / blunder` by the
win-probability it gave up, with the same thresholds Lichess uses, and names the better move
when there was one. The accuracy panel tracks both sides and graphs White's win probability
over the game. Paste a FEN to start from any position; *Copy PGN* takes the game elsewhere.

## Rules

Do not use this while playing a person online or over the board. Engine assistance in any game
against a human is against every platform's rules, casual games included. This is a sparring
partner and an analysis board, not an overlay.

## Layout

```
index.html        page shell and styles
src/main.ts       engines, game flow (one queue, so a new game never races an analysis), rendering
src/board.ts      SVG board: pieces from @4wc/pieces, click-to-move, legal-move dots, promotion
scripts/vendor.js copies the lite single-threaded Stockfish build into vendor/ (gitignored)
```
