/**
 * Live move trainer. Two Stockfish workers: one at full strength analysing every position the
 * moment it appears (MultiPV candidates, trap detection, grading of the move just played), one
 * strength-limited as the opponent. All state lives in the Advisor; this file is rendering and
 * input.
 */

import { Chess } from 'chess.js';
import { Advisor, AnalysisAborted, formatScore, openWorkerEngine, winPct } from '@4wc/advisor/browser';
import type { Analysis, Candidate, InfoLine, MoveReport, UciEngine } from '@4wc/advisor/browser';
import { Board } from './board.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

type Mode = 'engine' | 'both';
type Hints = 'ask' | 'always';

/**
 * Depth of the "glance" search behind trap detection. Stockfish sees through most classic
 * baits by depth 6, which is exactly why they are traps for humans and not for engines; 4 is
 * about what a club player calculates when a capture looks free.
 */
const TRAP_DEPTH = 4;

const settings = {
  mode: 'engine' as Mode,
  color: 'w' as 'w' | 'b',
  elo: 1500,
  hints: 'ask' as Hints,
  traps: true,
  thinkMs: 1000,
  multipv: 3,
};

const DEBUG = new URLSearchParams(location.search).has('debug');
const debug = (...args: unknown[]): void => { if (DEBUG) console.log('[trainer]', ...args); };

let analyser: UciEngine;
let opponent: UciEngine;
let advisor: Advisor;
let board: Board;
let hintRevealedFor: string | null = null;
let engineThinking = false;
let analysisGen = 0;
let partial: Map<number, { uci: string; san: string; score: string; pct: number; pv: string; depth: number }> = new Map();

function humanToMove(): boolean {
  return settings.mode === 'both' || advisor.turn() === settings.color;
}

function setStatus(s: string): void { $('status').textContent = s; }

// ---------- rendering ----------

function renderEvalBar(a: Analysis | null): void {
  const pctWhite = a ? (a.turn === 'w' ? a.winPct : 100 - a.winPct) : 50;
  ($('evalbar').firstElementChild as HTMLElement).style.height = `${pctWhite}%`;
}

function hintsVisible(): boolean {
  if (settings.hints === 'always') return true;
  return hintRevealedFor === advisor.fen();
}

function candidateRow(c: { rank: number; san: string; score: string; pct: number; pv: string }, uci: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'cand';
  row.innerHTML =
    `<span class="rank">${c.rank}</span><span class="san">${c.san}</span>` +
    `<span class="score">${c.score}</span><span class="bar"><i style="width:${c.pct}%"></i></span>` +
    `<span class="pv">${c.pct.toFixed(0)}% · ${c.pv}</span>`;
  row.title = 'Show on board';
  row.addEventListener('click', () => {
    board.setMarks({ ...currentMarks(), arrow: { from: uci.slice(0, 2), to: uci.slice(2, 4) } });
  });
  return row;
}

function renderAnalysis(a: Analysis | null): void {
  const box = $('analysis');
  const trapbox = $('trapbox');
  box.replaceChildren();
  trapbox.replaceChildren();
  $('depth').textContent = a ? `depth ${a.depth}` : '';
  renderEvalBar(a);

  if (!a) { box.innerHTML = '<div class="hidden">Analysing…</div>'; return; }
  if (a.gameOver) {
    box.innerHTML = `<div class="hidden">${advisor.game.isCheckmate() ? 'Checkmate.' : 'Draw.'}</div>`;
    return;
  }

  const show = hintsVisible() || !humanToMove();
  if (show) {
    for (const c of a.candidates) {
      box.appendChild(candidateRow({
        rank: c.rank, san: c.san, score: formatScore(c.score), pct: c.winPct, pv: c.pvSan.slice(0, 6).join(' '),
      }, c.uci));
    }
    if (a.onlyMove) box.insertAdjacentHTML('beforeend', '<div class="note">Only move: everything else gives up a lot.</div>');
    else if (a.criticality >= 5) box.insertAdjacentHTML('beforeend', `<div class="note">Critical: the best move is worth ${a.criticality.toFixed(0)} points more than the next.</div>`);
    for (const t of a.traps) {
      trapbox.insertAdjacentHTML('beforeend',
        `<div class="trap"><b>Trap: ${t.san}</b> looks like ${formatScore(t.shallowScore)} at a glance but is ${formatScore(t.deepScore)}` +
        `${t.refutationSan ? ` after ${t.refutationSan}` : ''}.</div>`);
    }
    if (a.best && hintsVisible()) {
      board.setMarks({ ...currentMarks(), arrow: { from: a.best.uci.slice(0, 2), to: a.best.uci.slice(2, 4) } });
    }
  } else {
    box.innerHTML = `<div class="hidden">Hints hidden. Press <b>Show hint</b> to see the engine's candidates for this position.` +
      ` Eval ${formatScore(a.scoreWhite)} for White.</div>`;
    if (settings.traps && a.traps.length) {
      trapbox.innerHTML = `<div class="trap"><b>Careful.</b> A natural-looking move here loses ${a.traps[0].drop.toFixed(0)}+ points of win probability.</div>`;
    }
  }
}

