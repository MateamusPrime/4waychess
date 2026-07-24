/**
 * Scene building — turning game state into a flat list of draw commands.
 *
 * This is the seam that makes the visual layer testable. Everything about *what the board looks
 * like* is decided here in pure data; the Skia layer only walks the list and issues draw calls.
 * That has three payoffs:
 *
 *  1. Appearance can be unit-tested — no canvas, no snapshots, no browser.
 *  2. The renderer is dumb enough to be ported between CanvasKit and react-native-skia
 *     essentially unchanged, which is what makes "one board on web and mobile" real.
 *  3. A second renderer (SVG for exports, a debug renderer, a text renderer for tests) costs
 *     almost nothing.
 *
 * Commands carry PIXEL coordinates, already resolved. The renderer performs no layout at all.
 */

import { isDarkSquare, squareName } from '@4wc/engine';
import type { Army, PieceType } from '@4wc/engine';
import type { Rect } from './layout.ts';
import { cellRect, insetRect, rectCenter, squareRect } from './layout.ts';
import type { BoardLayout } from './layout.ts';
import type { Theme } from './themes.ts';
import { armyColor } from './themes.ts';
import { coordLabels, toCell, visibleCells } from './view.ts';
import type { AnimState } from './animation.ts';
import {
  DURATION, checkPulse, easeOutCubic, eliminationProgress, findMoveAnim, findSeatAnim,
  progress, seatRotation,
} from './animation.ts';
import type { InteractionState } from './interaction.ts';
import { selectedSquare, targetsOf } from './interaction.ts';
import type { InteractionContext } from './interaction.ts';

/** A semantic tag on every command, for tests, debugging and hit-region overlays. */
export type Role =
  | 'board-frame' | 'square-light' | 'square-dark'
  | 'highlight-last' | 'highlight-selected' | 'highlight-check' | 'highlight-cursor'
  | 'legal-dot' | 'capture-ring'
  | 'piece' | 'piece-ghost' | 'coord-file' | 'coord-rank' | 'marker';

export type DrawCmd =
  | { kind: 'rect'; role: Role; rect: Rect; fill: string; radius: number }
  | { kind: 'outline'; role: Role; rect: Rect; stroke: string; width: number; radius: number }
  | { kind: 'circle'; role: Role; cx: number; cy: number; r: number; fill: string }
  | { kind: 'ring'; role: Role; cx: number; cy: number; r: number; stroke: string; width: number }
  | {
      kind: 'piece'; role: Role; rect: Rect; army: Army; piece: PieceType; promoted: boolean;
      fill: string; stroke: string; strokeWidth: number; glow: number; opacity: number;
    }
  | {
      kind: 'text'; role: Role; x: number; y: number; text: string; fill: string;
      size: number; align: 'left' | 'center' | 'right';
    };

export interface Scene {
  /** Page background colour. */
  background: string;
  /**
   * Board rotation in degrees, about `rotationCenter`. Non-zero only during a seat hand-off,
   * and back to 0 the moment it completes — at which point the commands are already projected
   * from the incoming seat.
   */
  rotation: number;
  rotationCenter: { x: number; y: number };
  commands: DrawCmd[];
}

export interface SceneInput {
  ctx: InteractionContext;
  layout: BoardLayout;
  theme: Theme;
  interaction: InteractionState;
  anims: AnimState;
  now: number;
  colorblind: boolean;
  showCoords: boolean;
  /** Armies whose king is currently in check, for the pulse overlay. */
  checked: readonly Army[];
}

