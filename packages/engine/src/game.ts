/**
 * The Game layer: playing a game, as opposed to exploring a tree.
 *
 * `Position` is the tree-search primitive — make/unmake, no bookkeeping, fast. `Game` wraps it
 * and owns everything that only matters when a real game is being played: scoring, elimination
 * transitions, repetition history, and end conditions. Bots and perft use Position directly and
 * pay none of this cost.
 *
 * Game is forward-only. Takeback is implemented by replaying the move list from the start
 * position, not by unwinding — eliminations and piece transfers are not reversible in place.
 */

import type { Army, ArmyStatus, Move, Ruleset } from './types.ts';
import { ARMIES } from './geometry.ts';
import { FFA_RULES, PARTNER, Position, codeArmy, codeType, encodePiece } from './position.ts';
import { startingPosition } from './fen4.ts';
import { generateLegal, turnOutcome } from './movegen.ts';
import { checkingArmies } from './attacks.ts';
import {
  CHECKMATE_BONUS, SELF_STALEMATE_BONUS, armiesCheckedBy, captureValue, checkBonusFor,
  kingCount, newChecks,
} from './scoring.ts';

export type EndReason =
  | 'elimination'
  | 'team-eliminated'
  | 'repetition'
  | 'move-rule'
  | 'none';

export interface GameResult {
  over: boolean;
  reason: EndReason;
  /** Highest scorers in FFA, or the surviving team in Teams. Empty while the game runs. */
  winners: Army[];
}

/** Something that happened as a consequence of a move, for the UI and the move log. */
export interface GameEvent {
  type: 'capture' | 'check' | 'multi-check' | 'checkmate' | 'stalemate' | 'promotion'
      | 'resign' | 'timeout' | 'inherit' | 'captured' | 'end';
  army: Army;
  /** For eliminations: who caused it. For captures: the victim. */
  other?: Army;
  points?: number;
  detail?: string;
}

/**
 * A player leaving the game, and WHEN.
 *
 * Retirements are not moves, so they leave no trace in the movetext — which made every game
 * containing one unreplayable: the replay expected the retired army to keep taking turns and
 * desynced at its next skipped seat. Recording the ply lets a replay apply the retirement at
 * exactly the right point (RULES.md §15).
 */
export interface Retirement {
  army: Army;
  status: ArmyStatus;
  /** Number of moves played when it happened. */
  atPly: number;
}

export class Game {
  pos: Position;
  moves: Move[];
  events: GameEvent[];
  /** Resignations and timeouts, in the order they occurred. */
  retirements: Retirement[];
  private startFen: string;
  private repetition: Map<string, number>;
  private ended: GameResult;

  constructor(pos: Position = startingPosition(), startFen?: string) {
    this.pos = pos;
    this.moves = [];
    this.events = [];
    this.retirements = [];
    this.startFen = startFen ?? '';
    this.repetition = new Map();
    this.ended = { over: false, reason: 'none', winners: [] };
    this.recordRepetition();
  }

  static create(rules: Ruleset = FFA_RULES): Game {
    return new Game(startingPosition(rules));
  }

  get rules(): Ruleset {
    return this.pos.rules;
  }
  get turn(): Army {
    return this.pos.turn;
  }
  legalMoves(army: Army = this.pos.turn): Move[] {
    return this.ended.over ? [] : generateLegal(this.pos, army);
  }
  result(): GameResult {
    return this.ended;
  }

  /* ------------------------------------------------------------------ */