function renderPartial(): void {
  if (!humanToMove() || !hintsVisible()) return;
  const box = $('analysis');
  box.replaceChildren();
  // Slots shuffle between iterations, so the same move can sit in two slots at different
  // depths for a moment; keep the deepest report per move.
  const byMove = new Map<string, { uci: string; san: string; score: string; pct: number; pv: string; depth: number }>();
  for (const l of partial.values()) {
    const prev = byMove.get(l.uci);
    if (!prev || prev.depth < l.depth) byMove.set(l.uci, l);
  }
  const lines = [...byMove.values()].sort((x, y) => y.pct - x.pct);
  lines.forEach((l, i) => box.appendChild(candidateRow({ rank: i + 1, san: l.san, score: l.score, pct: l.pct, pv: l.pv }, l.uci)));
  $('depth').textContent = lines.length ? `depth ${lines[0].depth}…` : '';
}

function verdict(r: MoveReport | null): void {
  const v = $('verdict');
  v.className = r ? r.classification : '';
  const tag = v.querySelector('.tag')!;
  const msg = v.querySelector('.msg')!;
  if (!r) { tag.textContent = 'Ready'; msg.textContent = 'Make a move. Every move you play is graded live against Stockfish.'; return; }
  const who = r.color === 'w' ? 'White' : 'Black';
  tag.textContent = r.classification;
  let text = `${who} ${r.san}: `;
  if (r.classification === 'best') text += 'the engine\'s top choice.';
  else if (r.classification === 'good') text += `fine. Best was ${r.bestSan}.`;
  else text += `lost ${r.loss.toFixed(0)} points of win probability. Best was ${r.bestSan}.`;
  if (r.fellForTrap) text += ' You fell for the trap.';
  if (r.rank && r.rank > 1) text += ` (Ranked #${r.rank}.)`;
  msg.textContent = text;
}

