/**
 * The web app: hotseat four-way chess.
 *
 * Everything decision-shaped lives in the tested packages — engine (rules), ui-core (what to
 * draw, input reducers), board-render (how to draw). This file is wiring: DOM chrome, pointer
 * and keyboard translation, the frame loop, and sound triggers. If something here starts
 * making gameplay decisions, it is in the wrong package.
 */

import {
  ARMIES, FFA_RULES, Game, TEAMS_RULES, checkingArmies, formatMove, serializeFen4, squareName,
  writePgn4,
} from '@4wc/engine';
import type { Army, Move, PieceType, Ruleset } from '@4wc/engine';
import {
  DEFAULT_SETTINGS, DURATION, INITIAL_INTERACTION, NO_ANIMS, SETTINGS_KEY, THEMES, THEME_IDS,
  add, buildScene, cancel, choosePromotion, clampCamera, computeLayout, defaultCursor,
  describeMove, describeTurn, hitTest, loadSettings, memoryStore, moveAnimFor, moveCursor,
  observeMove, prune, rotationSteps, saveSettings, tapSquare, zoomForComfortableTouch,
} from '@4wc/ui-core';
import type {
  AnimState, Camera, InteractionContext, InteractionState, ReplayState, Step, UserSettings,
} from '@4wc/ui-core';
import {
  atEnd, atStart, forEachPly, loadReplay, seek, step as replayStep, toEnd, toStart,
} from '@4wc/ui-core';
import { Canvas2DSurface, renderScene } from '@4wc/board-render';
import { PIECE_FILL_RULE, PIECE_PATHS, PIECE_VIEWBOX } from '@4wc/pieces';
import { PERSONALITIES, PERSONALITY_IDS, makeBot, wantsResign } from '@4wc/bots';
import type { Bot, Difficulty, PersonalityId } from '@4wc/bots';
import { localPersistence, storageKV } from '@4wc/store';
import type { GameRecord, Profile, SeatRecord } from '@4wc/store';
import { GameAudio } from './audio.ts';
import { computeHint, reviewItem } from './analysis.ts';
import type { AnalysisReply, AnalysisRequest, WireMove, WireVerdict } from './analysis.ts';

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

const store = (() => {
  try {
    localStorage.getItem(SETTINGS_KEY);
    return {
      get: (k: string) => localStorage.getItem(k),
      set: (k: string, v: string) => localStorage.setItem(k, v),
    };
  } catch {
    return memoryStore();
  }
})();

/**
 * Persistence: profile, settings and game history behind the @4wc/store ports.
 *
 * Guest-first (never gate the first game behind a form): a local guest identity is created on
 * boot, and when accounts arrive the cloud adapter implements the same bundle — the account
 * CLAIMS this guest id rather than replacing it, so pre-signup history survives signup.
 * `storageKV` swallows storage failures, so private browsing degrades to a session-only
 * profile instead of an exception.
 */
const persistence = localPersistence(storageKV(globalThis.localStorage ?? {
  getItem: () => null, setItem: () => {}, removeItem: () => {},
}), {
  now: () => Date.now(),
  random: () => Math.random(),
});
let profile: Profile | null = null;

/**
 * Replay mode. When set, the board renders a stored game instead of the live one and every
 * seat is view-only — the same InteractionContext machinery that already handles spectating,
 * so no new input path was needed.
 */
let replay: ReplayState | null = null;
let replayTitle = '';

let settings: UserSettings = loadSettings(store);
let game = Game.create(FFA_RULES);
let gameStartedAtMs = Date.now();
let gameSaved = false;
let seat: Army = 'red';
let interaction: InteractionState = INITIAL_INTERACTION;
let anims: AnimState = NO_ANIMS;
let camera: Camera = { zoom: 1, panX: 0, panY: 0 };
let checked: Army[] = [];
const audio = new GameAudio();
audio.enabled = settings.sound;

/**
 * Seat configuration. The default gives a solo player a game out of the box — the whole point
 * of Phase 2 — with three distinct temperaments at the table.
 */
type SeatKind = 'human' | PersonalityId;
const seatConfig: Record<Army, SeatKind> = {
  red: 'human', blue: 'aggressive', yellow: 'opportunist', green: 'turtle',
};
let botDifficulty: Difficulty = 'medium';
let bots: Partial<Record<Army, Bot>> = {};
let botTimer: number | null = null;
let seatSeeds: Record<Army, number> = { red: 1, blue: 2, yellow: 3, green: 4 };

/**
 * Bot search runs in a worker so seconds of deep thinking never freeze an animation. The
 * worker is compute only: it receives FEN4 and returns from/to/promotion, which the main
 * thread re-validates against its own legal moves. Falls back to in-thread search when
 * workers are unavailable (file:// contexts, some test harnesses).
 *
 * A second instance handles hints and game review, so reviewing a long game never delays
 * the next bot move. It is created on first use: most sessions never ask for either.
 */
let botWorker: Worker | null = null;
let botRequestId = 0;
try {
  botWorker = new Worker('dist/worker.js');
  botWorker.onmessage = (e: MessageEvent<AnalysisReply>) => onReply(e.data);
  botWorker.onerror = () => {
    botWorker = null; // sync fallback from here on
  };
} catch {
  botWorker = null;
}

let coachWorker: Worker | null | undefined; // undefined = not created yet
function coach(): Worker | null {
  if (coachWorker !== undefined) return coachWorker;
  try {
    coachWorker = new Worker('dist/worker.js');
    coachWorker.onmessage = (e: MessageEvent<AnalysisReply>) => onReply(e.data);
    coachWorker.onerror = () => {
      // A pending hint would otherwise never answer; later requests compute in-thread.
      coachWorker = null;
      hintPending = false;
      syncChrome();
    };
  } catch {
    coachWorker = null;
  }
  return coachWorker;
}

/** Send a coaching request to the coach worker, or compute it in-thread without one. */
function sendCoach(req: AnalysisRequest): void {
  const w = coach();
  if (w !== null) {
    w.postMessage(req);
    return;
  }
  if (req.type === 'hint') window.setTimeout(() => onReply(computeHint(req)), 0);
  else if (req.type === 'review') reviewInThread(req);
}

/**
 * The worker-less review path: one move per task, like the worker, so the page stays
 * responsive and a newer review (or closing the replay) stops the old one between moves.
 */
