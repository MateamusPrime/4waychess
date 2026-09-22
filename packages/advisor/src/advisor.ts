/**
 * The advisor: a live game plus a Stockfish analysis of every position reached.
 *
 * Each call to `analyse()` returns the top-N candidate moves (MultiPV) with evaluations, win
 * probabilities and principal variations. Each call to `play()` grades the move just played
 * against that analysis. Everything is expressed from the mover's point of view, which is what
 * a player wants to read; White-perspective scores are carried alongside for graphs.
 *
 * Trap detection (optional) is the one thing here that is more than a presentation of Stockfish
 * output: a second, shallow search finds moves that look best to a quick glance but lose at
 * depth. Those are the mistakes humans actually make, and they are invisible in a plain
 * MultiPV list because the deep search has already discarded them.
 */

import { Chess } from 'chess.js';
import type { Move } from 'chess.js';
import type { GoLimits, InfoLine, Score, SearchLine, UciEngine } from './uci.ts';
import {
  classify, cpLoss, formatScore, moveAccuracy, negate, terminalScore, toWhite, winPct,
} from './score.ts';
import type { Classification, Color } from './score.ts';

export interface AdvisorOptions {
  engine: UciEngine;
  /** Candidate moves to report. Default 3. */
  multipv?: number;
  /** Search limit for the main analysis. Default `{ depth: 18 }`. */
  limits?: GoLimits;
  /**
   * Depth of the quick "how it looks at a glance" search used for trap detection. 0 (default)
   * disables it. 3-5 is the useful range: deep enough to see a capture, shallow enough to miss
   * the refutation. Stockfish sees through most classic baits by depth 6.
   */
  trapDepth?: number;
  /** Win-percentage drop between shallow and deep verdicts that makes a move a trap. Default 10. */
  trapThreshold?: number;
  /** Start position as FEN. Default: the initial position. */
  fen?: string;
  /** Receives every info line of the main (deep) search, for live progress display. */
  onInfo?: (info: InfoLine, fen: string) => void;
}

export interface Candidate {
  rank: number;
  uci: string;
  san: string;
  /** Mover's perspective. */
  score: Score;
  /** White's perspective. */
  scoreWhite: Score;
  /** Mover's win probability after this move, in percent. */
  winPct: number;
  /** Win-percentage points given up relative to the best candidate. */
  lossVsBest: number;
  pv: string[];
  pvSan: string[];
  depth: number;
  /** Win/draw/loss per mille from the mover's perspective, when the engine reports it. */
  wdl?: [number, number, number];
}

export interface Trap {
  uci: string;
  san: string;
  /** Rank in the shallow search (1 = looked best). */
  shallowRank: number;
  shallowScore: Score;
  deepScore: Score;
  /** Win-percentage points between the shallow illusion and the deep truth. */
  drop: number;
  /** The move that punishes it, from the deep principal variation. */
  refutationSan?: string;
}

export interface Analysis {
  fen: string;
  turn: Color;
  /** Half-moves played from the start position. */
  ply: number;
  candidates: Candidate[];
  best: Candidate | null;
  /** Score of the best line, mover's perspective; terminal score if the game is over. */
  score: Score;
  scoreWhite: Score;
  winPct: number;
  depth: number;
  nodes: number;
  timeMs: number;
  /** True when every alternative to the best move loses at least 10 points of win probability. */
  onlyMove: boolean;
  /** Gap in win-percentage points between the best and the second-best candidate. */
  criticality: number;
  gameOver: boolean;
  traps: Trap[];
}

export interface MoveReport {
  ply: number;
  moveNumber: number;
  color: Color;
  san: string;
  uci: string;
  /** Analysis of the position the move was played in. */
  before: Analysis;
  /** Mover's score after the move (the reply position's best line, negated). */
  scoreAfter: Score;
  winPctBefore: number;
  winPctAfter: number;
  /** Win-percentage points lost. */
  loss: number;
  cpLoss: number;
  classification: Classification;
  accuracy: number;
  bestSan: string | null;
  /** Rank of the played move in the candidate list, or null when outside the top N. */
  rank: number | null;
  /** True when the move was a trap flagged in `before.traps`. */
  fellForTrap: boolean;
}

