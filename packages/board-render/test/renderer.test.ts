import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startingPosition } from '@4wc/engine';
import {
  DURATION, INITIAL_INTERACTION, NO_ANIMS, THEMES, add, buildScene, computeLayout,
} from '@4wc/ui-core';
import type { Scene, SceneInput } from '@4wc/ui-core';
import { PIECE_PATHS } from '@4wc/pieces';
import { renderScene } from '../src/renderer.ts';
import { Canvas2DSurface } from '../src/canvas2d.ts';
import type { Canvas2DLike } from '../src/canvas2d.ts';
import type { PathPaint, Surface, TextPaint } from '../src/surface.ts';

const VP = { width: 800, height: 800 };

function sceneOf(over: Partial<SceneInput> = {}): Scene {
  const theme = over.theme ?? THEMES.midnight;
  return buildScene({
    ctx: over.ctx ?? { position: startingPosition(), seat: 'red', controllable: ['red'] },
    layout: over.layout ?? computeLayout(VP, theme),
    theme,
    interaction: over.interaction ?? INITIAL_INTERACTION,
    anims: over.anims ?? NO_ANIMS,
    now: over.now ?? 0,
    colorblind: over.colorblind ?? false,
    showCoords: over.showCoords ?? true,
    checked: over.checked ?? [],
  });
}

/** Recording mock — the whole point of the Surface port is that this is all CI needs. */
class RecordingSurface implements Surface {
  calls: { op: string; args: unknown[] }[] = [];
  private log(op: string, ...args: unknown[]): void {
    this.calls.push({ op, args });
  }
  begin(w: number, h: number, bg: string): void { this.log('begin', w, h, bg); }
  end(): void { this.log('end'); }
  save(): void { this.log('save'); }
  restore(): void { this.log('restore'); }
  translate(x: number, y: number): void { this.log('translate', x, y); }
  rotate(r: number): void { this.log('rotate', r); }
  fillRect(): void { this.log('fillRect'); }
  strokeRect(): void { this.log('strokeRect'); }
  fillCircle(): void { this.log('fillCircle'); }
  strokeCircle(): void { this.log('strokeCircle'); }
  drawPath(d: string, viewBox: number, paint: PathPaint): void { this.log('drawPath', d, viewBox, paint); }
  fillText(text: string, paint: TextPaint): void { this.log('fillText', text, paint); }
  ops(op: string): { op: string; args: unknown[] }[] {
    return this.calls.filter((c) => c.op === op);
  }
}

describe('command interpreter', () => {
  test('a frame is bracketed by begin and end, with the theme background', () => {
    const s = new RecordingSurface();
    renderScene(s, sceneOf(), VP);
    assert.equal(s.calls[0].op, 'begin');
    assert.deepEqual(s.calls[0].args, [800, 800, THEMES.midnight.page]);
    assert.equal(s.calls[s.calls.length - 1].op, 'end');
  });

  test('draws 64 piece paths for the opening position', () => {
    const s = new RecordingSurface();
    renderScene(s, sceneOf(), VP);
    assert.equal(s.ops('drawPath').length, 64);
    // Every drawn path is a known piece path.
    const known = new Set(Object.values(PIECE_PATHS));
    for (const c of s.ops('drawPath')) assert.ok(known.has(c.args[0] as string));
  });

  test('no rotation transforms at rest', () => {
    const s = new RecordingSurface();
    renderScene(s, sceneOf(), VP);
    assert.equal(s.ops('rotate').length, 0);
    assert.equal(s.ops('save').length, 0, 'no stray save/restore pairs');
  });

  test('a seat hand-off rotates about the board centre and restores after', () => {
    const anims = add(NO_ANIMS, {
      kind: 'seat', fromSeat: 'red', toSeat: 'blue', steps: 1,
      startMs: 0, durationMs: DURATION.seatRotate,
    });
    const s = new RecordingSurface();
    renderScene(s, sceneOf({ anims, now: DURATION.seatRotate / 2 }), VP);

    assert.equal(s.ops('rotate').length, 1);
    const angle = s.ops('rotate')[0].args[0] as number;
    assert.ok(angle > 0 && angle < Math.PI / 2, `angle ${angle}`);

    // save -> translate(+c) -> rotate -> translate(-c) ... restore, in that order.
    const ops = s.calls.map((c) => c.op);
    const saveI = ops.indexOf('save');
    const rotI = ops.indexOf('rotate');
    const restoreI = ops.lastIndexOf('restore');
    assert.ok(saveI < rotI && rotI < restoreI);
    const [t1, t2] = s.ops('translate');
    assert.deepEqual([t1.args[0], t1.args[1]], [400, (t2.args[1] as number) * -1]);
  });

  test('marker glyphs are drawn only when asked for', () => {
    const s1 = new RecordingSurface();
    renderScene(s1, sceneOf({ showCoords: false }), VP, { markers: false });
    assert.equal(s1.ops('fillText').length, 0);

    const s2 = new RecordingSurface();
    renderScene(s2, sceneOf({ showCoords: false }), VP, { markers: true });
    assert.equal(s2.ops('fillText').length, 64, 'one marker per piece');
    const texts = new Set(s2.ops('fillText').map((c) => c.args[0]));
    assert.equal(texts.size, 4, 'four distinct army markers');
  });

  test('piece opacity and fill flow through to the paint', () => {
    const pos = startingPosition();
    pos.status.blue = 'checkmated';
    const s = new RecordingSurface();
    renderScene(s, sceneOf({ ctx: { position: pos, seat: 'red', controllable: ['red'] } }), VP);
    const opacities = s.ops('drawPath').map((c) => (c.args[2] as PathPaint).opacity);
    assert.ok(opacities.some((o) => o < 0.5), 'dead Blue pieces are faded');
    assert.ok(opacities.some((o) => o === 1), 'live pieces are opaque');
  });
});