  /** Play a move by the side to move, applying scoring and all consequences. */
  play(move: Move): GameEvent[] {
    if (this.ended.over) throw new Error('game is over');
    const mover = this.pos.turn;
    const produced: GameEvent[] = [];

    // Both of these must be read BEFORE the move. Capture value depends on whether the
    // victim's army is still active and how many kings they hold; the check set is needed so
    // we can award only checks this move actually delivers, not ones already standing.
    const gained = captureValue(this.pos, move);
    const checkedBefore = armiesCheckedBy(this.pos, mover);

    this.pos.makeMove(move);
    this.moves.push(move);

    if (gained > 0 && move.capturedArmy !== null) {
      this.pos.points[mover] += gained;
      produced.push({ type: 'capture', army: mover, other: move.capturedArmy, points: gained });
    }

    // Losing your last king ends your game.
    //
    // King capture is reachable and priced by the rules (+20, or +3 for a spare — §10), because
    // checkmate is only assessed when the victim's turn arrives (§8): a checked player's king
    // can be taken by a THIRD party before they ever get to respond. Without this, the victim
    // survived with no king — and since `isInCheck` reports false when there is no king to
    // check, they became permanently immune to check and checkmate and played on forever.
    if (move.captured === 'k' && move.capturedArmy !== null) {
      const victim = move.capturedArmy;
      if (this.pos.isActive(victim) && kingCount(this.pos, victim) === 0) {
        this.eliminate(victim, 'captured');
        produced.push({ type: 'captured', army: victim, other: mover });
        // makeMove already advanced the turn while the victim was still active, so it may now
        // be pointing at an army that has just been eliminated.
        if (!this.pos.isActive(this.pos.turn)) {
          this.pos.turn = this.pos.nextActive(this.pos.turn);
        }
      }
    }
    if (move.promotion !== null) {
      produced.push({ type: 'promotion', army: mover, detail: move.promotion });
    }

    const delivered = newChecks(checkedBefore, armiesCheckedBy(this.pos, mover));
    const bonus = checkBonusFor(delivered.length);
    if (bonus > 0) {
      this.pos.points[mover] += bonus;
      produced.push({
        type: 'multi-check', army: mover, points: bonus, detail: delivered.join(','),
      });
    }

    this.recordRepetition();
    produced.push(...this.settleTurns(mover));
    this.checkDrawConditions();
    this.updateResult();

    this.events.push(...produced);
    return produced;
  }

  /**
   * Advance through eliminated players.
   *
   * Checkmate and stalemate are assessed only when the affected player's own turn arrives
   * (RULES.md §8), and eliminating one player can immediately mate the next, so this must
   * cascade rather than check once.
   */
  private settleTurns(lastMover: Army): GameEvent[] {
    const out: GameEvent[] = [];
    for (let guard = 0; guard < 8; guard++) {
      const victim = this.pos.turn;
      if (!this.pos.isActive(victim)) break;
      if (this.pos.activeArmies().length <= 1) break;

      const outcome = turnOutcome(this.pos, victim);

      if (outcome === 'check') {
        out.push({ type: 'check', army: victim });
        break;
      }
      if (outcome !== 'checkmate' && outcome !== 'stalemate') break;

      if (outcome === 'checkmate') {
        // Credit the checking army that moved most recently — in practice the last mover
        // when they are among the checkers, otherwise whichever checker is closest behind.
        const checkers = checkingArmies(this.pos, victim);
        const credited = checkers.includes(lastMover) ? lastMover : checkers[0];
        this.eliminate(victim, 'checkmated');
        if (credited !== undefined) {
          this.pos.points[credited] += CHECKMATE_BONUS;
          out.push({ type: 'checkmate', army: victim, other: credited, points: CHECKMATE_BONUS });
        } else {
          out.push({ type: 'checkmate', army: victim });
        }
      } else {
        // Self-stalemate pays the stalemated player (RULES.md §8).
        this.pos.points[victim] += SELF_STALEMATE_BONUS;
        this.eliminate(victim, 'stalemated');
        out.push({ type: 'stalemate', army: victim, points: SELF_STALEMATE_BONUS });
      }

      this.pos.turn = this.pos.nextActive(victim);
    }
    return out;
  }

  private eliminate(army: Army, status: ArmyStatus): void {
    this.pos.status[army] = status;
    this.pos.castling[army] = { short: false, long: false };
    this.pos.ep = this.pos.ep.filter((e) => e.army !== army);
  }

  /* ------------------------------------------------------------------ */

  /** Voluntary resignation. In Teams this hands your surviving pieces to your partner. */
  resign(army: Army): GameEvent[] {
    return this.retire(army, 'resigned');
  }

