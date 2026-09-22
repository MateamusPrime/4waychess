#!/usr/bin/env node
/**
 * advisor — Stockfish training advisor for standard chess.
 *
 *   advisor play                      analysis board: you play both sides, hints on demand
 *   advisor spar [--elo 1500] [--color white|black]
 *                                     play a strength-limited Stockfish; every move is graded
 *   advisor review game.pgn           grade every move of a finished game
 *   advisor review --lichess <user> [--max 1]
 *   advisor review --chesscom <user> [--max 1] [--year 2026 --month 9]
 *
 * Options (all modes):
 *   --engine <path>      native Stockfish binary (fastest, strongest)
 *   --flavor <f>         WASM flavour when no --engine: lite-single (default), lite, single, full
 *   --depth <n>          analysis depth (default 18)
 *   --movetime <ms>      analysis time per position instead of depth
 *   --multipv <n>        candidate moves to show (default 3)
 *   --traps <depth>      enable trap detection with a shallow search at this depth (try 6)
 *   --threads <n>  --hash <mb>  --syzygy <path>
 *
 * In play/spar, type a move (Nf3, e4, O-O, or e2e4) or a command:
 *   ?  hint      show the candidate moves for the side to move
 *   board  fen  pgn  undo  new  depth <n>  multipv <n>  quit
 */

import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { openEngine } from '../engine.ts';
import type { EngineSpec } from '../engine.ts';
import { Advisor, formatCandidate } from '../advisor.ts';
import type { Analysis, MoveReport } from '../advisor.ts';
import { formatScore } from '../score.ts';
import { formatReport, formatReview, reviewPgn, splitPgn } from '../review.ts';
import { fetchChesscomGames, fetchLichessGames } from '../fetch.ts';
import type { UciEngine } from '../uci.ts';

interface Args {
  positional: string[];
  flags: Record<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out.flags[key] = next; i++; }
      else out.flags[key] = true;
    } else out.positional.push(a);
  }
  return out;
}

function num(v: string | true | undefined, fallback: number): number {
  if (v === undefined || v === true) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`expected a number, got "${v}"`);
  return n;
}

