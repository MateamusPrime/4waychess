/**
 * Minimal UCI client over a child process.
 *
 * Works unchanged against a native Stockfish binary and against the WASM build from the
 * `stockfish` npm package (which, run under Node, reads stdin and writes stdout exactly like
 * the native engine). One search at a time; `go` resolves on `bestmove`.
 */

import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export type Score = { type: 'cp'; value: number } | { type: 'mate'; value: number };

export interface InfoLine {
  depth?: number;
  seldepth?: number;
  multipv?: number;
  score?: Score;
  bound?: 'lower' | 'upper';
  nodes?: number;
  nps?: number;
  time?: number;
  hashfull?: number;
  /** Win/draw/loss per mille, side to move, when UCI_ShowWDL is on. */
  wdl?: [number, number, number];
  pv?: string[];
  string?: string;
}

const NUMERIC = new Set(['depth', 'seldepth', 'multipv', 'nodes', 'nps', 'time', 'hashfull']);

/** Parse one `info ...` line. Returns null for lines that are not info lines. */
export function parseInfo(line: string): InfoLine | null {
  const t = line.trim().split(/\s+/);
  if (t[0] !== 'info') return null;
  const out: InfoLine = {};
  for (let i = 1; i < t.length; i++) {
    const key = t[i];
    if (NUMERIC.has(key)) {
      (out as Record<string, unknown>)[key] = Number(t[++i]);
    } else if (key === 'score') {
      const kind = t[++i];
      const value = Number(t[++i]);
      if (kind === 'cp' || kind === 'mate') out.score = { type: kind, value };
      if (t[i + 1] === 'lowerbound') { out.bound = 'lower'; i++; }
      else if (t[i + 1] === 'upperbound') { out.bound = 'upper'; i++; }
    } else if (key === 'wdl') {
      out.wdl = [Number(t[i + 1]), Number(t[i + 2]), Number(t[i + 3])];
      i += 3;
    } else if (key === 'pv') {
      out.pv = t.slice(i + 1);
      break;
    } else if (key === 'string') {
      out.string = t.slice(i + 1).join(' ');
      break;
    } else if (key === 'currmove' || key === 'currmovenumber' || key === 'cpuload') {
      i++;
    }
    // refutation / currline are not used and never emitted by Stockfish by default.
  }
  return out;
}

export interface UciOption {
  name: string;
  type: string;
  default?: string;
  min?: number;
  max?: number;
}

export function parseOption(line: string): UciOption | null {
  const m = /^option name (.+?) type (\S+)(?: default ?(.*?))?(?: min (-?\d+))?(?: max (-?\d+))?$/.exec(line.trim());
  if (!m) return null;
  const opt: UciOption = { name: m[1], type: m[2] };
  if (m[3] !== undefined) opt.default = m[3];
  if (m[4] !== undefined) opt.min = Number(m[4]);
  if (m[5] !== undefined) opt.max = Number(m[5]);
  return opt;
}

export interface EngineIdentity {
  name: string;
  author: string;
  options: Map<string, UciOption>;
}

export interface GoLimits {
  depth?: number;
  movetime?: number;
  nodes?: number;
}

/** One principal variation as finally reported for a search. */
export interface SearchLine {
  multipv: number;
  depth: number;
  seldepth?: number;
  /** From the side to move's perspective, as UCI specifies. */
  score: Score;
  pv: string[];
  wdl?: [number, number, number];
}

export interface SearchOutcome {
  /** `null` when the engine reports `(none)`: no legal moves. */
  bestmove: string | null;
  ponder?: string;
  /** Sorted by multipv rank, all from the deepest fully reported iteration. */
  lines: SearchLine[];
  depth: number;
  nodes: number;
  timeMs: number;
}

type Proc = ChildProcessByStdio<Writable, Readable, null>;
type Listener = (line: string) => void;

export class UciEngine {
  readonly proc: Proc;
  readonly identity: EngineIdentity;
  /** Every line the engine has printed, kept for debugging. Bounded. */
  private listeners: Listener[] = [];
  private searching = false;
  private closed = false;
  private exitError: Error | null = null;

  private constructor(proc: Proc, identity: EngineIdentity) {
    this.proc = proc;
    this.identity = identity;
  }

  /** Spawn `command args...`, complete the UCI handshake, and return a ready engine. */
  static async spawn(command: string, args: string[] = []): Promise<UciEngine> {
    const proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
    const identity: EngineIdentity = { name: '', author: '', options: new Map() };
    const engine = new UciEngine(proc, identity);

    const rl = createInterface({ input: proc.stdout });
    rl.on('line', (line) => { for (const l of [...engine.listeners]) l(line); });
    proc.on('exit', (code, signal) => {
      engine.closed = true;
      if (!engine.quitting) {
        engine.exitError = new Error(`engine exited (code ${code}, signal ${signal})`);
        for (const l of [...engine.listeners]) l('\u0000exit');
      }
    });
    proc.on('error', (err) => {
      engine.closed = true;
      engine.exitError = err;
      for (const l of [...engine.listeners]) l('\u0000exit');
    });

    await engine.handshake();
    return engine;
  }

  private quitting = false;

  private send(cmd: string): void {
    if (this.closed) throw this.exitError ?? new Error('engine is closed');
    this.proc.stdin.write(cmd + '\n');
  }

