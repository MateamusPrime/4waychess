import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateLegal, startingPosition } from '@4wc/engine';
import {
  DURATION, NO_ANIMS, add, anyRunning, checkPulse, easeInOutCubic, easeOutBack, easeOutCubic,
  eliminationProgress, endOf, findMoveAnim, findSeatAnim, isRunning, linear, moveAnimFor,
  progress, prune, seatRotation,
} from '../src/animation.ts';
import type { AnimState, CheckAnim, SeatAnim } from '../src/animation.ts';

describe('easing functions', () => {
  test('all easings are anchored at 0 and 1', () => {
    for (const [name, fn] of [
      ['linear', linear], ['easeOutCubic', easeOutCubic],
      ['easeInOutCubic', easeInOutCubic], ['easeOutBack', easeOutBack],
    ] as const) {
      assert.ok(Math.abs(fn(0)) < 1e-9, `${name}(0)`);
      assert.ok(Math.abs(fn(1) - 1) < 1e-9, `${name}(1)`);
    }
  });

  test('easings are monotonic except easeOutBack, which overshoots on purpose', () => {
    for (const [name, fn] of [
      ['linear', linear], ['easeOutCubic', easeOutCubic], ['easeInOutCubic', easeInOutCubic],
    ] as const) {
      let prev = -Infinity;
      for (let t = 0; t <= 1.0001; t += 0.02) {
        const v = fn(t);
        assert.ok(v >= prev - 1e-9, `${name} dipped at t=${t.toFixed(2)}`);
        prev = v;
      }
    }
    // The overshoot is what gives a landing piece weight.
    assert.ok(Math.max(...[0.6, 0.7, 0.8].map(easeOutBack)) > 1, 'easeOutBack should overshoot');
  });

  test('easeOutCubic decelerates — most of the distance is covered early', () => {
    assert.ok(easeOutCubic(0.5) > 0.8, `got ${easeOutCubic(0.5)}`);
  });
});

describe('progress is a pure function of time', () => {
  test('clamped to 0 before and 1 after the window', () => {
    assert.equal(progress(100, 200, 50), 0);
    assert.equal(progress(100, 200, 100), 0);
    assert.equal(progress(100, 200, 300), 1);
    assert.equal(progress(100, 200, 1e9), 1);
  });

  test('linear midpoint is exactly half', () => {
    assert.equal(progress(0, 200, 100), 0.5);
  });

  test('zero-length windows complete instantly rather than dividing by zero', () => {
    assert.equal(progress(0, 0, 0), 1);
    assert.equal(progress(0, -5, 0), 1);
  });

  test('the same inputs always give the same output — no clock is read', () => {
    const a = progress(1000, 500, 1250, easeOutCubic);
    const b = progress(1000, 500, 1250, easeOutCubic);
    assert.equal(a, b);
    assert.ok(a > 0 && a < 1);
  });

  test('isRunning brackets the window correctly', () => {
    assert.equal(isRunning(100, 50, 99), false);
    assert.equal(isRunning(100, 50, 100), true);
    assert.equal(isRunning(100, 50, 149), true);
    assert.equal(isRunning(100, 50, 150), false);
  });
});

describe('animation set', () => {
  const move = (start: number): AnimState => add(NO_ANIMS, {
    kind: 'move', from: 0, to: 1, army: 'red', startMs: start,
    durationMs: DURATION.move, capturedSq: null,
  });

  test('add does not mutate the previous state', () => {
    const a = NO_ANIMS;
    const b = move(0);
    assert.equal(a.anims.length, 0);
    assert.equal(b.anims.length, 1);
  });

  test('prune drops finished animations and keeps identity when nothing changed', () => {
    const s = move(0);
    assert.equal(prune(s, 0).anims.length, 1);
    assert.equal(prune(s, 0), s, 'no change should not allocate');
    assert.equal(prune(s, DURATION.move).anims.length, 0);
  });

  test('anyRunning tracks whether a frame loop is still needed', () => {
    const s = move(1000);
    assert.equal(anyRunning(s, 1000), true);
    assert.equal(anyRunning(s, 1000 + DURATION.move), false);
    assert.equal(anyRunning(NO_ANIMS, 0), false);
  });

  test('endOf is start plus duration', () => {
    const s = move(500);
    assert.equal(endOf(s.anims[0]), 500 + DURATION.move);
  });

  test('finders return only live animations of the right kind', () => {
    const s = move(0);
    assert.notEqual(findMoveAnim(s, 10), null);
    assert.equal(findMoveAnim(s, DURATION.move + 1), null);
    assert.equal(findSeatAnim(s, 10), null);
  });
});

