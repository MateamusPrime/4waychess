/**
 * The Surface port.
 *
 * The renderer walks ui-core's draw commands and calls ONLY these methods, so a backend is one
 * adapter class: Canvas2D today, CanvasKit and react-native-skia behind the same interface
 * (both expose path-string drawing and 2D transforms, which is exactly why the port is shaped
 * this way). Tests use a recording mock — no canvas anywhere in CI.
 *
 * Angles are radians. Colours are CSS colour strings; adapters translate if their backend
 * needs parsed colour.
 */

import type { Rect } from '@4wc/ui-core';

export interface PathPaint {
  /** Destination rect; the path's viewBox is scaled to fill it. */
  rect: Rect;
  fill: string;
  stroke: string;
  /** Stroke width in destination pixels (not viewBox units). */
  strokeWidth: number;
  fillRule: 'nonzero' | 'evenodd';
  opacity: number;
  /** 0 disables the glow pass. */
  glow: number;
  glowColor: string;
}

export interface TextPaint {
  x: number;
  y: number;
  size: number;
  fill: string;
  align: 'left' | 'center' | 'right';
}

export interface Surface {
  /** Frame boundaries. `begin` clears to the background colour. */
  begin(width: number, height: number, background: string): void;
  end(): void;

  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(radians: number): void;

  fillRect(rect: Rect, color: string, radius: number): void;
  strokeRect(rect: Rect, color: string, width: number, radius: number): void;
  fillCircle(cx: number, cy: number, r: number, color: string): void;
  strokeCircle(cx: number, cy: number, r: number, color: string, width: number): void;
  /** Draw an SVG path string (M/L/C/Z, 100-unit viewBox) scaled into paint.rect. */
  drawPath(d: string, viewBox: number, paint: PathPaint): void;
  fillText(text: string, paint: TextPaint): void;
}