function reviewInThread(req: Extract<AnalysisRequest, { type: 'review' }>): void {
  let i = 0;
  const step = (): void => {
    if (review === null || review.id !== req.id) return;
    if (i >= req.items.length) {
      onReply({ type: 'review-done', id: req.id });
      return;
    }
    const item = req.items[i++];
    onReply({
      type: 'review-item', id: req.id, ply: item.ply, verdict: reviewItem(req.mode, item),
    });
    window.setTimeout(step, 0);
  };
  window.setTimeout(step, 0);
}

function onReply(msg: AnalysisReply): void {
  switch (msg.type) {
    case 'move': {
      if (msg.id !== botRequestId) return; // stale reply from a superseded game or turn
      if (game.result().over || game.pos.turn !== msg.army || msg.move === null) return;
      const legal = findLegal(msg.move);
      if (legal !== undefined) playMove(legal);
      return;
    }
    case 'hint':
      onHint(msg);
      return;
    case 'review-item':
      if (review === null || msg.id !== review.id) return;
      if (msg.verdict !== null) review.verdicts.set(msg.ply, msg.verdict);
      review.progress++;
      syncChrome();
      return;
    case 'review-done':
      if (review === null || msg.id !== review.id) return;
      review.done = true;
      banner(`Review complete — ${reviewSummary(review)}`, 3200);
      announce(`Review complete. ${reviewSummary(review)}.`);
      syncChrome();
      return;
  }
}

const findLegal = (m: WireMove): Move | undefined => game.legalMoves().find(
  (x) => x.from === m.from && x.to === m.to && x.promotion === m.promotion,
);

/* ------------------------------------------------------------------ *
 * Coaching: hints and game review
 * ------------------------------------------------------------------ */

/** The suggested move currently marked on the live board. Cleared by any move. */
let hint: { from: number; to: number } | null = null;
let hintRequestId = 0;
let hintPending = false;
/** The position a pending hint was asked for — a reply for any other position is dropped. */
let hintFen = '';

function requestHint(): void {
  if (replay !== null || game.result().over || !isHuman(game.pos.turn) || hintPending) return;
  hintPending = true;
  hintRequestId++;
  hintFen = serializeFen4(game.pos);
  sendCoach({ type: 'hint', id: hintRequestId, fen: hintFen, mode: game.rules.mode });
  syncChrome();
}

function onHint(msg: Extract<AnalysisReply, { type: 'hint' }>): void {
  if (msg.id !== hintRequestId) return;
  hintPending = false;
  if (replay === null && msg.move !== null && serializeFen4(game.pos) === hintFen) {
    const legal = findLegal(msg.move);
    if (legal !== undefined) {
      hint = { from: legal.from, to: legal.to };
      banner(`Hint: ${msg.text ?? ''}`);
      announce(`Hint: ${describeMove(game.pos, legal)}.`);
    }
  }
  syncChrome();
}

/**
 * Game review: every move a human played, graded against the engine's best at a fixed depth.
 * Always runs on a replay — a just-finished live game is opened as one — so stepping through
 * the verdicts, and the better move marked on the board, work the same for any stored game.
 */
interface ReviewState {
  id: number;
  total: number;
  progress: number;
  verdicts: Map<number, WireVerdict>;
  done: boolean;
}
let review: ReviewState | null = null;
let reviewRequestId = 0;
/** Human seats of the game in replay — the moves a review grades. */
let replaySeats: Army[] = [];

const GRADE_MARK: Record<WireVerdict['grade'], string> = {
  best: '', good: '', inaccuracy: '?!', mistake: '?', blunder: '??',
};
/** Inaccuracies, mistakes and blunders — the verdicts worth showing a better move for. */
const isError = (v: WireVerdict | undefined): boolean =>
  v !== undefined && (v.grade === 'inaccuracy' || v.grade === 'mistake' || v.grade === 'blunder');

function reviewSummary(r: ReviewState): string {
  const n = { best: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 };
  for (const v of r.verdicts.values()) n[v.grade]++;
  const plural = (k: number, one: string, many: string): string => `${k} ${k === 1 ? one : many}`;
  return [
    `${n.best} best`, `${n.good} good`,
    plural(n.inaccuracy, 'inaccuracy', 'inaccuracies'),
    plural(n.mistake, 'mistake', 'mistakes'),
    plural(n.blunder, 'blunder', 'blunders'),
  ].join(' · ');
}

function cancelReview(): void {
  if (review !== null && coachWorker) coachWorker.postMessage({ type: 'cancel' });
  review = null;
}

function startReview(): void {
  if (replay === null) {
    // A finished live game: open it as a replay first, from the human's seat.
    if (!game.result().over || humanSeats().length === 0) return;
    const r = game.result();
    const label = r.winners.length === 0 ? 'Draw' : `${r.winners.map(cap).join(' & ')} won`;
    const title = `This game — ${label} — ${r.reason}`;
    enterReplay(loadReplay(writePgn4(game)), humanSeats(), title);
  }
  const r = replay!;
  if (replaySeats.length === 0) {
    banner('No human moves to review');
    return;
  }
  const items: { ply: number; fen: string; move: WireMove }[] = [];
  forEachPly(r, (ply, before, m) => {
    if (!replaySeats.includes(before.turn)) return;
    items.push({
      ply, fen: serializeFen4(before), move: { from: m.from, to: m.to, promotion: m.promotion },
    });
  });
  cancelReview();
  reviewRequestId++;
  review = {
    id: reviewRequestId, total: items.length, progress: 0, verdicts: new Map(), done: false,
  };
  sendCoach({ type: 'review', id: reviewRequestId, mode: r.rules.mode, items });
  announce(`Reviewing ${items.length} moves.`);
  syncChrome();
}

/**
 * In a reviewed replay, the verdict on the move about to be played from the shown position.
 * The board shows the position BEFORE a mistake, so the better move can be marked on it.
 */
function upcomingVerdict(): WireVerdict | undefined {
  if (replay === null || review === null) return undefined;
  return review.verdicts.get(replay.ply);
}

function isHuman(a: Army): boolean {
  return seatConfig[a] === 'human';
}
function humanSeats(): Army[] {
  return ARMIES.filter(isHuman);
}
function rebuildBots(): void {
  bots = {};
  for (const a of ARMIES) {
    const kind = seatConfig[a];
    if (kind !== 'human') {
      const seed = (Date.now() ^ (ARMIES.indexOf(a) * 7919)) >>> 0;
      seatSeeds[a] = seed;
      bots[a] = makeBot(kind, botDifficulty, seed);
    }
  }
}