function str(v: string | true | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

const out = (s = ''): void => { process.stdout.write(s + '\n'); };

function engineSpec(args: Args): EngineSpec {
  return {
    path: str(args.flags.engine),
    flavor: str(args.flags.flavor) as EngineSpec['flavor'],
    threads: args.flags.threads !== undefined ? num(args.flags.threads, 1) : undefined,
    hashMb: args.flags.hash !== undefined ? num(args.flags.hash, 16) : undefined,
    syzygyPath: str(args.flags.syzygy),
  };
}

function advisorOptions(args: Args, engine: UciEngine) {
  const movetime = args.flags.movetime !== undefined ? num(args.flags.movetime, 1000) : undefined;
  return {
    engine,
    multipv: num(args.flags.multipv, 3),
    limits: movetime !== undefined ? { movetime } : { depth: num(args.flags.depth, 18) },
    trapDepth: args.flags.traps !== undefined ? num(args.flags.traps, 6) : 0,
  };
}

function printAnalysis(a: Analysis): void {
  if (a.gameOver) { out('Game over.'); return; }
  const who = a.turn === 'w' ? 'White' : 'Black';
  out(`${who} to move   eval ${formatScore(a.scoreWhite)} (White)   win ${a.winPct.toFixed(0)}% for ${who}   depth ${a.depth}`);
  for (const c of a.candidates) out('  ' + formatCandidate(c));
  if (a.onlyMove) out(`  Only move: everything else gives up ${a.criticality.toFixed(0)}+ points.`);
  else if (a.criticality >= 5) out(`  Critical: the best move is worth ${a.criticality.toFixed(0)} points more than the next.`);
  for (const t of a.traps) {
    out(`  Trap: ${t.san} looks like ${formatScore(t.shallowScore)} at a glance but is ${formatScore(t.deepScore)}` +
      (t.refutationSan ? ` after ${t.refutationSan}` : '') + '.');
  }
}

function printReport(r: MoveReport): void {
  out('  ' + formatReport(r));
}

function printBoard(advisor: Advisor): void {
  out(advisor.game.ascii());
}

/**
 * Buffered stdin lines. `readline.question` only captures a line typed while a question is
 * pending, so input that arrives during an analysis (or piped in) would be lost.
 */
function lineReader(): { next: (prompt: string) => Promise<string | null>; close: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  const queue: string[] = [];
  let waiting: ((line: string | null) => void) | null = null;
  let closed = false;
  rl.on('line', (line) => {
    if (waiting) { const w = waiting; waiting = null; w(line); } else queue.push(line);
  });
  rl.on('close', () => {
    closed = true;
    if (waiting) { const w = waiting; waiting = null; w(null); }
  });
  return {
    next: (prompt) => {
      if (queue.length) return Promise.resolve(queue.shift()!);
      if (closed) return Promise.resolve(null);
      rl.setPrompt(prompt);
      rl.prompt();
      return new Promise((resolve) => { waiting = resolve; });
    },
    close: () => rl.close(),
  };
}

async function withEngine<T>(spec: EngineSpec, fn: (engine: UciEngine) => Promise<T>): Promise<T> {
  const engine = await openEngine(spec);
  try {
    return await fn(engine);
  } finally {
    await engine.quit();
  }
}

async function interactive(args: Args, mode: 'play' | 'spar'): Promise<void> {
  const spec = engineSpec(args);
  const humanColor = mode === 'spar' ? (str(args.flags.color)?.startsWith('b') ? 'b' : 'w') : null;
  const elo = num(args.flags.elo, 1500);

  await withEngine(spec, async (engine) => {
    const advisor = new Advisor(advisorOptions(args, engine));
    let opponent: UciEngine | null = null;
    if (mode === 'spar') {
      opponent = await openEngine(spec);
      if (opponent.hasOption('UCI_LimitStrength')) {
        const range = opponent.identity.options.get('UCI_Elo');
        const clamped = Math.max(range?.min ?? 1320, Math.min(range?.max ?? 3190, elo));
        await opponent.setOption('UCI_LimitStrength', true);
        await opponent.setOption('UCI_Elo', clamped);
        out(`Sparring partner: ${opponent.identity.name} at ${clamped} Elo. You are ${humanColor === 'w' ? 'White' : 'Black'}.`);
      } else {
        out(`Sparring partner: ${opponent.identity.name} (no strength limit available).`);
      }
    } else {
      out(`Analysis board with ${engine.identity.name}. You play both sides.`);
    }
    out('Type a move, ? for a hint, or quit.');
    out();

    const rl = lineReader();
    const engineMove = async (): Promise<void> => {
      if (!opponent || advisor.game.isGameOver()) return;
      // Feed the whole game, not just the FEN, so the engine sees repetitions.
      opponent.position(advisor.startFen, advisor.moves());
      const result = await opponent.go({ movetime: 700 });
      if (!result.bestmove) return;
      const r = await advisor.play(result.bestmove);
      out(`  Engine plays ${r.san}`);
    };

    const gameOverNote = (): boolean => {
      const g = advisor.game;
      if (!g.isGameOver()) return false;
      if (g.isCheckmate()) out(`Checkmate. ${g.turn() === 'w' ? 'Black' : 'White'} wins.`);
      else out('Draw.');
      return true;
    };

    try {
      printBoard(advisor);
      if (humanColor === 'b') { await engineMove(); printBoard(advisor); }

      for (;;) {
        const side = advisor.turn() === 'w' ? 'White' : 'Black';
        const raw = await rl.next(`${side}> `);
        if (raw === null) break;
        const line = raw.trim();
        if (!line) continue;
        const [cmd, arg] = line.split(/\s+/, 2);
        if (cmd === 'quit' || cmd === 'exit') break;
        if (cmd === '?' || cmd === 'hint') { printAnalysis(await advisor.analyse()); continue; }
        if (cmd === 'board') { printBoard(advisor); continue; }
        if (cmd === 'fen') { out(advisor.fen()); continue; }
        if (cmd === 'pgn') { out(advisor.game.pgn()); continue; }
        if (cmd === 'depth') { advisor.limits = { depth: num(arg, 18) }; out(`depth ${advisor.limits.depth}`); continue; }
        if (cmd === 'multipv') { advisor.multipv = num(arg, 3); out(`multipv ${advisor.multipv}`); continue; }
        if (cmd === 'new') { advisor.reset(); printBoard(advisor); if (humanColor === 'b') { await engineMove(); printBoard(advisor); } continue; }
        if (cmd === 'undo') {
          advisor.undo();
          if (opponent && advisor.turn() !== humanColor) advisor.undo();
          printBoard(advisor);
          continue;
        }
        if (cmd === 'summary') {
          const s = advisor.summary();
          out(`White accuracy ${s.w.accuracy.toFixed(1)}%   Black accuracy ${s.b.accuracy.toFixed(1)}%`);
          continue;
        }
        let report: MoveReport;
        try {
          report = await advisor.play(line);
        } catch {
          out(`  Not a legal move or command: "${line}"`);
          continue;
        }
        printReport(report);
        if (gameOverNote()) continue;
        if (opponent) {
          await engineMove();
          printBoard(advisor);
          gameOverNote();
        }
      }
    } finally {
      rl.close();
      if (opponent) await opponent.quit();
      if (advisor.reports.length) {
        const s = advisor.summary();
        out();
        out(`White accuracy ${s.w.accuracy.toFixed(1)}%   Black accuracy ${s.b.accuracy.toFixed(1)}%`);
      }
    }
  });
}

async function review(args: Args): Promise<void> {
  const max = num(args.flags.max, 1);
  let games: string[];
  if (typeof args.flags.lichess === 'string') {
    games = await fetchLichessGames(args.flags.lichess, { max });
  } else if (typeof args.flags.chesscom === 'string') {
    games = await fetchChesscomGames(args.flags.chesscom, {
      max,
      year: args.flags.year !== undefined ? num(args.flags.year, 0) : undefined,
      month: args.flags.month !== undefined ? num(args.flags.month, 0) : undefined,
    });
  } else {
    const file = args.positional[1];
    if (!file) throw new Error('review needs a PGN file, --lichess <user>, or --chesscom <user>');
    const text = file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
    games = splitPgn(text).slice(0, max);
  }
  if (!games.length) throw new Error('no games found');

  await withEngine(engineSpec(args), async (engine) => {
    for (const pgn of games) {
      const r = await reviewPgn(pgn, {
        ...advisorOptions(args, engine),
        onMove: (_report, i, total) => {
          if (process.stderr.isTTY) process.stderr.write(`\r  analysing ${i + 1}/${total}`);
        },
      });
      if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');
      out(formatReview(r));
      out();
    }
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.positional[0] ?? 'play';
  if (args.flags.help || mode === 'help') {
    out(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].split('\n').slice(2).map((l) => l.replace(/^ \* ?/, '')).join('\n'));
    return;
  }
  if (mode === 'play' || mode === 'spar') await interactive(args, mode);
  else if (mode === 'review') await review(args);
  else throw new Error(`unknown mode "${mode}"; try play, spar, review, or --help`);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
