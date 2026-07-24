/**
 * Canvas2D adapter for the Surface port.
 *
 * The shipping web backend for Phase 1. CanvasKit implements the same port later — its API is
 * deliberately close (path strings, save/restore, transforms), which is why the port is shaped
 * the way it is. Nothing outside this file touches a canvas API.
 *
 * Path2D objects are cached per path string: pieces redraw every frame, and re-parsing sixty
 * paths per frame is measurable on low-end phones.
 */

import type { PathPaint, Surface, TextPaint } from './surface.ts';
import type { Rect } from '@4wc/ui-core';

/** Structural subset of CanvasRenderingContext2D — keeps this file testable without a DOM. */
export interface Canvas2DLike {
  canvas: { width: number; height: number };
  save(): void;
  restore(): void;
  scale(x: number, y: number): void;
  translate(x: number, y: number): void;
  rotate(rad: number): void;
  beginPath(): void;
  roundRect(x: number, y: number, w: number, h: number, r: number): void;
  arc(x: number, y: number, r: number, start: number, end: number): void;
  fill(path?: unknown, rule?: string): void;
  stroke(path?: unknown): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  lineJoin: string;
  globalAlpha: number;
  shadowBlur: number;
  shadowColor: string;
  font: string;
  textAlign: string;
  textBaseline: string;
}

type Path2DCtor = new (d: string) => object;

export class Canvas2DSurface implements Surface {
  private ctx: Canvas2DLike;
  private dpr: number;
  private pathCache = new Map<string, object>();
  private makePath: Path2DCtor;

  constructor(ctx: Canvas2DLike, dpr = 1, pathCtor?: Path2DCtor) {
    this.ctx = ctx;
    this.dpr = dpr;
    // Injectable for tests; defaults to the global Path2D in a browser.
    this.makePath = pathCtor ?? (globalThis as { Path2D?: Path2DCtor }).Path2D as Path2DCtor;
  }

  private path(d: string): object {
    let p = this.pathCache.get(d);
    if (p === undefined) {
      p = new this.makePath(d);
      this.pathCache.set(d, p);
    }
    return p;
  }

  begin(width: number, height: number, background: string): void {
    const c = this.ctx;
    c.save();
    c.scale(this.dpr, this.dpr);
    c.fillStyle = background;
    c.fillRect(0, 0, width, height);
  }

  end(): void {
    this.ctx.restore();
  }

  save(): void { this.ctx.save(); }
  restore(): void { this.ctx.restore(); }
  translate(x: number, y: number): void { this.ctx.translate(x, y); }
  rotate(radians: number): void { this.ctx.rotate(radians); }

  private rectPath(rect: Rect, radius: number): void {
    this.ctx.beginPath();
    this.ctx.roundRect(rect.x, rect.y, rect.w, rect.h, radius);
  }

  fillRect(rect: Rect, color: string, radius: number): void {
    this.ctx.fillStyle = color;
    if (radius <= 0) {
      this.ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      return;
    }
    this.rectPath(rect, radius);
    this.ctx.fill();
  }

  strokeRect(rect: Rect, color: string, width: number, radius: number): void {
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = width;
    this.rectPath(rect, radius);
    this.ctx.stroke();
  }

  fillCircle(cx: number, cy: number, r: number, color: string): void {
    this.ctx.fillStyle = color;
    this.ctx.beginPath();
    this.ctx.arc(cx, cy, r, 0, Math.PI * 2);
    this.ctx.fill();
  }

  strokeCircle(cx: number, cy: number, r: number, color: string, width: number): void {
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = width;
    this.ctx.beginPath();
    this.ctx.arc(cx, cy, r, 0, Math.PI * 2);
    this.ctx.stroke();
  }

  drawPath(d: string, viewBox: number, paint: PathPaint): void {
    const c = this.ctx;
    const p = this.path(d);
    const s = paint.rect.w / viewBox;

    c.save();
    c.globalAlpha = paint.opacity;
    c.translate(paint.rect.x, paint.rect.y);
    c.scale(s, paint.rect.h / viewBox);

    if (paint.glow > 0) {
      c.shadowBlur = (8 * paint.glow) / s;
      c.shadowColor = paint.glowColor;
    }
    c.fillStyle = paint.fill;
    c.fill(p, paint.fillRule);
    c.shadowBlur = 0;

    if (paint.strokeWidth > 0) {
      c.strokeStyle = paint.stroke;
      // lineWidth is applied in the scaled space, so unscale to keep it in device pixels.
      c.lineWidth = paint.strokeWidth / s;
      c.lineJoin = 'round';
      c.stroke(p);
    }
    c.restore();
  }

  fillText(text: string, paint: TextPaint): void {
    const c = this.ctx;
    c.fillStyle = paint.fill;
    c.font = `600 ${paint.size}px system-ui, sans-serif`;
    c.textAlign = paint.align;
    c.textBaseline = 'alphabetic';
    c.fillText(text, paint.x, paint.y);
  }
}