const canvas = document.getElementById('board') as HTMLCanvasElement;
const rawCtx = canvas.getContext('2d');
if (rawCtx === null) throw new Error('no 2d context');
const el = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

function theme() {
  return THEMES[settings.themeId];
}

function viewport() {
  const r = canvas.getBoundingClientRect();
  return { width: r.width, height: r.height };
}

function layout() {
  return computeLayout(viewport(), theme(), camera);
}

function ictx(): InteractionContext {
  // In replay the board shows a stored position and nothing is playable — reusing the
  // existing view-only path rather than inventing a second input mode.
  if (replay !== null) return { position: replay.position, seat, controllable: [] };
  // Only human seats are tappable; bot armies move themselves.
  return { position: game.pos, seat, controllable: game.result().over ? [] : humanSeats() };
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

let dpr = 1;

/**
 * Keep the canvas backing store in sync with its CSS rect and the device pixel ratio.
 *
 * Called every frame rather than only on resize events: the first layout can land after the
 * script runs (a hidden or restored tab reports a 0x0 rect at boot), and DPR changes when a
 * window moves between monitors. Comparing two integers per frame costs nothing and makes the
 * canvas self-healing in every one of those cases.
 */
function resize(): void {
  dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  const w = Math.round(r.width * dpr);
  const h = Math.round(r.height * dpr);
  if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
    canvas.width = w;
    canvas.height = h;
  }
}

const surface = new Canvas2DSurface(rawCtx as never, 1);

function frame(now: number): void {
  resize();
  anims = prune(anims, now);
  // The adapter applies DPR per frame via begin(); it is a plain field, updated here.
  (surface as unknown as { dpr: number }).dpr = dpr;
  const scene = buildScene({
    ctx: ictx(),
    layout: layout(),
    theme: theme(),
    interaction: replay === null
      ? interaction
      : { ...INITIAL_INTERACTION, lastMove: replay.lastMove },
    anims,
    now,
    colorblind: settings.colorblind,
    showCoords: settings.showCoords,
    checked: replay === null ? checked : [],
    hint: boardHint(),
  });
  renderScene(surface, scene, viewport(), { markers: settings.colorblind });
}

/** Live game: the requested hint. Reviewed replay: the better move at an upcoming mistake. */
function boardHint(): { from: number; to: number } | null {
  if (replay === null) return hint;
  const v = upcomingVerdict();
  return v !== undefined && isError(v) ? { from: v.best.from, to: v.best.to } : null;
}

/** The self-scheduling loop is separate from frame() so debug calls never fork extra loops. */
function loop(now: number): void {
  frame(now);
  requestAnimationFrame(loop);
}

/* ------------------------------------------------------------------ *
 * Game flow
 * ------------------------------------------------------------------ */

function announce(text: string): void {
  el('announcer').textContent = text;
}

function banner(text: string, ms = 2200): void {
  const b = el('banner');
  b.textContent = text;
  b.classList.add('show');
  window.setTimeout(() => b.classList.remove('show'), ms);
}

function refreshChecked(): void {
  checked = ARMIES.filter((a) => game.pos.isActive(a) && checkingArmies(game.pos, a).length > 0);
}

const moveTexts: { army: Army; text: string }[] = [];

function playMove(move: Move): void {
  const mover = game.pos.turn;
  const text = formatMove(game.pos, move);
  const spoken = describeMove(game.pos, move);
  const now = performance.now();

  const events = game.play(move);
  moveTexts.push({ army: mover, text });
  hint = null;

  if (!settings.reducedMotion) anims = add(anims, moveAnimFor(move, mover, now));
  audio.play(move.captured !== null ? 'capture' : 'move');

  for (const ev of events) {
    switch (ev.type) {
      case 'check': {
        const king = game.pos.kingSquare(ev.army);
        if (!settings.reducedMotion && king >= 0) {
          anims = add(anims, {
            kind: 'check', square: king, army: ev.army,
            startMs: now + DURATION.move, durationMs: DURATION.check,
          });
        }
        audio.play('check');
        break;
      }
      case 'checkmate':
        if (!settings.reducedMotion) {
          anims = add(anims, {
            kind: 'eliminate', army: ev.army, startMs: now + DURATION.move,
            durationMs: DURATION.eliminate,
          });
        }
        audio.play('eliminate');
        banner(`${cap(ev.army)} is checkmated${ev.other !== undefined ? ` — ${cap(ev.other)} +20` : ''}`);
        break;
      case 'stalemate':
        audio.play('eliminate');
        banner(`${cap(ev.army)} is stalemated — +20 to ${cap(ev.army)}`);
        break;
      case 'promotion':
        audio.play('promote');
        break;
      case 'multi-check':
        banner(`${cap(mover)} checks ${ev.detail ?? 'two players'} — +${ev.points}`);
        break;
      case 'end':
        audio.play('gameover');
        break;
      default:
        break;
    }
  }

  interaction = observeMove(interaction, move);
  refreshChecked();
  rotateToTurn(now + (settings.reducedMotion ? 0 : DURATION.move + 60));
  announce(`${spoken}. ${describeTurn(game.pos, checked)}`);
  syncChrome();
  saveFinishedGame();
  scheduleBot();
}

/**
 * Rotate the board so the player on move is at the bottom (ARCHITECTURE.md D12) — but only
 * for HUMAN seats. Spinning the board for a bot's turn would be pure disorientation: the
 * human's frame of reference should only change when a different human takes the chair.
 */
function rotateToTurn(startMs: number): void {
  if (!settings.rotateOnHandoff || game.result().over) return;
  const to = game.pos.turn;
  if (!isHuman(to)) return;
  if (to === seat) return;
  const steps = rotationSteps(seat, to);
  if (settings.reducedMotion) {
    seat = to;
    return;
  }
  anims = add(anims, {
    kind: 'seat', fromSeat: seat, toSeat: to, steps,
    startMs, durationMs: DURATION.seatRotate,
  });
  seat = to;
  audio.play('rotate');
}

function applyStep(step: Step): void {
  interaction = step.state;
  if (step.intent.kind === 'play') {
    playMove(step.intent.move);
  } else if (step.intent.kind === 'need-promotion') {
    openPromo(step.intent.options);
  }
}

