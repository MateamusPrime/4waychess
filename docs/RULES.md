# 4-Way Chess — Ruleset Specification

**Ruleset id:** `4wc.house.v1`
**Base:** chess.com 4 Player Chess, with one deliberate divergence (§4.2).

Every rule below is marked:

- **DECIDED** — settled, build it.
- **PROPOSED** — my recommendation, needs your sign-off before it becomes canon. Listed again in §16.
- **VERIFY** — believed correct from research but worth confirming against live chess.com behaviour if
  interoperability ever matters.

> Nothing in this file may be left implicit. Undocumented behaviour becomes accidental canon the moment a
> player sees it, and by then changing it is a breaking change to a live game.

---

## 1. Board and coordinates — DECIDED

- 14 × 14 grid. The four 3 × 3 corners are **not part of the board**. 160 playable squares.
- Files `a`–`n` left to right. Ranks `1`–`14` bottom to top.
- Internal representation: `x` = 0–13 (file), `y` = 0–13 (rank), `y = 0` is rank 1.
- A square is playable iff **not** (`x < 3 or x > 10`) **and** (`y < 3 or y > 10`).
- Square colour: `(x + y) % 2 === 0` → dark. (`a1` is dark, as in standard chess.)

## 2. Armies, seating and turn order — DECIDED

| Army | Edge | Back line | Pawn line | Faces |
|---|---|---|---|---|
| Red | bottom | rank 1, files d–k | rank 2 | +rank |
| Blue | left | file a, ranks 4–11 | file b | +file |
| Yellow | top | rank 14, files d–k | rank 13 | −rank |
| Green | right | file n, ranks 4–11 | file m | −file |

Turn order is **Red → Blue → Yellow → Green**, repeating (clockwise). Red moves first.

## 3. Army-local frames — DECIDED *(the key engine abstraction)*

Because every army is identical under 90° rotation (§4.2), define for each army a local frame where
`ownFile` runs 1–8 from that army's own left and `ownRank` runs 1–14 forward from its own back line:

| Army | ownFile | ownRank |
|---|---|---|
| Red | `x − 2` | `y + 1` |
| Blue | `11 − y` | `x + 1` |
| Yellow | `11 − x` | `14 − y` |
| Green | `y − 2` | `14 − x` |

In this frame **every army's back line is exactly standard chess shifted three files**, and all four kings
sit at `(ownFile 5, ownRank 1)` — the same relative square as `e1`.

**Consequence:** pawn direction, promotion distance and castling are all expressible as ordinary chess
rules in the local frame. The engine should transform into the local frame once and then apply
conventional logic, rather than special-casing four directions everywhere.

## 4. Starting position

### 4.1 Layout — DECIDED

Every army's back line reads **`R N B Q K B N R` from that army's own left** — queen left, king right, as
in standard chess. This makes the position 90° rotationally symmetric.

Kings: Red `h1`, Blue `a7`, Yellow `g14`, Green `n8`. No two kings share a file or rank.
Queens: Red `g1`, Blue `a8`, Yellow `h14`, Green `n7`.

FEN4 (`OUR_START`), rank 14 → rank 1:

```
3,yR,yN,yB,yK,yQ,yB,yN,yR,3/3,yP,yP,yP,yP,yP,yP,yP,yP,3/14/
bR,bP,10,gP,gR/bN,bP,10,gP,gN/bB,bP,10,gP,gB/bQ,bP,10,gP,gK/
bK,bP,10,gP,gQ/bB,bP,10,gP,gB/bN,bP,10,gP,gN/bR,bP,10,gP,gR/
14/3,rP,rP,rP,rP,rP,rP,rP,rP,3/3,rR,rN,rB,rQ,rK,rB,rN,rR,3
```

### 4.2 Divergence from chess.com — DECIDED

The real game is **mirror**-symmetric: Red and Yellow have queen-left, Blue and Green have king-left. Our
house rule makes all four queen-left, which differs at exactly **four squares — `a7 a8 n7 n8`** (Blue and
Green swap king and queen).

`CHESSCOM_START` is retained in the codebase so an import shim stays cheap. Every stored game records its
ruleset id so both can coexist.

## 5. Piece movement — DECIDED

King, queen, rook, bishop and knight move exactly as in standard chess. Sliding pieces are blocked by any
occupied square regardless of owner, and by the board edge — including the **inner edges of the corner
cutouts**, which are true edges, not holes to slide across.

