/**
 * Animation.
 *
 * Deliberately a pure function of time: nothing here starts a timer, reads a clock, or holds a
 * frame loop. The host passes `now` in, and this returns interpolated state. That makes every
 * animation deterministic and unit-testable, and it means the same code drives web rAF and
 * React Native's frame callbacks without change.
 */

import type { Army, Move, Square } from '@4wc/engine';

export type Easing = (t: number) => number;

export const linear: Easing = (t) => t;
export const easeOutCubic: Easing = (t) => 1 - (1 - t) ** 3;
export const easeInOutCubic: Easing = (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
/** Slight overshoot — gives a piece landing real weight. */
export const easeOutBack: Easing = (t) => {
  const c = 1.70158;
  return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
};

/** Durations in ms. Fast and tactile beats slow and showy. */
export const DURATION = {
  move: 180,
  capture: 220,
  /** Seat hand-off must be a visible spin, never a snap (RISKS.md R8 / D12). */
  seatRotate: 520,
  check: 900,
  eliminate: 700,
  promote: 320,
} as const;

/** Clamped, eased progress through a window. Returns 1 before a window starts. */
export function progress(startMs: number, durationMs: number, now: number, easing: Easing = linear): number {
  if (durationMs <= 0) return 1;
  const raw = (now - startMs) / durationMs;
  if (raw <= 0) return 0;
  if (raw >= 1) return 1;
  return easing(raw);
}

export function isRunning(startMs: number, durationMs: number, now: number): boolean {
  return now >= startMs && now < startMs + durationMs;
}

/** A piece sliding between two squares. */
export interface MoveAnim {
  kind: 'move';
  from: Square;
  to: Square;
  army: Army;
  startMs: number;
  durationMs: number;
  /** Set when the move removed a piece, so the victim can fade rather than vanish. */
  capturedSq: Square | null;
}

/** The board spinning to seat a different player at the bottom. */
export interface SeatAnim {
  kind: 'seat';
  fromSeat: Army;
  toSeat: Army;
  /** Signed quarter-turns; negative goes anticlockwise (the short way). */
  steps: number;
  startMs: number;
  durationMs: number;
}

/** A pulsing highlight on a king in check. */
export interface CheckAnim {
  kind: 'check';
  square: Square;
  army: Army;
  startMs: number;
  durationMs: number;
}

/** An army greying out as it is eliminated. */
export interface EliminateAnim {
  kind: 'eliminate';
  army: Army;
  startMs: number;
  durationMs: number;
}

export type Anim = MoveAnim | SeatAnim | CheckAnim | EliminateAnim;

/** Live animation set. Finished entries are dropped by `prune`. */
export interface AnimState {
  anims: Anim[];
}

export const NO_ANIMS: AnimState = { anims: [] };

export function endOf(a: Anim): number {
  return a.startMs + a.durationMs;
}

export function prune(state: AnimState, now: number): AnimState {
  const kept = state.anims.filter((a) => now < endOf(a));
  return kept.length === state.anims.length ? state : { anims: kept };
}

export function anyRunning(state: AnimState, now: number): boolean {
  return state.anims.some((a) => now < endOf(a));
}

export function add(state: AnimState, anim: Anim): AnimState {
  return { anims: [...state.anims, anim] };
}

export function findMoveAnim(state: AnimState, now: number): MoveAnim | null {
  for (const a of state.anims) {
    if (a.kind === 'move' && now < endOf(a)) return a;
  }
  return null;
}

export function findSeatAnim(state: AnimState, now: number): SeatAnim | null {
  for (const a of state.anims) {
    if (a.kind === 'seat' && now < endOf(a)) return a;
  }
  return null;
}

export function eliminationProgress(state: AnimState, army: Army, now: number): number {
  for (const a of state.anims) {
    if (a.kind === 'eliminate' && a.army === army) {
      return progress(a.startMs, a.durationMs, now, easeOutCubic);
    }
  }
  return 1;
}

/** Board rotation in degrees at `now`, given a running seat animation. */
export function seatRotation(anim: SeatAnim | null, now: number): number {
  if (anim === null) return 0;
  const t = progress(anim.startMs, anim.durationMs, now, easeInOutCubic);
  return anim.steps * 90 * t;
}

/**
 * Check pulse intensity, 0..1, oscillating for the life of the animation.
 * Two full pulses then rest — enough to draw the eye without becoming a strobe.
 */
export function checkPulse(anim: CheckAnim, now: number): number {
  const t = progress(anim.startMs, anim.durationMs, now);
  if (t >= 1) return 0;
  return (Math.sin(t * Math.PI * 4) + 1) / 2 * (1 - t);
}

export function moveAnimFor(move: Move, army: Army, now: number): MoveAnim {
  return {
    kind: 'move',
    from: move.from,
    to: move.to,
    army,
    startMs: now,
    durationMs: move.captured === null ? DURATION.move : DURATION.capture,
    capturedSq: move.capturedSq,
  };
}