export function buildScene(input: SceneInput): Scene {
  const { ctx, layout, theme, interaction, anims, now, colorblind, showCoords } = input;
  const pos = ctx.position;
  const cmds: DrawCmd[] = [];

  const seatAnim = findSeatAnim(anims, now);

  /**
   * While a seat hand-off is spinning we project from the OUTGOING seat and rotate toward the
   * incoming one, so the rotation runs 0 -> 90 and lands exactly on the new seat's view.
   *
   * The scene decides this rather than the host on purpose. If the host had to switch `ctx.seat`
   * at precisely the frame the animation ended, being one tick early or late would show a
   * visible flash of the wrong orientation. Owning it here means the host can set the new seat
   * the instant it starts the animation and never think about it again.
   */
  const seat: Army = seatAnim !== null ? seatAnim.fromSeat : ctx.seat;

  // --- board frame -------------------------------------------------
  cmds.push({
    kind: 'rect', role: 'board-frame', rect: layout.board,
    fill: theme.boardFrame, radius: layout.radius * 1.5,
  });

  // --- squares -----------------------------------------------------
  const cells = visibleCells(seat);
  for (const { cell, square } of cells) {
    const rect = cellRect(layout, cell.col, cell.row);
    const dark = isDarkSquare(square);
    cmds.push({
      kind: 'rect',
      role: dark ? 'square-dark' : 'square-light',
      rect,
      fill: dark ? theme.squareDark : theme.squareLight,
      radius: layout.radius,
    });
  }

  // --- last move ---------------------------------------------------
  const last = interaction.lastMove;
  if (last !== null) {
    for (const sq of [last.from, last.to]) {
      cmds.push({
        kind: 'rect', role: 'highlight-last', rect: squareRect(layout, seat, sq),
        fill: theme.highlightLast, radius: layout.radius,
      });
    }
  }

  // --- selection ---------------------------------------------------
  const sel = selectedSquare(interaction);
  if (sel >= 0) {
    const rect = squareRect(layout, seat, sel);
    cmds.push({
      kind: 'rect', role: 'highlight-selected', rect,
      fill: theme.highlightSelected, radius: layout.radius,
    });
    cmds.push({
      kind: 'outline', role: 'highlight-selected', rect,
      stroke: theme.selectedOutline, width: Math.max(1.5, layout.square * 0.045),
      radius: layout.radius,
    });
  }

  // --- check pulse -------------------------------------------------
  for (const a of input.checked) {
    const king = pos.kingSquare(a);
    if (king < 0) continue;
    const anim = anims.anims.find((x) => x.kind === 'check' && x.army === a);
    const pulse = anim !== undefined && anim.kind === 'check' ? checkPulse(anim, now) : 0.45;
    if (pulse <= 0) continue;
    const rect = squareRect(layout, seat, king);
    cmds.push({
      kind: 'rect', role: 'highlight-check', rect,
      fill: withAlpha(theme.checkGlow, pulse), radius: layout.radius,
    });
  }

  // --- keyboard cursor ---------------------------------------------
  if (interaction.cursor >= 0) {
    cmds.push({
      kind: 'outline', role: 'highlight-cursor',
      rect: squareRect(layout, seat, interaction.cursor),
      stroke: theme.accent, width: Math.max(1, layout.square * 0.03), radius: layout.radius,
    });
  }

  // --- pieces ------------------------------------------------------
  const moveAnim = findMoveAnim(anims, now);
  const slideT = moveAnim === null
    ? 1
    : progress(moveAnim.startMs, moveAnim.durationMs, now, easeOutCubic);

  for (const { cell, square } of cells) {
    const piece = pos.at(square);
    if (piece === null) continue;

    // A piece mid-slide is drawn separately, at its interpolated position.
    if (moveAnim !== null && square === moveAnim.to) continue;

    let opacity = pos.isActive(piece.army) ? 1 : 0.32;
    // A captured victim fades out rather than vanishing.
    if (moveAnim !== null && moveAnim.capturedSq === square) opacity *= 1 - slideT;
    // An army being eliminated greys down over the elimination animation.
    if (!pos.isActive(piece.army)) {
      const t = eliminationProgress(anims, piece.army, now);
      opacity = 1 - 0.68 * t;
    }

    cmds.push(pieceCmd(cellRect(layout, cell.col, cell.row), piece, theme, colorblind, opacity, layout));
  }

  if (moveAnim !== null) {
    const piece = pos.at(moveAnim.to);
    if (piece !== null) {
      const from = squareRect(layout, seat, moveAnim.from);
      const to = squareRect(layout, seat, moveAnim.to);
      const rect: Rect = {
        x: from.x + (to.x - from.x) * slideT,
        y: from.y + (to.y - from.y) * slideT,
        w: to.w, h: to.h,
      };
      cmds.push(pieceCmd(rect, piece, theme, colorblind, 1, layout));
    }
  }

  // --- legal move indicators (above pieces, so captures read clearly) ---
  const { quiet, captures } = targetsOf(ctx, interaction);
  for (const sq of quiet) {
    const c = rectCenter(squareRect(layout, seat, sq));
    cmds.push({
      kind: 'circle', role: 'legal-dot', cx: c.x, cy: c.y,
      r: layout.square * 0.13, fill: theme.legalDot,
    });
  }
  for (const sq of captures) {
    const c = rectCenter(squareRect(layout, seat, sq));
    cmds.push({
      kind: 'ring', role: 'capture-ring', cx: c.x, cy: c.y,
      r: layout.square * 0.42, stroke: theme.captureRing,
      width: Math.max(1.5, layout.square * 0.07),
    });
  }

  // --- coordinates -------------------------------------------------
  if (showCoords) {
    const { files, ranks } = coordLabels(seat);
    const size = Math.max(7, layout.square * 0.24);
    for (const { cell, square } of files) {
      const r = cellRect(layout, cell.col, cell.row);
      cmds.push({
        kind: 'text', role: 'coord-file',
        x: r.x + r.w - size * 0.3, y: r.y + r.h - size * 0.25,
        text: squareName(square).slice(0, 1), fill: theme.coord, size, align: 'right',
      });
    }
    for (const { cell, square } of ranks) {
      const r = cellRect(layout, cell.col, cell.row);
      cmds.push({
        kind: 'text', role: 'coord-rank',
        x: r.x + size * 0.3, y: r.y + size,
        text: squareName(square).slice(1), fill: theme.coord, size, align: 'left',
      });
    }
  }

  return {
    background: theme.page,
    rotation: seatRotation(seatAnim, now),
    rotationCenter: rectCenter(layout.board),
    commands: cmds,
  };
}