/**
 * Bot turns. A short "think" delay keeps bot moves legible — instant replies read as chaos
 * when three bots move back to back. Search runs in the worker when available: ~0.4s per move
 * at hard and ~1.5s at expert on a desktop core, so only the worker-less fallback below
 * blocks the UI thread, and only for as long as the tier's search takes.
 */
function scheduleBot(): void {
  if (botTimer !== null || game.result().over) return;
  const turn = game.pos.turn;
  const bot = bots[turn];
  if (bot === undefined) return;
  botTimer = window.setTimeout(() => {
    botTimer = null;
    if (game.result().over || game.pos.turn !== turn) return;

    // A hopeless bot resigns rather than shuffling a bare king for forty rounds — and when
    // the last hopeless seats concede, the game correctly ends with the points leader winning.
    if (wantsResign(game.pos, turn)) {
      game.resign(turn);
      audio.play('eliminate');
      banner(`${cap(turn)} resigns`);
      announce(`${turn} resigns.`);
      refreshChecked();
      syncChrome();
      saveFinishedGame();
      if (game.result().over) audio.play('gameover');
      else scheduleBot();
      return;
    }

    const kind = seatConfig[turn];
    if (botWorker !== null && kind !== 'human') {
      botRequestId++;
      botWorker.postMessage({
        type: 'move',
        id: botRequestId,
        fen: serializeFen4(game.pos),
        mode: game.rules.mode,
        army: turn,
        kind,
        difficulty: botDifficulty,
        // Vary per move so softmax variance is real; stay deterministic per (game, ply).
        seed: (seatSeeds[turn] ^ Math.imul(game.moves.length + 1, 2654435761)) >>> 0,
      } satisfies AnalysisRequest);
      return;
    }
    const move = bot.pick(game.pos, turn);
    if (move !== null) playMove(move);
  }, settings.reducedMotion ? 120 : 550 + Math.random() * 450);
}

function newGame(rules: Ruleset): void {
  if (botTimer !== null) {
    window.clearTimeout(botTimer);
    botTimer = null;
  }
  // Reviewing a finished game opens it as a replay; starting a new one must leave it.
  if (replay !== null) {
    stopAutoplay();
    cancelReview();
    replay = null;
    replayTitle = '';
    replaySeats = [];
  }
  game = Game.create(rules);
  gameStartedAtMs = Date.now();
  gameSaved = false;
  interaction = INITIAL_INTERACTION;
  anims = NO_ANIMS;
  checked = [];
  moveTexts.length = 0;
  hint = null;
  hintPending = false;
  camera = { zoom: 1, panX: 0, panY: 0 };
  rebuildBots();
  // Seat the first human at the bottom; an all-bot table is watched from Red's side.
  seat = humanSeats()[0] ?? 'red';
  const modeName = rules.mode === 'ffa' ? 'Free-for-all' : 'Teams';
  const nBots = ARMIES.filter((a) => !isHuman(a)).length;
  el('modeLabel').textContent =
    `${modeName} · ${nBots === 0 ? 'hotseat' : nBots === 4 ? 'bots only' : `${4 - nBots}P vs ${nBots} bots`}`;
  announce(`New ${modeName} game. Red to move.`);
  syncChrome();
  scheduleBot();
}

const cap = (s: string): string => s[0].toUpperCase() + s.slice(1);

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

/**
 * Save a finished game as replayable PGN4.
 *
 * The PGN4 carries ruleset id and engine version internally (RULES.md §15), so stored history
 * stays replayable across rules changes and can be recomputed over later — which is what makes
 * retroactive ratings, achievements and puzzle mining possible (RISKS.md R3, R18).
 *
 * Guarded by `gameSaved` because the end condition is observed from several paths (a move, a
 * resignation, a bot's resignation) and double-saving would corrupt the history index.
 */
function saveFinishedGame(): void {
  if (gameSaved || !game.result().over || profile === null) return;
  gameSaved = true;

  const seats: SeatRecord[] = ARMIES.map((a) => ({
    army: a,
    profileId: isHuman(a) ? profile!.id : null,
    bot: isHuman(a) ? null : seatConfig[a],
    status: game.pos.status[a],
  }));

  const record: GameRecord = {
    id: `${gameStartedAtMs.toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}`,
    mode: game.rules.mode,
    seats,
    pgn4: writePgn4(game, {
      Event: 'Local hotseat',
      ...Object.fromEntries(ARMIES.map((a) => [
        cap(a), isHuman(a) ? profile!.name : `bot:${seatConfig[a]}:${botDifficulty}`,
      ])),
    }),
    points: { ...game.pos.points },
    winners: [...game.result().winners],
    endReason: game.result().reason,
    startedAtMs: gameStartedAtMs,
    endedAtMs: Date.now(),
  };

  void persistence.games.save(record).then(refreshHistory);
}

/* ------------------------------------------------------------------ *
 * Replay
 * ------------------------------------------------------------------ */

/** Show a replay on the board. Cancels any pending bot turn and any earlier review. */
function enterReplay(state: ReplayState, seats: Army[], title: string): void {
  if (botTimer !== null) {
    window.clearTimeout(botTimer);
    botTimer = null;
  }
  stopAutoplay();
  cancelReview();
  replay = state;
  replaySeats = seats;
  // View the replay from the seat the human actually occupied, so it reads the way it was
  // played rather than always from Red's chair.
  seat = seats[0] ?? 'red';
  replayTitle = title;
  camera = { zoom: 1, panX: 0, panY: 0 };
  anims = NO_ANIMS;
  syncChrome();
  announce(`Replaying ${title}. ${state.moves.length} moves.`);
}

/** Open a stored game on the board. */
function openReplay(id: string): void {
  void persistence.games.get(id).then((rec) => {
    if (rec === null) return;
    let state: ReplayState;
    try {
      state = loadReplay(rec.pgn4);
    } catch {
      banner('That game could not be replayed');
      return;
    }
    const label = rec.winners.length === 0 ? 'Draw' : `${rec.winners.map(cap).join(' & ')} won`;
    const seats = rec.seats.filter((s) => s.profileId !== null).map((s) => s.army);
    enterReplay(state, seats, `${rec.mode.toUpperCase()} — ${label} — ${rec.endReason}`);
  });
}

