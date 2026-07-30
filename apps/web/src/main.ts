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
import { atEnd, atStart, loadReplay, seek, step as replayStep, toEnd, toStart } from '@4wc/ui-core';
import { Canvas2DSurface, renderScene } from '@4wc/board-render';
import { PIECE_FILL_RULE, PIECE_PATHS, PIECE_VIEWBOX } from '@4wc/pieces';
import { PERSONALITIES, PERSONALITY_IDS, makeBot, wantsResign } from '@4wc/bots';
import type { Bot, Difficulty, PersonalityId } from '@4wc/bots';
import { localPersistence, storageKV } from '@4wc/store';
import type { GameRecord, Profile, SeatRecord } from '@4wc/store';
import { GameAudio } from './audio.ts';

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
 * Bot search runs in a worker so 60-300ms of deep thinking never freezes an animation. The
 * worker is compute only: it receives FEN4 and returns from/to/promotion, which the main
 * thread re-validates against its own legal moves. Falls back to synchronous in-thread search
 * when workers are unavailable (file:// contexts, some test harnesses).
 */
let botWorker: Worker | null = null;
let botRequestId = 0;
try {
  botWorker = new Worker('dist/worker.js');
  botWorker.onmessage = (e: MessageEvent<{
    id: number; army: Army; move: { from: number; to: number; promotion: string | null } | null;
  }>) => {
    const msg = e.data;
    if (msg.id !== botRequestId) return; // stale reply from a superseded game or turn
    if (game.result().over || game.pos.turn !== msg.army) return;
    if (msg.move === null) return;
    const legal = game.legalMoves().find(
      (m) => m.from === msg.move!.from && m.to === msg.move!.to
        && m.promotion === msg.move!.promotion,
    );
    if (legal !== undefined) playMove(legal);
  };
  botWorker.onerror = () => {
    botWorker = null; // sync fallback from here on
  };
} catch {
  botWorker = null;
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
  });
  renderScene(surface, scene, viewport(), { markers: settings.colorblind });
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
 * when three bots move back to back. Search itself is synchronous and budgeted to stay well
 * under a frame-budget-friendly ~40ms at the hard tier.
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
        id: botRequestId,
        fen: serializeFen4(game.pos),
        mode: game.rules.mode,
        army: turn,
        kind,
        difficulty: botDifficulty,
        // Vary per move so softmax variance is real; stay deterministic per (game, ply).
        seed: (seatSeeds[turn] ^ Math.imul(game.moves.length + 1, 2654435761)) >>> 0,
      });
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
  game = Game.create(rules);
  gameStartedAtMs = Date.now();
  gameSaved = false;
  interaction = INITIAL_INTERACTION;
  anims = NO_ANIMS;
  checked = [];
  moveTexts.length = 0;
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

/** Open a stored game on the board. Cancels any pending bot turn from the live game. */
function openReplay(id: string): void {
  void persistence.games.get(id).then((rec) => {
    if (rec === null) return;
    if (botTimer !== null) {
      window.clearTimeout(botTimer);
      botTimer = null;
    }
    stopAutoplay();
    try {
      replay = loadReplay(rec.pgn4);
    } catch {
      banner('That game could not be replayed');
      return;
    }
    // View the replay from the seat the human actually occupied, so it reads the way it was
    // played rather than always from Red's chair.
    const mine = rec.seats.find((s) => s.profileId !== null);
    seat = mine?.army ?? 'red';
    const label = rec.winners.length === 0 ? 'Draw' : `${rec.winners.map(cap).join(' & ')} won`;
    replayTitle = `${rec.mode.toUpperCase()} — ${label} — ${rec.endReason}`;
    camera = { zoom: 1, panX: 0, panY: 0 };
    anims = NO_ANIMS;
    syncChrome();
    announce(`Replaying a stored game. ${label}. ${replay.moves.length} moves.`);
  });
}

function closeReplay(): void {
  stopAutoplay();
  replay = null;
  replayTitle = '';
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
  const rows: string[] = [];
  for (let i = 0; i < listed.length; i += 4) {
    const cells = listed.slice(i, i + 4).map((m, j) => {
      const color = theme().armies[m.army];
      const current = replay !== null && i + j === replay.ply - 1;
      return `<span class="mv${current ? ' live' : ''}"`
        + `${current ? ' style="outline:1.5px solid var(--accent);border-radius:4px"' : ''}>`
        + `<i style="background:${color}"></i>${m.text}</span>`;
    });
    rows.push(`<div class="mrow"><span class="n">${i / 4 + 1}.</span>${cells.join(' ')}</div>`);
  }
  el('moves').innerHTML = rows.join('');
  el('moves').scrollTop = el('moves').scrollHeight;

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
  }),
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