  private listen(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter((l) => l !== listener); };
  }

  private waitFor(pred: (line: string) => boolean, onLine?: Listener): Promise<string> {
    return new Promise((resolve, reject) => {
      const off = this.listen((line) => {
        if (line === '\u0000exit') { off(); reject(this.exitError); return; }
        onLine?.(line);
        if (pred(line)) { off(); resolve(line); }
      });
    });
  }

  private async handshake(): Promise<void> {
    const done = this.waitFor((l) => l === 'uciok', (line) => {
      if (line.startsWith('id name ')) this.identity.name = line.slice(8);
      else if (line.startsWith('id author ')) this.identity.author = line.slice(10);
      else if (line.startsWith('option name ')) {
        const opt = parseOption(line);
        if (opt) this.identity.options.set(opt.name, opt);
      }
    });
    this.send('uci');
    await done;
    await this.isReady();
  }

  hasOption(name: string): boolean {
    return this.identity.options.has(name);
  }

  async setOption(name: string, value: string | number | boolean): Promise<void> {
    this.send(`setoption name ${name} value ${value}`);
    await this.isReady();
  }

  /** Press a `button`-type option such as `Clear Hash`. */
  async pressButton(name: string): Promise<void> {
    this.send(`setoption name ${name}`);
    await this.isReady();
  }

  async isReady(): Promise<void> {
    const done = this.waitFor((l) => l === 'readyok');
    this.send('isready');
    await done;
  }

  async newGame(): Promise<void> {
    this.send('ucinewgame');
    await this.isReady();
  }

  /** `fen` may be a FEN string or `'startpos'`. */
  position(fen: string, moves: string[] = []): void {
    const base = fen === 'startpos' ? 'startpos' : `fen ${fen}`;
    this.send(moves.length ? `position ${base} moves ${moves.join(' ')}` : `position ${base}`);
  }

  /**
   * Run one search. MultiPV must have been set via `setOption` beforehand. Lines come from the
   * deepest iteration at which every MultiPV slot reported, so ranks are mutually comparable.
   */
  async go(limits: GoLimits, onInfo?: (info: InfoLine) => void): Promise<SearchOutcome> {
    if (this.searching) throw new Error('a search is already running');
    this.searching = true;

    const byDepth = new Map<number, Map<number, SearchLine>>();
    let maxSlot = 1;
    let nodes = 0;
    let timeMs = 0;

    const parts: string[] = ['go'];
    if (limits.depth !== undefined) parts.push('depth', String(limits.depth));
    if (limits.movetime !== undefined) parts.push('movetime', String(limits.movetime));
    if (limits.nodes !== undefined) parts.push('nodes', String(limits.nodes));
    if (parts.length === 1) throw new Error('go requires a depth, movetime or nodes limit');

    const done = this.waitFor((l) => l.startsWith('bestmove'), (line) => {
      const info = parseInfo(line);
      if (!info) return;
      onInfo?.(info);
      if (info.nodes !== undefined) nodes = info.nodes;
      if (info.time !== undefined) timeMs = info.time;
      if (info.depth === undefined || info.score === undefined || !info.pv?.length) return;
      if (info.bound) return; // aspiration-window fail high/low: not a real score
      const slot = info.multipv ?? 1;
      if (slot > maxSlot) maxSlot = slot;
      let at = byDepth.get(info.depth);
      if (!at) { at = new Map(); byDepth.set(info.depth, at); }
      at.set(slot, {
        multipv: slot, depth: info.depth, seldepth: info.seldepth, score: info.score,
        pv: info.pv, wdl: info.wdl,
      });
    });

    try {
      this.send(parts.join(' '));
      const best = await done;
      const [, bm, , ponder] = best.split(/\s+/);
      const depths = [...byDepth.keys()].sort((a, b) => b - a);
      let chosen = depths.find((d) => byDepth.get(d)!.size >= maxSlot) ?? depths[0];
      const lines = chosen === undefined
        ? []
        : [...byDepth.get(chosen)!.values()].sort((a, b) => a.multipv - b.multipv);
      // If the iteration we chose is stale for slot 1 relative to bestmove, trust bestmove.
      if (bm && bm !== '(none)' && lines.length && lines[0].pv[0] !== bm) {
        const newer = depths.map((d) => byDepth.get(d)!.get(1)).find((l) => l && l.pv[0] === bm);
        if (newer) lines[0] = newer;
      }
      return {
        bestmove: bm === '(none)' || bm === undefined ? null : bm,
        ponder,
        lines,
        depth: chosen ?? 0,
        nodes,
        timeMs,
      };
    } finally {
      this.searching = false;
    }
  }

  /** Stop the running search early; the pending `go` still resolves with what it has. */
  stop(): void {
    if (this.searching && !this.closed) this.send('stop');
  }

  async quit(): Promise<void> {
    if (this.closed) return;
    this.quitting = true;
    const exited = new Promise<void>((resolve) => this.proc.once('exit', () => resolve()));
    try { this.send('quit'); } catch { /* already gone */ }
    const timer = setTimeout(() => this.proc.kill(), 2000);
    await exited;
    clearTimeout(timer);
    this.closed = true;
  }
}