function closeReplay(): void {
  stopAutoplay();
  cancelReview();
  replay = null;
  replayTitle = '';
  replaySeats = [];
  seat = humanSeats()[0] ?? 'red';
  syncChrome();
  scheduleBot();
}

/**
 * Autoplay. Stops itself at the end rather than looping, because a replay that silently
 * restarts makes it impossible to tell "finished" from "still going".
 */
let autoplayTimer: number | null = null;

function toggleAutoplay(): void {
  if (autoplayTimer !== null) {
    stopAutoplay();
    return;
  }
  if (replay === null || atEnd(replay)) return;
  el('rPlay').textContent = '❚❚';
  autoplayTimer = window.setInterval(() => {
    if (replay === null || atEnd(replay)) {
      stopAutoplay();
      return;
    }
    replaySeek((r) => replayStep(r, 1));
  }, settings.reducedMotion ? 250 : 650);
}

function stopAutoplay(): void {
  if (autoplayTimer !== null) window.clearInterval(autoplayTimer);
  autoplayTimer = null;
  el('rPlay').textContent = '▶';
}

function replaySeek(fn: (r: ReplayState) => ReplayState): void {
  if (replay === null) return;
  replay = fn(replay);
  audio.play('move');
  syncChrome();
}

function refreshHistory(): void {
  void persistence.games.list(8).then((games) => {
    const el2 = document.getElementById('history');
    if (el2 === null) return;
    if (games.length === 0) {
      el2.innerHTML = '<div style="color:var(--muted);font-size:12px">No finished games yet.</div>';
      return;
    }
    el2.innerHTML = games.map((g) => {
      const you = g.seats.find((s) => s.profileId !== null)?.army;
      const won = you !== undefined && g.winners.includes(you);
      const when = new Date(g.endedAtMs).toLocaleDateString(undefined, {
        month: 'short', day: 'numeric',
      });
      const label = g.winners.length === 0 ? 'draw' : g.winners.map(cap).join(' & ');
      return `<button class="hrow" data-game="${g.id}" title="Replay this game">
        <span class="hres ${won ? 'win' : ''}">${won ? 'WON' : label}</span>
        <span class="hmode">${g.mode.toUpperCase()}</span>
        <span class="hpts">${you !== undefined ? g.points[you] : '—'} pts</span>
        <span class="hwhen">${when}</span>
      </button>`;
    }).join('');
    for (const row of el2.querySelectorAll('.hrow')) {
      row.addEventListener('click', () => {
        const id = (row as HTMLElement).dataset.game;
        if (id !== undefined) openReplay(id);
      });
    }
  });
}

/* ------------------------------------------------------------------ *
 * Promotion picker
 * ------------------------------------------------------------------ */

function openPromo(options: Move[]): void {
  const box = el('promoOpts');
  box.innerHTML = '';
  for (const m of options) {
    if (m.promotion === null) continue;
    const c = document.createElement('canvas');
    const size = 64;
    c.width = size * dpr;
    c.height = size * dpr;
    c.style.width = `${size}px`;
    c.style.height = `${size}px`;
    c.setAttribute('role', 'button');
    c.setAttribute('aria-label', m.promotion);
    const g = c.getContext('2d');
    if (g !== null) {
      g.scale(dpr, dpr);
      const s = size / PIECE_VIEWBOX;
      g.scale(s, s);
      const p = new Path2D(PIECE_PATHS[m.promotion as PieceType]);
      g.fillStyle = settings.colorblind
        ? theme().armies[game.pos.turn]
        : theme().armies[game.pos.turn];
      g.fill(p, PIECE_FILL_RULE[m.promotion as PieceType]);
      g.strokeStyle = theme().pieceStroke;
      g.lineWidth = 2.4;
      g.stroke(p);
    }
    c.addEventListener('click', () => {
      el('promo').classList.remove('open');
      applyStep(choosePromotion(interaction, m.promotion as string));
    });
    box.appendChild(c);
  }
  el('promo').classList.add('open');
}

/* ------------------------------------------------------------------ *
 * Pointer input: tap, pan, pinch, wheel
 * ------------------------------------------------------------------ */

interface PointerInfo { x: number; y: number; startX: number; startY: number }
const pointers = new Map<number, PointerInfo>();
let panning = false;
let pinchStart = 0;
let pinchZoom = 1;

function localPoint(e: PointerEvent | WheelEvent): { x: number; y: number } {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.x, y: e.clientY - r.y };
}

function setCamera(next: Camera): void {
  const l = computeLayout(viewport(), theme(), next);
  camera = clampCamera(next, l);
  el('zoomhint').textContent = camera.zoom > 1.01 ? `${camera.zoom.toFixed(1)}× — drag to pan` : '';
}

function zoomAround(px: number, py: number, factor: number): void {
  const vp = viewport();
  const vcx = vp.width / 2;
  const vcy = vp.height / 2;
  const z = camera.zoom;
  const zNext = Math.min(4, Math.max(1, z * factor));
  const k = zNext / z;
  setCamera({
    zoom: zNext,
    panX: px - vcx - (px - vcx - camera.panX) * k,
    panY: py - vcy - (py - vcy - camera.panY) * k,
  });
}

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const p = localPoint(e);
  pointers.set(e.pointerId, { x: p.x, y: p.y, startX: p.x, startY: p.y });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchStart = Math.hypot(a.x - b.x, a.y - b.y);
    pinchZoom = camera.zoom;
  }
});

canvas.addEventListener('pointermove', (e) => {
  const info = pointers.get(e.pointerId);
  if (info === undefined) return;
  const p = localPoint(e);
  const dx = p.x - info.x;
  const dy = p.y - info.y;
  info.x = p.x;
  info.y = p.y;

  if (pointers.size === 2 && pinchStart > 0) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const target = pinchZoom * (dist / pinchStart);
    zoomAround(mid.x, mid.y, target / camera.zoom);
    return;
  }

  const moved = Math.hypot(p.x - info.startX, p.y - info.startY);
  if (!panning && moved > 9 && camera.zoom > 1.01) panning = true;
  if (panning) setCamera({ zoom: camera.zoom, panX: camera.panX + dx, panY: camera.panY + dy });
});

canvas.addEventListener('pointerup', (e) => {
  const info = pointers.get(e.pointerId);
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinchStart = 0;
  if (info === undefined) return;
  const wasPan = panning;
  if (pointers.size === 0) panning = false;
  if (wasPan) return;

  const moved = Math.hypot(info.x - info.startX, info.y - info.startY);
  if (moved > 9) return;
  const sq = hitTest(layout(), seat, info.x, info.y);
  applyStep(tapSquare(ictx(), interaction, sq));
  syncChrome();
});