describe('move animations', () => {
  test('a capture animates for longer than a quiet move', () => {
    const pos = startingPosition();
    const quiet = generateLegal(pos, 'red')[0];
    const a = moveAnimFor(quiet, 'red', 0);
    assert.equal(a.durationMs, DURATION.move);
    assert.equal(a.capturedSq, null);

    const withCapture = { ...quiet, captured: 'p' as const, capturedSq: 99 };
    const b = moveAnimFor(withCapture, 'red', 0);
    assert.equal(b.durationMs, DURATION.capture);
    assert.ok(b.durationMs > a.durationMs, 'a capture needs room for the victim to fade');
    assert.equal(b.capturedSq, 99);
  });

  test('durations stay in the fast-and-tactile range', () => {
    // Polished reads as fast, not showy. Anything over ~600ms starts to feel sluggish for a
    // move, and the seat spin is the only thing allowed to be slower.
    assert.ok(DURATION.move <= 250, `move ${DURATION.move}ms`);
    assert.ok(DURATION.capture <= 300, `capture ${DURATION.capture}ms`);
    assert.ok(DURATION.seatRotate >= 350 && DURATION.seatRotate <= 700,
      `seat rotate ${DURATION.seatRotate}ms must be visible but not tedious`);
  });
});

describe('seat rotation (ARCHITECTURE.md D12)', () => {
  const spin = (steps: number, start = 0): SeatAnim => ({
    kind: 'seat', fromSeat: 'red', toSeat: 'blue', steps,
    startMs: start, durationMs: DURATION.seatRotate,
  });

  test('rotation is continuous from 0 to the full quarter-turn — never a snap', () => {
    const a = spin(1);
    assert.equal(seatRotation(a, 0), 0);
    const mid = seatRotation(a, DURATION.seatRotate / 2);
    assert.ok(mid > 5 && mid < 85, `midpoint should be part-way, got ${mid}`);
    assert.equal(seatRotation(a, DURATION.seatRotate), 90);
  });

  test('rotation is monotonic — the board never jitters backwards', () => {
    const a = spin(1);
    let prev = -Infinity;
    for (let t = 0; t <= DURATION.seatRotate; t += 10) {
      const v = seatRotation(a, t);
      assert.ok(v >= prev - 1e-9, `dipped at ${t}ms`);
      prev = v;
    }
  });

  test('negative steps rotate anticlockwise, the short way round', () => {
    assert.equal(seatRotation(spin(-1), DURATION.seatRotate), -90);
  });

  test('no animation means no rotation', () => {
    assert.equal(seatRotation(null, 12345), 0);
  });
});

describe('check pulse', () => {
  const anim: CheckAnim = {
    kind: 'check', square: 7, army: 'red', startMs: 0, durationMs: DURATION.check,
  };

  test('stays within 0..1 and decays to nothing', () => {
    for (let t = 0; t <= DURATION.check; t += 10) {
      const v = checkPulse(anim, t);
      assert.ok(v >= 0 && v <= 1, `pulse ${v} at ${t}ms`);
    }
    assert.equal(checkPulse(anim, DURATION.check), 0);
    assert.equal(checkPulse(anim, DURATION.check + 500), 0);
  });

  test('it actually pulses — more than one peak, but not a strobe', () => {
    let peaks = 0;
    for (let t = 10; t < DURATION.check - 10; t += 5) {
      const prev = checkPulse(anim, t - 5);
      const cur = checkPulse(anim, t);
      const next = checkPulse(anim, t + 5);
      if (cur > prev && cur > next) peaks++;
    }
    assert.ok(peaks >= 2 && peaks <= 4, `expected 2-4 peaks, got ${peaks}`);
  });
});

describe('elimination fade', () => {
  test('an army with no elimination animation is already fully faded', () => {
    assert.equal(eliminationProgress(NO_ANIMS, 'red', 0), 1);
  });

  test('the fade runs from 0 to 1 over its duration', () => {
    const s = add(NO_ANIMS, {
      kind: 'eliminate', army: 'blue', startMs: 100, durationMs: DURATION.eliminate,
    });
    assert.equal(eliminationProgress(s, 'blue', 100), 0);
    assert.equal(eliminationProgress(s, 'blue', 100 + DURATION.eliminate), 1);
    const mid = eliminationProgress(s, 'blue', 100 + DURATION.eliminate / 2);
    assert.ok(mid > 0 && mid < 1);
    assert.equal(eliminationProgress(s, 'red', 100), 1, 'other armies unaffected');
  });
});
