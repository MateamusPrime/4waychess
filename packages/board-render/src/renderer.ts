/**
 * The command interpreter: Scene in, Surface calls out.
 *
 * Deliberately dumb. Every decision about WHAT to draw was made in ui-core; this file only
 * translates commands into port calls. If logic starts accumulating here, it belongs in
 * ui-core where it can be unit-tested against the scene, not against a mock surface.
 */

import type { Scene, Viewport } from '@4wc/ui-core';
import { ARMY_MARKER } from '@4wc/ui-core';
import { PIECE_FILL_RULE, PIECE_PATHS, PIECE_VIEWBOX, PROMOTED_BADGE } from '@4wc/pieces';
import type { Surface } from './surface.ts';

export interface RenderOptions {
  /** Draw per-army marker glyphs on pieces, for colour-independence (RISKS.md R11). */
  markers: boolean;
}

export function renderScene(
  surface: Surface,
  scene: Scene,
  viewport: Viewport,
  options: RenderOptions = { markers: false },
): void {
  surface.begin(viewport.width, viewport.height, scene.background);

  const rotated = scene.rotation !== 0;
  if (rotated) {
    surface.save();
    surface.translate(scene.rotationCenter.x, scene.rotationCenter.y);
    surface.rotate((scene.rotation * Math.PI) / 180);
    surface.translate(-scene.rotationCenter.x, -scene.rotationCenter.y);
  }

  for (const cmd of scene.commands) {
    switch (cmd.kind) {
      case 'rect':
        surface.fillRect(cmd.rect, cmd.fill, cmd.radius);
        break;
      case 'outline':
        surface.strokeRect(cmd.rect, cmd.stroke, cmd.width, cmd.radius);
        break;
      case 'circle':
        surface.fillCircle(cmd.cx, cmd.cy, cmd.r, cmd.fill);
        break;
      case 'ring':
        surface.strokeCircle(cmd.cx, cmd.cy, cmd.r, cmd.stroke, cmd.width);
        break;
      case 'piece': {
        surface.drawPath(PIECE_PATHS[cmd.piece], PIECE_VIEWBOX, {
          rect: cmd.rect,
          fill: cmd.fill,
          stroke: cmd.stroke,
          strokeWidth: cmd.strokeWidth,
          fillRule: PIECE_FILL_RULE[cmd.piece],
          opacity: cmd.opacity,
          glow: cmd.glow,
          glowColor: cmd.fill,
        });
        // A promoted (1-point) queen carries a badge ring: it is worth 8 points less than it
        // looks, and that difference must be visible on the board, not just in a tooltip.
        if (cmd.promoted && cmd.piece === 'q') {
          const s = cmd.rect.w / PIECE_VIEWBOX;
          surface.strokeCircle(
            cmd.rect.x + PROMOTED_BADGE.cx * s,
            cmd.rect.y + PROMOTED_BADGE.cy * s,
            PROMOTED_BADGE.r * s,
            cmd.stroke,
            Math.max(1, cmd.strokeWidth),
          );
        }
        if (options.markers) {
          surface.fillText(ARMY_MARKER[cmd.army], {
            x: cmd.rect.x + cmd.rect.w * 0.92,
            y: cmd.rect.y + cmd.rect.h * 0.98,
            size: cmd.rect.w * 0.28,
            fill: cmd.stroke,
            align: 'right',
          });
        }
        break;
      }
      case 'text':
        surface.fillText(cmd.text, {
          x: cmd.x, y: cmd.y, size: cmd.size, fill: cmd.fill, align: cmd.align,
        });
        break;
    }
  }

  if (rotated) surface.restore();
  surface.end();
}