Any piece may capture any piece belonging to a *different* army (subject to §11 in Teams mode). No army may
capture its own pieces.

## 6. Pawns

- **Direction — DECIDED.** Each army's pawns move toward the opposite edge: `ownRank + 1`. Captures are
  the two forward diagonals in the local frame. The four pawn walls therefore meet perpendicularly, not
  head-on.
- **Double step — DECIDED.** Permitted only from `ownRank 2` (the starting line), and only if both
  intervening squares are empty.
- **Promotion — DECIDED, VERIFY constants.**
  - **FFA:** promotes on reaching `ownRank 8`. Automatic promotion to a **1-point queen** — a queen in
    movement, but worth only +1 if captured. No underpromotion.
  - **Teams:** promotes on reaching `ownRank 11`. Underpromotion to queen, rook, bishop or knight allowed,
    and the resulting queen is a **normal 9-point queen**.
  - This mode divergence is deliberate and is the single largest reason Teams is not a trivial config flag.
- **Pawns in the side arms — DECIDED (discovered during implementation).** Capturing diagonally can
  carry a pawn out of its own eight-file home corridor and into a side arm, where its `ownFile`
  legitimately becomes 0 or negative (or 9 and above). This is legal and unremarkable in play, but it
  breaks any code that assumes `ownFile ∈ 1..8` — a bug we hit in our own reference generator. Promotion
  still triggers purely on `ownRank`, so a Red pawn that has drifted to file `c` still promotes on
  rank 8. Movement, capture and promotion are all defined by rank and direction alone; file position
  never restricts them.
- **En passant — DECIDED.** A pawn that has just made a double step may be captured en passant by any
  enemy pawn attacking the square it stepped over. The right is available to each opponent **on that
  opponent's first turn following the double step**, and expires when the double-stepping player's next
  turn begins — i.e. a one-full-round window. This is the natural generalisation of the two-player rule,
  where the opponent's immediately-next turn is the only chance. The captured pawn is removed from its
  landing square; the capturing pawn lands on the passed-over square.
  *Note:* perpendicular pawns can legitimately attack a passed-over square, so this is not a rare case.

## 7. Castling — DECIDED

In the army-local frame, castling is **exactly standard chess**, because the back line is an exact
isomorphism of `a1`–`h1` with the king on `e1`.

Conditions: king and the chosen rook have never moved; all squares between them are empty; the king is not
currently in check; the king does not pass through or land on a square attacked by **any** of the three
opponents.

Concretely for Red (all other armies are the rotation of this):

| | King | Rook |
|---|---|---|
| Short (toward `k1`) | `h1 → j1` | `k1 → i1` |
| Long (toward `d1`) | `h1 → f1` | `d1 → g1` |

## 8. Check, checkmate and stalemate

- **Legality — DECIDED.** A move is illegal if it leaves the mover's own king attacked by **any** of the
  three opponents. Pins, discoveries and skewers may originate from three directions at once.
- **Multiple check — DECIDED.** A king may be in check from two or three opponents simultaneously. There is
  no special resolution rule; the position is simply harder to escape, and may be mate.
- **When mate is evaluated — DECIDED, VERIFY.** Checkmate is assessed **only when the checkmated player's
  own turn arrives**, not at the moment the mating move is played. A player who is "mated" but whose
  attacker is themselves eliminated before the turn comes round is *not* mated. This rule is unusual, it is
  load-bearing, and it must have dedicated tests.
- **Checkmate — DECIDED.** At the start of player P's turn: P is in check and has no legal move → P is
  checkmated and eliminated (§9).
- **Stalemate — DECIDED, VERIFY.** At the start of P's turn: P is *not* in check and has no legal move → P
  is stalemated. P's army becomes inactive and P is awarded **+20** ("self-stalemate"). This rewards
  engineering your own stalemate, which is intentional in FFA and worth testing deliberately.

## 9. Elimination and dead armies — DECIDED

When a player is eliminated (checkmate, stalemate, resignation, timeout):

- Their pieces remain on the board, rendered greyed and inactive.
- Dead pieces **never move** and **never give check**.
- Dead pieces **block** movement exactly like any other occupied square.
- Dead pieces may be captured, but award **0 points**. They are pure terrain.
- The eliminated player takes no further turns; turn order skips them.

## 10. Scoring — Free-for-All — DECIDED, VERIFY constants

Points accrue to the *capturing* or *achieving* player and are never lost.