canvas.addEventListener('pointercancel', (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size === 0) panning = false;
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const p = localPoint(e);
  zoomAround(p.x, p.y, e.deltaY < 0 ? 1.12 : 1 / 1.12);
}, { passive: false });

canvas.addEventListener('dblclick', () => {
  // Double-tap toggles between fit and comfortable-touch zoom — the R7/R8 mobile answer.
  const fit = camera.zoom <= 1.01;
  if (fit) {
    const z = Math.max(1.6, zoomForComfortableTouch(viewport(), theme()));
    zoomAround(viewport().width / 2, viewport().height / 2, z);
  } else {
    setCamera({ zoom: 1, panX: 0, panY: 0 });
  }
});

/* ------------------------------------------------------------------ *
 * Keyboard
 * ------------------------------------------------------------------ */

canvas.addEventListener('keydown', (e) => {
  const dirs: Record<string, 'up' | 'down' | 'left' | 'right'> = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  };
  if (replay !== null) {
    // In replay the arrows scrub the timeline; a board cursor would have nothing to act on.
    if (e.key === 'ArrowLeft') { e.preventDefault(); replaySeek((r) => replayStep(r, -1)); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); replaySeek((r) => replayStep(r, 1)); }
    else if (e.key === 'Home') { e.preventDefault(); replaySeek(toStart); }
    else if (e.key === 'End') { e.preventDefault(); replaySeek(toEnd); }
    else if (e.key === ' ') { e.preventDefault(); toggleAutoplay(); }
    else if (e.key === 'Escape') closeReplay();
    return;
  }
  if (e.key in dirs) {
    e.preventDefault();
    const from = interaction.cursor >= 0 ? interaction.cursor : defaultCursor(game.pos, seat);
    interaction = { ...interaction, cursor: moveCursor(seat, from, dirs[e.key]) };
    announce(squareName(interaction.cursor));
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    if (interaction.cursor >= 0) {
      applyStep(tapSquare(ictx(), interaction, interaction.cursor));
      syncChrome();
    }
  } else if (e.key === 'Escape') {
    el('promo').classList.remove('open');
    interaction = cancel(interaction).state;
  }
});

/* ------------------------------------------------------------------ *
 * Chrome: panels, settings, theme
 * ------------------------------------------------------------------ */

function applyTheme(): void {
  const t = theme();
  const root = document.documentElement.style;
  root.setProperty('--page', t.page);
  root.setProperty('--text', t.text);
  root.setProperty('--muted', t.textMuted);
  root.setProperty('--panel', t.panel);
  root.setProperty('--panel-brd', t.panelBorder);
  root.setProperty('--accent', t.accent);
  for (const btn of el('themeSeg').querySelectorAll('button')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.theme === settings.themeId));
  }
}

function syncChrome(): void {
  // Player cards. Bots show their personality name so the table reads as four characters.
  const shown = replay !== null ? replay.position : game.pos;
  const cards = ARMIES.map((a) => {
    const active = shown.isActive(a);
    const turn = replay !== null
      ? shown.turn === a && active
      : !game.result().over && game.pos.turn === a && active;
    const inCheck = checked.includes(a);
    const status = !active ? shown.status[a] : inCheck ? 'in check' : turn ? 'to move' : '';
    const color = settings.colorblind
      ? { red: '#d55e00', blue: '#0072b2', yellow: '#f0e442', green: '#009e73' }[a]
      : theme().armies[a];
    const kind = seatConfig[a];
    const who = kind === 'human'
      ? (profile !== null && humanSeats().length === 1 ? profile.name : cap(a))
      : PERSONALITIES[kind].name;
    const label = kind === 'human' && humanSeats().length === 1 ? who : `${cap(a)} · ${who}`;
    return `<div class="pcard${turn ? ' turn' : ''}${active ? '' : ' dead'}${inCheck ? ' check' : ''}">
      <span class="chip" style="background:${color}"></span>
      <span class="name">${label}</span>
      <span class="status">${status}</span>
      <span class="pts">${shown.points[a]}</span>
    </div>`;
  });
  el('players').innerHTML = cards.join('');

  // Move list, one row per round. In replay it shows the stored game with the current ply lit.
  const listed = replay !== null
    ? replay.notation.map((text, i) => ({ army: replay!.movers[i], text }))
    : moveTexts;

  /**
   * Group into rounds by SEAT ORDER, not by chunks of four.
   *
   * Once a player is eliminated they stop moving, so a round contains fewer than four moves —
   * and naive `slice(i, i+4)` chunking then shifts every later move into the wrong column.
   * The reported symptom was Green appearing to move Red's king, and one army seeming to move
   * twice in a round. Grouping on a seat-index decrease starts a new round exactly when the
   * turn order wraps, which stays correct however many players have dropped out.
   */
  const rounds: { army: Army; text: string }[][] = [];
  let current: { army: Army; text: string }[] = [];
  let lastSeatIndex = -1;
  for (const m of listed) {
    const seatIndex = ARMIES.indexOf(m.army);
    if (seatIndex <= lastSeatIndex) {
      rounds.push(current);
      current = [];
    }
    current.push(m);
    lastSeatIndex = seatIndex;
  }
  if (current.length > 0) rounds.push(current);

  const rows: string[] = [];
  let plyCursor = 0;
  for (const [roundIndex, round] of rounds.entries()) {
    const cells = round.map((m) => {
      const color = theme().armies[m.army];
      const ply = plyCursor++;
      const current2 = replay !== null && ply === replay.ply - 1;
      const next = replay !== null && ply === replay.ply;
      // Review verdicts: a chess-style mark on errors, the better move in the tooltip.
      const v = review?.verdicts.get(ply);
      const mark = v !== undefined && GRADE_MARK[v.grade] !== ''
        ? `<b class="g-${v.grade}">${GRADE_MARK[v.grade]}</b>` : '';
      const title = v === undefined ? m.army
        : isError(v) ? `${cap(v.grade)} (−${v.loss.toFixed(1)}) — better: ${v.bestText}`
          : cap(v.grade);
      return `<span class="mv${current2 ? ' live' : ''}${next ? ' next' : ''}"`
        + `${replay !== null ? ` data-ply="${ply}" role="button" tabindex="0"` : ''}`
        + ` title="${title}">`
        + `<i style="background:${color}"></i>${m.text}${mark}</span>`;
    });
    rows.push(`<div class="mrow"><span class="n">${roundIndex + 1}.</span>${cells.join(' ')}</div>`);
  }
  el('moves').innerHTML = rows.join('');
  if (replay === null) el('moves').scrollTop = el('moves').scrollHeight;

  // Game state line.
  const r = game.result();
  if (r.over) {
    const who = r.winners.length === 0 ? 'Draw' : `${r.winners.map(cap).join(' & ')} win${r.winners.length > 1 ? '' : 's'}`;
    el('gameState').textContent = `${who} — ${r.reason}`;
  } else {
    el('gameState').textContent = `${cap(game.pos.turn)} to move${checked.length > 0 ? ` · in check: ${checked.join(', ')}` : ''}`;
  }
  const resignBtn = document.getElementById('resign') as HTMLButtonElement | null;
  if (resignBtn !== null) {
    resignBtn.disabled = replay !== null || r.over || !isHuman(game.pos.turn);
  }
  const hintBtn = document.getElementById('hint') as HTMLButtonElement | null;
  if (hintBtn !== null) {
    hintBtn.disabled = replay !== null || r.over || !isHuman(game.pos.turn) || hintPending;
    hintBtn.textContent = hintPending ? 'Thinking…' : 'Hint';
  }
  syncReview();

  // Replay bar.
  const bar = document.getElementById('replayBar');
  if (bar !== null) {
    bar.classList.toggle('open', replay !== null);
    if (replay !== null) {
      el('rTitle').textContent = replayTitle;
      el('rPly').textContent = `${replay.ply} / ${replay.moves.length}`;
      (el('rStart') as HTMLButtonElement).disabled = atStart(replay);
      (el('rPrev') as HTMLButtonElement).disabled = atStart(replay);
      (el('rNext') as HTMLButtonElement).disabled = atEnd(replay);
      (el('rEnd') as HTMLButtonElement).disabled = atEnd(replay);
      (el('rPlay') as HTMLButtonElement).disabled = atEnd(replay);
      el('gameState').textContent = `Replay — ${replayTitle}`;
    }
  }
}