describe('Canvas2D adapter', () => {
  function mockCtx(): { ctx: Canvas2DLike; log: string[] } {
    const log: string[] = [];
    const push = (name: string) => (...args: unknown[]) => {
      log.push(`${name}(${args.map((a) => (typeof a === 'object' ? 'o' : String(a))).join(',')})`);
    };
    const ctx = {
      canvas: { width: 800, height: 800 },
      save: push('save'), restore: push('restore'),
      scale: push('scale'), translate: push('translate'), rotate: push('rotate'),
      beginPath: push('beginPath'), roundRect: push('roundRect'), arc: push('arc'),
      fill: push('fill'), stroke: push('stroke'), fillRect: push('fillRect'),
      fillText: push('fillText'),
      fillStyle: '', strokeStyle: '', lineWidth: 0, lineJoin: '',
      globalAlpha: 1, shadowBlur: 0, shadowColor: '', font: '', textAlign: '', textBaseline: '',
    } as Canvas2DLike;
    return { ctx, log };
  }

  class FakePath {
    d: string;
    constructor(d: string) { this.d = d; }
  }

  test('renders a full frame through the adapter without touching a DOM', () => {
    const { ctx, log } = mockCtx();
    const surface = new Canvas2DSurface(ctx, 2, FakePath as never);
    renderScene(surface, sceneOf(), VP);
    assert.equal(log[0], 'save()');
    assert.equal(log[1], 'scale(2,2)', 'device pixel ratio applied once per frame');
    assert.ok(log.filter((l) => l.startsWith('fill(')).length >= 64, 'pieces filled');
    assert.equal(log[log.length - 1], 'restore()');
  });

  test('Path2D objects are cached per path string', () => {
    let constructed = 0;
    class CountingPath {
      d: string;
      constructor(d: string) { this.d = d; constructed++; }
    }
    const { ctx } = mockCtx();
    const surface = new Canvas2DSurface(ctx, 1, CountingPath as never);
    renderScene(surface, sceneOf(), VP);
    renderScene(surface, sceneOf(), VP);
    // Two full frames, 128 piece draws, but only 6 distinct piece paths exist.
    assert.equal(constructed, 6);
  });

  test('square (radius 0) rects use the fast fillRect path', () => {
    const { ctx, log } = mockCtx();
    const surface = new Canvas2DSurface(ctx, 1, FakePath as never);
    renderScene(surface, sceneOf(), VP);
    assert.ok(log.filter((l) => l.startsWith('fillRect')).length >= 160,
      'Midnight squares have no radius and must not build paths');
    assert.equal(log.filter((l) => l.startsWith('roundRect')).length, 0);
  });

  test('rounded themes go through roundRect instead', () => {
    const { ctx, log } = mockCtx();
    const surface = new Canvas2DSurface(ctx, 1, FakePath as never);
    renderScene(surface, sceneOf({
      theme: THEMES.storybook,
      layout: computeLayout(VP, THEMES.storybook),
    }), VP);
    assert.ok(log.filter((l) => l.startsWith('roundRect')).length >= 160);
  });
});