function pieceCmd(
  rect: Rect,
  piece: { army: Army; type: PieceType; promoted: boolean },
  theme: Theme,
  colorblind: boolean,
  opacity: number,
  layout: BoardLayout,
): DrawCmd {
  return {
    kind: 'piece', role: 'piece',
    rect: insetRect(rect, theme.pieceScale),
    army: piece.army, piece: piece.type, promoted: piece.promoted,
    fill: armyColor(theme, piece.army, colorblind),
    stroke: theme.pieceStroke,
    strokeWidth: layout.square * theme.pieceStrokeRatio,
    glow: theme.pieceGlow,
    opacity,
  };
}

/**
 * Apply an alpha multiplier to a colour string.
 * Handles the two forms the theme tokens actually use: #rrggbb and rgba(...).
 */
export function withAlpha(color: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha));
  const rgba = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/.exec(color);
  if (rgba !== null) {
    const base = rgba[4] === undefined ? 1 : Number(rgba[4]);
    return `rgba(${rgba[1]}, ${rgba[2]}, ${rgba[3]}, ${round(base * a)})`;
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (hex !== null) {
    const n = parseInt(hex[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${round(a)})`;
  }
  return color;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Commands with a given role — the main handle tests use to inspect a scene. */
export function commandsWithRole(scene: Scene, role: Role): DrawCmd[] {
  return scene.commands.filter((c) => c.role === role);
}

/** Draw order of roles, for asserting that layering is correct. */
export function roleOrder(scene: Scene): Role[] {
  const seen: Role[] = [];
  for (const c of scene.commands) {
    if (seen[seen.length - 1] !== c.role) seen.push(c.role);
  }
  return seen;
}