export interface SideSummary {
  moves: number;
  accuracy: number;
  counts: Record<Classification, number>;
  averageCpLoss: number;
}

export interface Summary {
  w: SideSummary;
  b: SideSummary;
}

const EMPTY_COUNTS = (): Record<Classification, number> =>
  ({ best: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 });

function sanLine(fen: string, uciMoves: string[]): string[] {
  const c = new Chess(fen);
  const out: string[] = [];
  for (const u of uciMoves) {
    try {
      out.push(c.move(fromUci(u)).san);
    } catch {
      break;
    }
  }
  return out;
}

export function fromUci(uci: string): { from: string; to: string; promotion?: string } {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length > 4 ? uci[4] : undefined };
}

export function toUci(m: Move): string {
  return m.from + m.to + (m.promotion ?? '');
}

/** Thrown by `analyse()` / `play()` when `abort()` was called while they were running. */
export class AnalysisAborted extends Error {
  constructor() { super('analysis aborted'); this.name = 'AnalysisAborted'; }
}

export class Advisor {
  readonly engine: UciEngine;
  readonly game: Chess;
  readonly reports: MoveReport[] = [];
  multipv: number;
  limits: GoLimits;
  trapDepth: number;
  trapThreshold: number;
  onInfo: AdvisorOptions['onInfo'];
  /** The position the engine is fed before the move list; changes on `reset(fen)`. */
  startFen: string;
  private cache = new Map<string, Analysis>();
  private engineMultipv = -1;
  private busy: Promise<unknown> = Promise.resolve();
  private epoch = 0;

  constructor(opts: AdvisorOptions) {
    this.engine = opts.engine;
    this.multipv = opts.multipv ?? 3;
    this.limits = opts.limits ?? { depth: 18 };
    this.trapDepth = opts.trapDepth ?? 0;
    this.trapThreshold = opts.trapThreshold ?? 10;
    this.onInfo = opts.onInfo;
    this.startFen = opts.fen ?? new Chess().fen();
    this.game = new Chess(this.startFen);
  }

  fen(): string { return this.game.fen(); }
  turn(): Color { return this.game.turn(); }
  ply(): number { return this.game.history().length; }
  /** Moves played so far, in UCI. */
  moves(): string[] { return this.game.history({ verbose: true }).map(toUci); }

  /** Start over, optionally from a new start FEN. Reports are cleared. */
  reset(fen?: string): void {
    if (fen !== undefined) this.startFen = fen;
    this.game.load(this.startFen);
    this.reports.length = 0;
    this.cache.clear();
  }

  /** Resolves once every queued analysis has finished. */
  idle(): Promise<void> {
    return this.busy.then(() => undefined);
  }

  /**
   * Cut short whatever analysis is running: the current search is stopped and the chain of
   * searches behind `analyse()` (glance, deep, trap follow-ups) exits with `AnalysisAborted`
   * instead of continuing. Queued calls made after this still run.
   */
  abort(): void {
    this.epoch++;
    this.engine.stop();
  }

  private checkpoint(epoch: number): void {
    if (epoch !== this.epoch) throw new AnalysisAborted();
  }

  /** Analyse the current position (cached per FEN and settings). */
  analyse(): Promise<Analysis> {
    const epoch = this.epoch; // an abort() between now and the start of the work aborts it too
    const run = this.busy.then(() => this.analyseNow(epoch));
    this.busy = run.catch(() => undefined);
    return run;
  }

  private cacheKey(fen: string): string {
    return `${fen}|${this.multipv}|${JSON.stringify(this.limits)}|${this.trapDepth}`;
  }

  private async ensureMultipv(n: number): Promise<void> {
    if (this.engineMultipv !== n) {
      await this.engine.setOption('MultiPV', n);
      this.engineMultipv = n;
    }
  }