| Event | Points |
|---|---|
| Capture pawn | +1 |
| Capture 1-point queen (promoted, FFA) | +1 |
| Capture knight | +3 |
| Capture bishop | +5 |
| Capture rook | +5 |
| Capture queen | +9 |
| Capture king | +20 |
| Capture a "spare" king | +3 |
| Deliver checkmate | +20 |
| Self-stalemate (to the stalemated player) | +20 |
| Check two players at once | +5 |
| Check three players at once | +20 |
| Capturing any dead piece | 0 |

**Note the inversion from standard chess: bishops (5) outrank knights (3).** Long diagonals on an open
14 × 14 board make bishops materially stronger, and in FFA the value table *is* the scoring system, so this
is not cosmetic — it drives both player strategy and bot evaluation.

**Winning FFA is a points race, not last-player-standing.** A player who is eliminated early may still win.

## 11. Teams mode — DECIDED

- Red + Yellow versus Blue + Green. Partners sit opposite each other.
- No friendly fire: you may not capture your partner's pieces, and may not deliver check to your partner.
- A move that would leave *your partner's* king in check from an opponent is still legal — you are not
  responsible for their king — but you may not create that check yourself.
- Promotion is on `ownRank 11` with underpromotion permitted (§6).
- The game ends when both members of one team are eliminated. Points are not the win condition.
- **DECIDED:** on resignation, the resigning player's surviving pieces transfer to their partner's control
  rather than dying. This is the rule that makes Teams resignations interesting rather than punitive.

## 12. Game end — DECIDED

- **FFA:** ends when at most one active player remains, or when a draw condition (§13) is met. Highest score
  wins. Ties are shared.
- **Teams:** ends when both members of one team are eliminated, or on a draw condition.

## 13. Draws and repetition — DECIDED

- **Threefold repetition:** the same full position — all pieces, all four elimination states, castling
  rights, en-passant rights, and the same player to move — occurring three times ends the game
  immediately. In FFA final scores stand as they are; in Teams it is a draw.
- **Fifty-move rule:** fifty **full rounds** (i.e. fifty turns for each active player) with no capture and
  no pawn move ends the game on the same terms.
- Both thresholds are configuration values, not constants in code, because they will need tuning.

## 14. Resignation, timeout and abandonment — DECIDED

chess.com's behaviour is that the army dies but the **king remains live and moves randomly**. That is
faithful but reads as broken to a new player.

**Proposal:** our default is **bot substitution** — an abandoned seat is taken over by a bot of matching
strength, the game continues normally, and the abandoning player is penalised. The chess.com dead-king
behaviour is retained as a configurable ruleset option for anyone who wants strict compatibility.

Rationale: one player quitting is one of the two existential product risks (RISKS.md R2). Substitution
protects the experience of the three players who did nothing wrong.

## 15. Notation and persistence — DECIDED

- **FEN4** for positions, **PGN4** for games, both **versioned from the first byte written**.
- Every stored game records: ruleset id, ruleset version, engine version, mode, and full move list with
  per-move timestamps.
- Move format: long algebraic (`g2-g4`, `Nj1-i3`, `x` for captures), prefixed by army where context needs it.
- **Requirement:** it must be possible to recompute scores, ratings and achievements over the entire game
  history from stored data alone. Assume you will need to do this someday, and make it possible now.

---

## 16. Sign-off record — all DECIDED

Signed off 2026-07-24. All four are tunable configuration, not constants in code.

| § | Item | Decision |
|---|---|---|
| 6 | En passant window across four armies | One full round — each opponent gets exactly one chance |
| 11 | Teams resignation transfers pieces to partner | Yes — resignation is a strategic act, not just a loss |
| 13 | Threefold repetition and fifty-**round** rule | Both adopted, as tunable config |
| 14 | Abandonment | Bot substitution is the default; chess.com dead-king retained as an option |

Also decided during implementation: **pawns in the side arms** (§6) — `ownFile` is not bounded to 1..8.

## 17. Items to verify against live chess.com behaviour

Only matters if interoperability is ever wanted. None of these block building.

- Exact promotion rank constants (FFA 8th, Teams 11th).
- Whether "self-stalemate +20" is awarded to the stalemated player or the stalemating player.
- The "spare king +3" value — what produces a spare king in the first place.
- Precise semantics of the simultaneous-check bonuses.
- Whether chess.com implements en passant at all, and with what window.
