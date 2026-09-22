/**
 * Minimal UCI client over a line transport.
 *
 * The transport is a child process in Node (`node-process.ts`: a native Stockfish binary, or
 * the WASM build from the `stockfish` npm package, which reads stdin and writes stdout exactly
 * like the native engine) or a Web Worker in the browser (`browser.ts`). This file has no
 * platform imports so the same client runs in both. One search at a time; `go` resolves on
 * `bestmove`.
 */

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
  /** Set when the score is an aspiration-window bound rather than an exact value. */
  bound?: 'lower' | 'upper';
  pv: string[];
  wdl?: [number, number, number];
}

export interface SearchOutcome {
  /** `null` when the engine reports `(none)`: no legal moves. */
  bestmove: string | null;
  ponder?: string;
    /** The engine's final ranking, one line per MultiPV slot, best first. */
  lines: SearchLine[];
  /** The shallowest depth among `lines`: the depth to which the whole ranking is settled. */
  depth: number;
  nodes: number;
  timeMs: number;
}

/**
 * Pick the lines to report from the engine's last print batch.
 *
 * Stockfish reprints every MultiPV slot each time one finishes, in its current ranking. Mid
 * iteration that batch mixes depths (slot 1 at depth D+1, the rest still at D with re-sorted
 * order), which is exactly why grouping lines by depth is wrong: the depth-D slots get
 * overwritten with the new order and one move lands in two slots. The latest batch is the
 * ranking `bestmove` comes from, so it is the truth. Moves are deduplicated as a guard,
 * `bestmove` is put first if the batch disagrees, and ranks are renumbered.
 */
export function selectLines(snapshot: SearchLine[], bestmove: string | null): { lines: SearchLine[]; depth: number } {
  const ordered = [...snapshot].sort((a, b) => a.multipv - b.multipv);
  const seen = new Set<string>();
  let lines = ordered.filter((l) => { const m = l.pv[0]; if (seen.has(m)) return false; seen.add(m); return true; });
  if (bestmove && lines.length && lines[0].pv[0] !== bestmove) {
    const i = lines.findIndex((l) => l.pv[0] === bestmove);
    if (i > 0) lines = [lines[i], ...lines.slice(0, i), ...lines.slice(i + 1)];
  }
  lines = lines.map((l, i) => ({ ...l, multipv: i + 1 }));
  const depth = lines.length ? Math.min(...lines.map((l) => l.depth)) : 0;
  return { lines, depth };
}

/** A line-oriented duplex channel to an engine. */
export interface UciTransport {
  send(line: string): void;
  /** Called once per output line. */
  onLine(cb: (line: string) => void): void;
  /** Called if the engine dies unexpectedly. */
  onExit(cb: (err: Error) => void): void;
  /** Tear down after `quit` has been sent (or when the engine is unresponsive). */
  close(): Promise<void>;
}

type Listener = (line: string) => void;

const EXIT = '\u0000exit';

export class UciEngine {
  readonly identity: EngineIdentity;
  private readonly transport: UciTransport;
  private listeners: Listener[] = [];
  private searching = false;
  private closed = false;
  private quitting = false;
  private exitError: Error | null = null;

  private constructor(transport: UciTransport) {
    this.transport = transport;
    this.identity = { name: '', author: '', options: new Map() };
  }

  /** Complete the UCI handshake over `transport` and return a ready engine. */
  static async connect(transport: UciTransport): Promise<UciEngine> {
    const engine = new UciEngine(transport);
    transport.onLine((line) => { for (const l of [...engine.listeners]) l(line); });
    transport.onExit((err) => {
      engine.closed = true;
      if (!engine.quitting) {
        engine.exitError = err;
        for (const l of [...engine.listeners]) l(EXIT);
      }
    });
    await engine.handshake();
    return engine;
  }

  private send(cmd: string): void {
    if (this.closed) throw this.exitError ?? new Error('engine is closed');
    this.transport.send(cmd);
  }

  private listen(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter((l) => l !== listener); };
  }

  private waitFor(pred: (line: string) => boolean, onLine?: Listener): Promise<string> {
    return new Promise((resolve, reject) => {
      const off = this.listen((line) => {
        if (line === EXIT) { off(); reject(this.exitError); return; }
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
   * Run one search. MultiPV must have been set via `setOption` beforehand. Lines are the
   * engine's final ranking (see `selectLines`).
   */
  async go(limits: GoLimits, onInfo?: (info: InfoLine) => void): Promise<SearchOutcome> {
    if (this.searching) throw new Error('a search is already running');
    this.searching = true;

    const snapshot = new Map<number, SearchLine>();
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
      // A bound line still carries the current ranking, so it replaces the slot; the score is
      // marked approximate and an exact print for the slot normally follows.
      const slot = info.multipv ?? 1;
      snapshot.set(slot, {
        multipv: slot, depth: info.depth, seldepth: info.seldepth, score: info.score,
        bound: info.bound, pv: info.pv, wdl: info.wdl,
      });
    });

    try {
      this.send(parts.join(' '));
      const best = await done;
      const [, bm, , ponder] = best.split(/\s+/);
      const bestmove = bm === '(none)' || bm === undefined ? null : bm;
      const { lines, depth } = selectLines([...snapshot.values()], bestmove);
      return { bestmove, ponder, lines, depth, nodes, timeMs };
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
    try { this.send('quit'); } catch { /* already gone */ }
    this.closed = true;
    await this.transport.close();
  }
}