  private async analyseNow(epoch: number): Promise<Analysis> {
    this.checkpoint(epoch);
    const fen = this.game.fen();
    const key = this.cacheKey(fen);
    const hit = this.cache.get(key);
    if (hit) return hit;

    const turn = this.game.turn();
    const ply = this.ply();
    const legal = this.game.moves({ verbose: true });

    if (legal.length === 0) {
      const score = terminalScore(this.game.inCheck());
      const a: Analysis = {
        fen, turn, ply, candidates: [], best: null, score, scoreWhite: toWhite(score, turn),
        winPct: winPct(score), depth: 0, nodes: 0, timeMs: 0, onlyMove: false, criticality: 0,
        gameOver: true, traps: [],
      };
      this.cache.set(key, a);
      return a;
    }

    const n = Math.min(this.multipv, legal.length);
    await this.ensureMultipv(n);

    // The shallow "glance" must run before the deep search and on an empty hash table, or the
    // engine answers it straight from the transposition table with the deep result.
    let shallow: SearchLine[] = [];
    if (this.trapDepth > 0) {
      if (this.engine.hasOption('Clear Hash')) await this.engine.pressButton('Clear Hash');
      this.engine.position(this.startFen, this.moves());
      shallow = (await this.engine.go({ depth: this.trapDepth })).lines;
      this.checkpoint(epoch);
    }

    this.engine.position(this.startFen, this.moves());
    const deep = await this.engine.go(this.limits, this.onInfo && ((info) => this.onInfo?.(info, fen)));
    this.checkpoint(epoch);
    const candidates = deep.lines.map((l, i) => this.toCandidate(l, i + 1, fen, turn, deep.lines[0]));
    const traps = shallow.length ? await this.findTraps(fen, shallow, candidates, epoch) : [];

    const best = candidates[0] ?? null;
    const score = best?.score ?? { type: 'cp', value: 0 };
    const second = candidates[1];
    const criticality = best && second ? best.winPct - second.winPct : 0;
    const a: Analysis = {
      fen, turn, ply, candidates, best, score, scoreWhite: toWhite(score, turn),
      winPct: winPct(score), depth: deep.depth, nodes: deep.nodes, timeMs: deep.timeMs,
      onlyMove: legal.length > 1 && candidates.length > 1 && criticality >= 10,
      criticality, gameOver: false, traps,
    };
    this.cache.set(key, a);
    return a;
  }

  private toCandidate(l: SearchLine, rank: number, fen: string, turn: Color, top: SearchLine): Candidate {
    const pvSan = sanLine(fen, l.pv);
    return {
      rank, uci: l.pv[0], san: pvSan[0] ?? l.pv[0], score: l.score, scoreWhite: toWhite(l.score, turn),
      winPct: winPct(l.score), lossVsBest: Math.max(0, winPct(top.score) - winPct(l.score)),
      pv: l.pv, pvSan, depth: l.depth, wdl: l.wdl,
    };
  }

  /**
   * A trap is a move the shallow search ranks highly but the deep search shows losing at least
   * `trapThreshold` win-percentage points against the deep best. To score a shallow favourite
   * that the deep MultiPV list did not cover, it is searched once with MultiPV 1 at full depth.
   */
  private async findTraps(fen: string, shallow: SearchLine[], deep: Candidate[], epoch: number): Promise<Trap[]> {
    const n = Math.min(this.multipv, this.game.moves().length);
    const deepBestPct = deep[0]?.winPct ?? 50;
    const traps: Trap[] = [];
    for (const line of shallow) {
      const uci = line.pv[0];
      const known = deep.find((c) => c.uci === uci);
      let deepScore: Score;
      let deepPct: number;
      let refutation: string | undefined;
      if (known) {
        deepScore = known.score;
        deepPct = known.winPct;
        refutation = known.pvSan[1];
      } else {
        // Not in the deep top N: evaluate the position after the move at full depth.
        const after = new Chess(fen);
        after.move(fromUci(uci));
        if (after.isGameOver()) {
          const terminal = terminalScore(after.inCheck());
          deepScore = negate(terminal);
          deepPct = 100 - winPct(terminal);
        } else {
          await this.ensureMultipv(1);
          this.engine.position(this.startFen, [...this.moves(), uci]);
          const reply = await this.engine.go(this.trapLimits());
          this.checkpoint(epoch);
          const replyLine = reply.lines[0];
          deepScore = replyLine ? negate(replyLine.score) : { type: 'cp', value: 0 };
          deepPct = replyLine ? 100 - winPct(replyLine.score) : 50;
          refutation = replyLine ? sanLine(after.fen(), replyLine.pv.slice(0, 1))[0] : undefined;
          await this.ensureMultipv(n);
        }
      }
      const drop = deepBestPct - deepPct;
      if (drop >= this.trapThreshold) {
        traps.push({
          uci, san: sanLine(fen, [uci])[0] ?? uci, shallowRank: line.multipv, shallowScore: line.score,
          deepScore, drop, refutationSan: refutation,
        });
      }
    }
    return traps;
  }