/** The Review panel: the button, progress and summary, and the note on the upcoming move. */
function syncReview(): void {
  const btn = document.getElementById('reviewBtn') as HTMLButtonElement | null;
  if (btn === null) return;
  const reviewable = replay !== null
    ? replaySeats.length > 0
    : game.result().over && humanSeats().length > 0;
  const running = review !== null && !review.done;
  btn.disabled = !reviewable || running || (review !== null && review.done);
  btn.textContent = running ? `Reviewing… ${review!.progress}/${review!.total}`
    : review !== null ? 'Reviewed' : 'Review game';

  let summary = '';
  if (review !== null && review.progress > 0) summary = reviewSummary(review);
  else if (!reviewable) {
    summary = replay === null && !game.result().over
      ? 'Finish a game to review your moves.'
      : 'This game has no human moves to review.';
  }
  el('reviewSummary').textContent = summary;

  // In a reviewed replay: what the upcoming move was, and what was better (marked on board).
  const v = upcomingVerdict();
  const note = el('reviewNote');
  if (replay !== null && v !== undefined) {
    const played = replay.notation[replay.ply];
    const who = cap(replay.movers[replay.ply]);
    note.textContent = isError(v)
      ? `${who} played ${played}${GRADE_MARK[v.grade]} — ${v.grade}, −${v.loss.toFixed(1)}. `
        + `Better: ${v.bestText} (marked on the board).`
      : `${who} played ${played} — ${v.grade}.`;
  } else if (review !== null && review.done) {
    note.textContent = 'Click a marked move to see the position before it and the better move.';
  } else {
    note.textContent = '';
  }
}