function renderMoves(): void {
  const el = $('moves');
  el.replaceChildren();
  const rs = advisor.reports;
  for (let i = 0; i < rs.length; i += 2) {
    const n = document.createElement('span'); n.className = 'n'; n.textContent = `${rs[i].moveNumber}.`;
    el.appendChild(n);
    for (const r of [rs[i], rs[i + 1]]) {
      const m = document.createElement('span');
      m.className = 'm' + (r ? ` ${r.classification}` : '');
      if (r) {
        m.textContent = r.san + ({ best: '', good: '', inaccuracy: '?!', mistake: '?', blunder: '??' })[r.classification];
        m.title = `${r.classification}, lost ${r.loss.toFixed(0)}%${r.bestSan && r.classification !== 'best' ? `, best ${r.bestSan}` : ''}`;
      }
      el.appendChild(m);
    }
  }
  el.scrollTop = el.scrollHeight;

  const s = advisor.summary();
  $('accw').textContent = s.w.moves ? `${s.w.accuracy.toFixed(0)}%` : '–';
  $('accb').textContent = s.b.moves ? `${s.b.accuracy.toFixed(0)}%` : '–';

  // Win-probability graph, White's perspective, one point per ply.
  const g = $('graph');
  const pts = rs.map((r) => (r.color === 'w' ? r.winPctAfter : 100 - r.winPctAfter));
  const w = 300, h = 70;
  const step = pts.length > 1 ? w / (pts.length - 1) : w;
  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)} ${(h - (p / 100) * h).toFixed(1)}`).join(' ');
  g.innerHTML =
    `<rect x="0" y="0" width="${w}" height="${h}" fill="#26292e"/>` +
    `<rect x="0" y="${h / 2}" width="${w}" height="${h / 2}" fill="#3a3f47"/>` +
    (pts.length ? `<path d="${path} L${((pts.length - 1) * step).toFixed(1)} ${h} L0 ${h} Z" fill="rgba(243,245,248,.85)"/>` : '') +
    `<line x1="0" y1="${h / 2}" x2="${w}" y2="${h / 2}" stroke="rgba(255,201,61,.7)" stroke-width="1"/>`;
}

function currentMarks(): { lastMove?: { from: string; to: string }; check?: string } {
  const hist = advisor.game.history({ verbose: true });
  const last = hist.at(-1);
  let check: string | undefined;
  if (advisor.game.inCheck()) {
    const turn = advisor.game.turn();
    for (const row of advisor.game.board()) for (const p of row) if (p && p.type === 'k' && p.color === turn) check = p.square;
  }
  return { lastMove: last ? { from: last.from, to: last.to } : undefined, check };
}

function renderBoard(): void {
  board.setMarks(currentMarks());
}

// ---------- game flow ----------
//
// Every operation that touches the advisor or the engines runs through one queue, so a new
// game, a move, an undo and an analysis never overlap. `ucinewgame` sent mid-search stalls
// the WASM worker, and two analyses in flight would race each other's rendering.

let queue: Promise<unknown> = Promise.resolve();
let lastAnalysis: Analysis | null = null;

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const p = queue.then(fn);
  queue = p.catch(() => undefined);
  return p;
}

async function analyseCurrent(): Promise<Analysis | null> {
  const gen = ++analysisGen;
  partial = new Map();
  lastAnalysis = null;
  renderAnalysis(null);
  debug('analyse start', gen, advisor.fen());
  let a: Analysis;
  try {
    a = await advisor.analyse();
  } catch (err) {
    if (err instanceof AnalysisAborted) { debug('analyse aborted', gen); return null; }
    throw err;
  }
  debug('analyse done', gen, analysisGen, a.depth, a.candidates.map((c) => c.san), 'traps', a.traps.map((t) => t.san));
  if (gen !== analysisGen) return null;
  lastAnalysis = a;
  renderAnalysis(a);
  return a;
}

async function engineMove(): Promise<void> {
  engineThinking = true;
  setStatus(`Opponent thinking at ${settings.elo} Elo…`);
  // The opponent picks its move while the analyser looks at the same position.
  const analysing = analyseCurrent();
  opponent.position(advisor.startFen, advisor.moves());
  const r = await opponent.go({ movetime: Math.min(settings.thinkMs, 1500) });
  const analysed = await analysing;
  engineThinking = false;
  setStatus('Stockfish ready.');
  if (!r.bestmove || !analysed) return; // game over, or a new game started meanwhile
  let report: MoveReport;
  try {
    report = await advisor.play(r.bestmove);
  } catch (err) {
    if (err instanceof AnalysisAborted) return;
    throw err;
  }
  hintRevealedFor = null;
  renderBoard();
  renderMoves();
  verdict(report);
  await analyseCurrent();
}

function onMove(from: string, to: string, promotion?: string): void {
  if (engineThinking || !humanToMove()) return;
  const uci = from + to + (promotion ?? '');
  debug('move queued', uci);
  void enqueue(async () => {
    if (!humanToMove()) return;
    let report: MoveReport;
    try {
      report = await advisor.play(uci);
    } catch (err) {
      debug('move rejected', uci, err);
      return; // aborted by a new game, or not legal any more
    }
    debug('move played', report.san, report.classification);
    hintRevealedFor = null;
    renderBoard();
    renderMoves();
    verdict(report);
    if (advisor.game.isGameOver()) { await analyseCurrent(); return; }
    if (settings.mode === 'engine') await engineMove();
    else await analyseCurrent();
  });
}

function newGame(fen?: string): Promise<void> {
  analysisGen++;
  advisor.abort();
  renderAnalysis(null);
  debug('new game queued', fen);
  return enqueue(async () => {
    debug('new game start', fen);
    advisor.reset(fen);
    hintRevealedFor = null;
    board.clearSelection();
    board.setFlipped(settings.mode === 'engine' && settings.color === 'b');
    renderBoard();
    renderMoves();
    verdict(null);
    await opponent.newGame();
    await analyser.newGame();
    if (settings.mode === 'engine' && advisor.turn() !== settings.color) await engineMove();
    else await analyseCurrent();
  });
}

function undo(): Promise<void> {
  if (engineThinking) return Promise.resolve();
  analysisGen++;
  advisor.abort();
  return enqueue(async () => {
    advisor.undo();
    if (settings.mode === 'engine' && advisor.turn() !== settings.color) advisor.undo();
    hintRevealedFor = null;
    board.clearSelection();
    renderBoard();
    renderMoves();
    verdict(advisor.reports.at(-1) ?? null);
    await analyseCurrent();
  });
}

/** Re-analyse after a settings change, without disturbing a game in progress. */
function reanalyse(): Promise<void> {
  analysisGen++;
  advisor.abort();
  return enqueue(async () => { await analyseCurrent(); });
}

function showHint(): void {
  hintRevealedFor = advisor.fen();
  if (lastAnalysis && lastAnalysis.fen === advisor.fen()) renderAnalysis(lastAnalysis);
  else renderPartial();
}

// ---------- controls ----------

function seg(id: string, onChange: (v: string) => void): void {
  const root = $(id);
  root.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    for (const x of root.querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
    onChange(b.dataset.v!);
  });
}

function applyEngineSettings(): void {
  advisor.multipv = settings.multipv;
  advisor.limits = { movetime: settings.thinkMs };
  advisor.trapDepth = settings.traps ? TRAP_DEPTH : 0;
}

async function main(): Promise<void> {
  const game = new Chess();
  board = new Board(game, {
    onMove: (from, to, promotion) => {
      onMove(from, to, promotion);
      return true;
    },
    canPick: (sq) => {
      if (engineThinking || !humanToMove()) return false;
      const p = advisor.game.get(sq as never);
      return !!p && p.color === advisor.game.turn();
    },
  });
  $('board').appendChild(board.svg);

  setStatus('Loading Stockfish…');
  [analyser, opponent] = await Promise.all([openWorkerEngine('vendor/stockfish.js'), openWorkerEngine('vendor/stockfish.js')]);
  await opponent.setOption('UCI_LimitStrength', true);
  await opponent.setOption('UCI_Elo', settings.elo);
  if (analyser.hasOption('UCI_ShowWDL')) await analyser.setOption('UCI_ShowWDL', true);
  setStatus(`${analyser.identity.name} ready.`);

  advisor = new Advisor({
    engine: analyser,
    multipv: settings.multipv,
    limits: { movetime: settings.thinkMs },
    trapDepth: TRAP_DEPTH,
    onInfo: (info: InfoLine, fen: string) => {
      if (fen !== advisor.fen() || !info.pv?.length || !info.score || info.bound) return;
      const c = new Chess(fen);
      let san = info.pv[0];
      let pv = '';
      try {
        const sans: string[] = [];
        for (const u of info.pv.slice(0, 6)) sans.push(c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san);
        san = sans[0];
        pv = sans.join(' ');
      } catch { /* partial pv */ }
      partial.set(info.multipv ?? 1, { uci: info.pv[0], san, score: formatScore(info.score), pct: winPct(info.score), pv, depth: info.depth ?? 0 });
      renderPartial();
    },
  });
  // The board renders the advisor's game, not the placeholder it was constructed with.
  (board as unknown as { game: Chess }).game = advisor.game;

  seg('mode', (v) => { settings.mode = v as Mode; $('elo-row').style.display = $('color-row').style.display = v === 'engine' ? '' : 'none'; void newGame(); });
  seg('color', (v) => { settings.color = v as 'w' | 'b'; void newGame(); });
  seg('hints', (v) => { settings.hints = v as Hints; renderBoard(); if (lastAnalysis) renderAnalysis(lastAnalysis); });
  $('elo').addEventListener('change', async (e) => {
    settings.elo = Number((e.target as HTMLInputElement).value);
    await opponent.setOption('UCI_Elo', settings.elo);
  });
  $('traps').addEventListener('change', (e) => { settings.traps = (e.target as HTMLInputElement).checked; applyEngineSettings(); void reanalyse(); });
  $('think').addEventListener('change', (e) => { settings.thinkMs = Math.round(Number((e.target as HTMLInputElement).value) * 1000); applyEngineSettings(); });
  $('multipv').addEventListener('change', (e) => { settings.multipv = Number((e.target as HTMLInputElement).value); applyEngineSettings(); void reanalyse(); });
  $('new').addEventListener('click', () => void newGame());
  $('undo').addEventListener('click', () => void undo());
  $('flip').addEventListener('click', () => board.setFlipped(!board.isFlipped()));
  $('hint').addEventListener('click', showHint);
  $<HTMLInputElement>('fen').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const fen = (e.target as HTMLInputElement).value.trim();
    try { new Chess(fen); } catch { setStatus('That FEN is not valid.'); return; }
    void newGame(fen);
  });
  $('copypgn').addEventListener('click', () => {
    void navigator.clipboard.writeText(advisor.game.pgn()).then(() => setStatus('PGN copied.'));
  });

  // For tests and debugging from the console.
  (window as unknown as { __trainer: unknown }).__trainer = {
    advisor, settings, get last() { return lastAnalysis; }, get gen() { return analysisGen; },
  };
  await newGame();
}

main().catch((err: unknown) => setStatus(`Failed to start: ${err instanceof Error ? err.message : String(err)}`));