  /** Clock expiry. Same consequences as resignation. */
  timeout(army: Army): GameEvent[] {
    return this.retire(army, 'timeout');
  }

  private retire(army: Army, status: ArmyStatus): GameEvent[] {
    if (this.ended.over) throw new Error('game is over');
    if (!this.pos.isActive(army)) throw new Error(`${army} is already out`);
    const out: GameEvent[] = [{ type: status === 'resigned' ? 'resign' : 'timeout', army }];
    this.retirements.push({ army, status, atPly: this.moves.length });

    // Teams: surviving pieces transfer to the partner rather than dying (RULES.md §11).
    // This is what creates a "spare king", worth 3 rather than 20 (RULES.md §10).
    if (this.rules.mode === 'teams') {
      const partner = PARTNER[army];
      if (this.pos.isActive(partner)) {
        let moved = 0;
        for (let s = 0; s < this.pos.board.length; s++) {
          const c = this.pos.board[s];
          if (c === 0 || codeArmy(c) !== army) continue;
          this.pos.board[s] = encodePiece(partner, codeType(c), (c & 32) !== 0);
          moved++;
        }
        out.push({ type: 'inherit', army: partner, other: army, detail: `${moved} pieces` });
      }
    }

    this.eliminate(army, status);
    if (this.pos.turn === army) this.pos.turn = this.pos.nextActive(army);

    out.push(...this.settleTurns(army));
    this.updateResult();
    this.events.push(...out);
    return out;
  }

  /* ------------------------------------------------------------------ */

  private recordRepetition(): void {
    const key = this.pos.positionKey();
    this.repetition.set(key, (this.repetition.get(key) ?? 0) + 1);
  }

  /** How many times the current position has occurred. */
  repetitionCount(): number {
    return this.repetition.get(this.pos.positionKey()) ?? 0;
  }

  /**
   * Draw conditions (RULES.md §13). A "round" is defined as four plies regardless of how many
   * armies remain, so the threshold is deterministic and does not shift when a player dies.
   */
  private checkDrawConditions(): void {
    if (this.ended.over) return;
    if (this.repetitionCount() >= this.rules.repetitionLimit) {
      this.ended = { over: true, reason: 'repetition', winners: this.leaders() };
      this.events.push({ type: 'end', army: this.pos.turn, detail: 'repetition' });
      return;
    }
    if (this.pos.halfmove >= this.rules.moveRuleRounds * 4) {
      this.ended = { over: true, reason: 'move-rule', winners: this.leaders() };
      this.events.push({ type: 'end', army: this.pos.turn, detail: 'move-rule' });
    }
  }

  /** Highest scorers. Ties are shared (RULES.md §12). */
  private leaders(): Army[] {
    const best = Math.max(...ARMIES.map((a) => this.pos.points[a]));
    return ARMIES.filter((a) => this.pos.points[a] === best);
  }

  private updateResult(): void {
    if (this.ended.over) return;

    if (this.rules.mode === 'teams') {
      const teamA: Army[] = ['red', 'yellow'];
      const teamB: Army[] = ['blue', 'green'];
      const aDead = teamA.every((a) => !this.pos.isActive(a));
      const bDead = teamB.every((a) => !this.pos.isActive(a));
      if (aDead || bDead) {
        this.ended = {
          over: true,
          reason: 'team-eliminated',
          winners: aDead && bDead ? [] : aDead ? teamB : teamA,
        };
        this.events.push({ type: 'end', army: this.pos.turn, detail: 'team-eliminated' });
      }
      return;
    }

    if (this.pos.activeArmies().length <= 1) {
      this.ended = { over: true, reason: 'elimination', winners: this.leaders() };
      this.events.push({ type: 'end', army: this.pos.turn, detail: 'elimination' });
    }
  }

  /* ------------------------------------------------------------------ */

  get startingFen(): string {
    return this.startFen;
  }
  set startingFen(fen: string) {
    this.startFen = fen;
  }
}
