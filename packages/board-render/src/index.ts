/**
 * @4wc/board-render — walks ui-core scene commands against a Surface port.
 *
 * Backends are adapters: Canvas2D ships first; CanvasKit (web) and react-native-skia (mobile)
 * implement the same port. Nothing here decides what to draw — that is ui-core's job.
 */

export type { PathPaint, Surface, TextPaint } from './surface.ts';
export { renderScene } from './renderer.ts';
export type { RenderOptions } from './renderer.ts';
export { Canvas2DSurface } from './canvas2d.ts';
export type { Canvas2DLike } from './canvas2d.ts';