  /** Trap follow-ups are MultiPV 1 on one move; a third of the main budget is plenty. */
  private trapLimits(): GoLimits {
    const l = this.limits;
    if (l.movetime !== undefined) return { movetime: Math.max(150, Math.round(l.movetime / 3)) };
    if (l.nodes !== undefined) return { nodes: Math.max(10_000, Math.round(l.nodes / 3)) };
    return l;
  }

  /**
   * Play a move (SAN or UCI) and grade it. The grade compares the mover's win probability before
   * the move with their win probability in the resulting position, as the engine sees it.
   */
  async play(move: string): Promise<MoveReport> {
    const before = await this.analyse();
    let played: Move;
    try {
      played = this.game.move(/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move) ? fromUci(move) : move);
    } catch {
      throw new Error(`illegal move "${move}" in ${before.fen}`);
    }
    let after: Analysis;
    try {
      after = await this.analyse();
    } catch (err) {
      // Keep game and reports consistent: an aborted grade means the move was not played.
      this.game.undo();
      throw err;
    }
    // "mate 0" carries no sign, so the mover's chances come from the reply side's, not from
    // negating the score. A delivered mate is 100%, a stalemate 50%.
    const scoreAfter = negate(after.score);
    const pctBefore = before.winPct;
    const pctAfter = 100 - after.winPct;
    const delivered = after.gameOver && after.score.type === 'mate';
    const uci = toUci(played);
    const rankIdx = before.candidates.findIndex((c) => c.uci === uci);
    const playedBest = rankIdx === 0 || pctAfter >= pctBefore;
    const report: MoveReport = {
      ply: before.ply + 1,
      moveNumber: Math.floor(before.ply / 2) + 1,
      color: before.turn,
      san: played.san,
      uci,
      before,
      scoreAfter,
      winPctBefore: pctBefore,
      winPctAfter: pctAfter,
      loss: Math.max(0, pctBefore - pctAfter),
      cpLoss: delivered ? 0 : cpLoss(before.score, scoreAfter),
      classification: classify(pctBefore, pctAfter, playedBest),
      accuracy: moveAccuracy(pctBefore, pctAfter),
      bestSan: before.best?.san ?? null,
      rank: rankIdx >= 0 ? rankIdx + 1 : null,
      fellForTrap: before.traps.some((t) => t.uci === uci),
    };
    this.reports.push(report);
    return report;
  }

  /** Take back the last move and its report. */
  undo(): Move | null {
    const m = this.game.undo();
    if (m) this.reports.pop();
    return m;
  }

  summary(): Summary {
    const side = (color: Color): SideSummary => {
      const rs = this.reports.filter((r) => r.color === color);
      const counts = EMPTY_COUNTS();
      let acc = 0;
      let cp = 0;
      for (const r of rs) { counts[r.classification]++; acc += r.accuracy; cp += r.cpLoss; }
      return {
        moves: rs.length,
        accuracy: rs.length ? acc / rs.length : 0,
        counts,
        averageCpLoss: rs.length ? cp / rs.length : 0,
      };
    };
    return { w: side('w'), b: side('b') };
  }
}

/** One-line rendering of a candidate, e.g. `1. Nf3  +0.35  (56%)  Nf3 d5 d4 Nf6`. */
export function formatCandidate(c: Candidate, pvLength = 6): string {
  const pv = c.pvSan.slice(0, pvLength).join(' ');
  return `${c.rank}. ${c.san.padEnd(7)} ${formatScore(c.score).padStart(6)}  (${c.winPct.toFixed(0).padStart(3)}%)  ${pv}`;
}