function buildChrome(): void {
  // Theme segment.
  el('themeSeg').innerHTML = THEME_IDS.map((id) =>
    `<button data-theme="${id}">${THEMES[id].name}</button>`).join('');
  for (const btn of el('themeSeg').querySelectorAll('button')) {
    btn.addEventListener('click', () => {
      settings = { ...settings, themeId: btn.dataset.theme as UserSettings['themeId'] };
      saveSettings(store, settings);
      applyTheme();
      syncChrome();
    });
  }

  // Settings toggles.
  const toggles: { key: keyof UserSettings; label: string }[] = [
    { key: 'colorblind', label: 'Colour-blind palette + markers' },
    { key: 'showCoords', label: 'Coordinates' },
    { key: 'rotateOnHandoff', label: 'Rotate board to player on move' },
    { key: 'sound', label: 'Sound' },
    { key: 'reducedMotion', label: 'Reduce motion' },
  ];
  el('settings').innerHTML = toggles.map(({ key, label }) =>
    `<div class="setting"><label for="s-${key}">${label}</label>
     <input type="checkbox" id="s-${key}" ${settings[key] === true ? 'checked' : ''}></div>`).join('');
  for (const { key } of toggles) {
    (document.getElementById(`s-${key}`) as HTMLInputElement).addEventListener('change', (e) => {
      settings = { ...settings, [key]: (e.target as HTMLInputElement).checked };
      saveSettings(store, settings);
      audio.enabled = settings.sound;
      syncChrome();
    });
  }

  // Seat picker: one row per army, Human or a bot personality.
  const options = (sel: SeatKind): string =>
    [`<option value="human"${sel === 'human' ? ' selected' : ''}>Human</option>`,
      ...PERSONALITY_IDS.map((id) =>
        `<option value="${id}"${sel === id ? ' selected' : ''}>Bot · ${PERSONALITIES[id].name}</option>`),
    ].join('');
  el('seats').innerHTML = ARMIES.map((a) => `
    <div class="seatrow">
      <span class="chip" style="background:${theme().armies[a]}"></span>
      <label for="seat-${a}">${a}</label>
      <select id="seat-${a}" data-army="${a}">${options(seatConfig[a])}</select>
    </div>`).join('');
  for (const a of ARMIES) {
    (document.getElementById(`seat-${a}`) as HTMLSelectElement).addEventListener('change', (e) => {
      seatConfig[a] = (e.target as HTMLSelectElement).value as SeatKind;
    });
  }
  (document.getElementById('difficulty') as HTMLSelectElement).addEventListener('change', (e) => {
    botDifficulty = (e.target as HTMLSelectElement).value as Difficulty;
  });

  el('newFfa').addEventListener('click', () => newGame(FFA_RULES));
  el('newTeams').addEventListener('click', () => newGame(TEAMS_RULES));

  /**
   * Human resignation. Without this a losing player can only close the tab — and a game that
   * is never finished is never saved, so it vanishes from history entirely. In FFA resigning
   * keeps your banked points (RULES.md §12), so it is a real strategic choice rather than
   * pure surrender; in Teams it hands your surviving pieces to your partner (§11).
   */
  el('resign').addEventListener('click', () => {
    const turn = game.pos.turn;
    if (game.result().over || !isHuman(turn)) return;
    const partner = game.rules.mode === 'teams' ? ' Your pieces pass to your partner.' : '';
    if (!window.confirm(`Resign as ${cap(turn)}? You keep your ${game.pos.points[turn]} points.${partner}`)) {
      return;
    }
    game.resign(turn);
    audio.play('eliminate');
    banner(`${cap(turn)} resigns`);
    announce(`${turn} resigns.`);
    refreshChecked();
    syncChrome();
    saveFinishedGame();
    if (game.result().over) audio.play('gameover');
    else scheduleBot();
  });

  el('hint').addEventListener('click', requestHint);
  el('reviewBtn').addEventListener('click', startReview);

  // Replay: clicking a move shows the position just BEFORE it — where a reviewed mistake's
  // better alternative is marked on the board.
  const seekToMove = (target: EventTarget | null): void => {
    const cell = (target as HTMLElement | null)?.closest<HTMLElement>('.mv[data-ply]');
    if (cell === null || cell === undefined || replay === null) return;
    stopAutoplay();
    const ply = Number(cell.dataset.ply);
    replaySeek((r) => seek(r, ply));
  };
  el('moves').addEventListener('click', (e) => seekToMove(e.target));
  el('moves').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      seekToMove(e.target);
    }
  });

  // Replay controls.
  el('rClose').addEventListener('click', closeReplay);
  el('rStart').addEventListener('click', () => replaySeek(toStart));
  el('rPrev').addEventListener('click', () => replaySeek((r) => replayStep(r, -1)));
  el('rNext').addEventListener('click', () => replaySeek((r) => replayStep(r, 1)));
  el('rEnd').addEventListener('click', () => replaySeek(toEnd));
  el('rPlay').addEventListener('click', toggleAutoplay);

  const nameInput = document.getElementById('playerName') as HTMLInputElement;
  const commitName = (): void => {
    void persistence.profiles.rename(nameInput.value).then((p) => {
      profile = p;
      nameInput.value = p.name;
      syncChrome();
    });
  };
  el('saveName').addEventListener('click', commitName);
  nameInput.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') commitName();
  });
}

/** Load the guest profile and history. Async, so the board is playable before it resolves. */
function bootPersistence(): void {
  void persistence.profiles.ensureGuest().then((p) => {
    profile = p;
    const input = document.getElementById('playerName') as HTMLInputElement | null;
    if (input !== null) input.value = p.name;
    const note = document.getElementById('guestNote');
    if (note !== null) {
      note.textContent = p.guest
        ? 'Playing as a guest — your games are saved on this device.'
        : `Signed in as ${p.name}.`;
    }
    syncChrome();
  });
  refreshHistory();
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

if (window.matchMedia('(prefers-reduced-motion: reduce)').matches && !settings.reducedMotion) {
  settings = { ...settings, reducedMotion: true };
}

buildChrome();
applyTheme();
resize();
rebuildBots();
refreshChecked();
syncChrome();
bootPersistence();
announce('Four-way chess. Red to move.');
scheduleBot();

// Paint immediately rather than waiting for the first rAF tick: a hidden or backgrounded tab
// never fires rAF at all, and even in the common case this gets pixels up one frame sooner.
frame(performance.now());
requestAnimationFrame(loop);

/**
 * Debug and e2e hook. Lets tests drive a frame and read state without rAF, which hidden tabs
 * suspend entirely. Not a public API.
 */
(window as unknown as { __4wc: unknown }).__4wc = {
  renderOnce: () => frame(performance.now()),
  state: () => ({
    turn: game.pos.turn,
    seat,
    points: { ...game.pos.points },
    over: game.result().over,
    moves: moveTexts.length,
    zoom: camera.zoom,
    hint: hint === null ? null : `${squareName(hint.from)}-${squareName(hint.to)}`,
    replayPly: replay?.ply ?? null,
    review: review === null ? null : {
      progress: review.progress, total: review.total, done: review.done,
      grades: [...review.verdicts.entries()]
        .map(([ply, v]) => ({ ply, grade: v.grade, best: v.bestText })),
    },
  }),
  requestHint,
  startReview,
  /** Legal moves for the side to move, as "from-to" square names. */
  legal: () => game.legalMoves().map((m) => `${squareName(m.from)}-${squareName(m.to)}`),
  /** Play a legal move by square names (first match; promotions take the engine's first). */
  play: (from: string, to: string) => {
    const m = game.legalMoves().find(
      (x) => squareName(x.from) === from && squareName(x.to) === to,
    );
    if (m === undefined) return false;
    playMove(m);
    frame(performance.now());
    return true;
  },
  tap: (x: number, y: number) => {
    const sq = hitTest(layout(), seat, x, y);
    applyStep(tapSquare(ictx(), interaction, sq));
    syncChrome();
    frame(performance.now());
    return sq >= 0 ? squareName(sq) : 'none';
  },
  /** Force a pending bot move immediately — hidden tabs throttle setTimeout heavily. */
  botStep: () => {
    if (game.result().over) return 'over';
    const turn = game.pos.turn;
    const bot = bots[turn];
    if (bot === undefined) return `human:${turn}`;
    if (botTimer !== null) {
      window.clearTimeout(botTimer);
      botTimer = null;
    }
    if (wantsResign(game.pos, turn)) {
      game.resign(turn);
      refreshChecked();
      syncChrome();
      saveFinishedGame();
      frame(performance.now());
      return `resigned:${turn}`;
    }
    const move = bot.pick(game.pos, turn);
    if (move !== null) playMove(move);
    frame(performance.now());
    return `played:${turn}`;
  },
};
