/**
 * An 8×8 SVG board: squares, pieces from @4wc/pieces, click-to-move with legal-move dots,
 * last-move and check highlights, a best-move arrow, and a promotion chooser.
 */

import { PIECE_FILL_RULE, PIECE_PATHS, PIECE_VIEWBOX } from '@4wc/pieces';
import type { Chess, Square } from 'chess.js';

const NS = 'http://www.w3.org/2000/svg';
const FILES = 'abcdefgh';

export interface BoardMarks {
  lastMove?: { from: string; to: string };
  arrow?: { from: string; to: string };
  check?: string;
}

export interface BoardCallbacks {
  /** Return true to accept a move attempt (from → to, promotion piece if any). */
  onMove: (from: string, to: string, promotion?: string) => boolean;
  /** Whether the user may pick up the piece on `square` right now. */
  canPick: (square: string) => boolean;
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

export class Board {
  readonly svg: SVGSVGElement;
  private flipped = false;
  private selected: string | null = null;
  private legalTargets: Map<string, { promotion: boolean }> = new Map();
  private game: Chess;
  private marks: BoardMarks = {};
  private readonly cb: BoardCallbacks;
  private pendingPromotion: { from: string; to: string } | null = null;

  constructor(game: Chess, cb: BoardCallbacks) {
    this.game = game;
    this.cb = cb;
    this.svg = el('svg', { viewBox: '0 0 800 800', role: 'img', 'aria-label': 'chess board' });
    this.svg.addEventListener('click', (e) => this.onClick(e));
    this.render();
  }

  setFlipped(f: boolean): void { this.flipped = f; this.render(); }
  isFlipped(): boolean { return this.flipped; }
  setMarks(m: BoardMarks): void { this.marks = m; this.render(); }
  clearSelection(): void { this.selected = null; this.legalTargets.clear(); this.pendingPromotion = null; }

  private xy(square: string): { x: number; y: number } {
    const file = FILES.indexOf(square[0]);
    const rank = Number(square[1]) - 1;
    const col = this.flipped ? 7 - file : file;
    const row = this.flipped ? rank : 7 - rank;
    return { x: col * 100, y: row * 100 };
  }

  private squareAt(clientX: number, clientY: number): string | null {
    const r = this.svg.getBoundingClientRect();
    const col = Math.floor(((clientX - r.left) / r.width) * 8);
    const row = Math.floor(((clientY - r.top) / r.height) * 8);
    if (col < 0 || col > 7 || row < 0 || row > 7) return null;
    const file = this.flipped ? 7 - col : col;
    const rank = this.flipped ? row : 7 - row;
    return FILES[file] + String(rank + 1);
  }

  private onClick(e: MouseEvent): void {
    const target = e.target as Element;
    const promo = target.closest('[data-promo]');
    if (promo && this.pendingPromotion) {
      const { from, to } = this.pendingPromotion;
      this.pendingPromotion = null;
      this.cb.onMove(from, to, promo.getAttribute('data-promo')!);
      this.clearSelection();
      this.render();
      return;
    }
    if (this.pendingPromotion) { this.pendingPromotion = null; this.clearSelection(); this.render(); return; }

    const sq = this.squareAt(e.clientX, e.clientY);
    if (!sq) return;
    if (this.selected && this.legalTargets.has(sq)) {
      const from = this.selected;
      if (this.legalTargets.get(sq)!.promotion) {
        this.pendingPromotion = { from, to: sq };
        this.render();
        return;
      }
      this.cb.onMove(from, sq);
      this.clearSelection();
      this.render();
      return;
    }
    if (this.cb.canPick(sq)) {
      this.selected = sq;
      this.legalTargets.clear();
      for (const m of this.game.moves({ square: sq as Square, verbose: true })) {
        this.legalTargets.set(m.to, { promotion: !!m.promotion });
      }
    } else {
      this.clearSelection();
    }
    this.render();
  }

  render(): void {
    const svg = this.svg;
    svg.replaceChildren();
    const dark = getComputedStyle(document.documentElement).getPropertyValue('--sq-dark').trim() || '#7a8fa6';
    const light = getComputedStyle(document.documentElement).getPropertyValue('--sq-light').trim() || '#dfe6ee';

    for (let file = 0; file < 8; file++) {
      for (let rank = 0; rank < 8; rank++) {
        const sq = FILES[file] + String(rank + 1);
        const { x, y } = this.xy(sq);
        const isDark = (file + rank) % 2 === 0;
        svg.appendChild(el('rect', { x, y, width: 100, height: 100, fill: isDark ? dark : light }));
      }
    }
    // Coordinates.
    for (let i = 0; i < 8; i++) {
      const fileIdx = this.flipped ? 7 - i : i;
      const rankIdx = this.flipped ? i : 7 - i;
      const f = el('text', { x: i * 100 + 88, y: 796, 'font-size': 18, fill: 'rgba(0,0,0,.45)', 'font-weight': 700 });
      f.textContent = FILES[fileIdx];
      svg.appendChild(f);
      const r = el('text', { x: 6, y: i * 100 + 22, 'font-size': 18, fill: 'rgba(0,0,0,.45)', 'font-weight': 700 });
      r.textContent = String(rankIdx + 1);
      svg.appendChild(r);
    }

    const highlight = (sq: string, fill: string): void => {
      const { x, y } = this.xy(sq);
      svg.appendChild(el('rect', { x, y, width: 100, height: 100, fill }));
    };
    if (this.marks.lastMove) {
      highlight(this.marks.lastMove.from, 'rgba(255,201,61,.35)');
      highlight(this.marks.lastMove.to, 'rgba(255,201,61,.45)');
    }
    if (this.marks.check) highlight(this.marks.check, 'rgba(255,80,80,.55)');
    if (this.selected) highlight(this.selected, 'rgba(80,160,255,.45)');

    // Pieces.
    for (const row of this.game.board()) {
      for (const p of row) {
        if (!p) continue;
        const { x, y } = this.xy(p.square);
        const g = el('g', { transform: `translate(${x + 6} ${y + 4}) scale(${92 / PIECE_VIEWBOX})` });
        const path = el('path', {
          d: PIECE_PATHS[p.type], 'fill-rule': PIECE_FILL_RULE[p.type],
          fill: p.color === 'w' ? '#f7f2e8' : '#26292e',
          stroke: p.color === 'w' ? '#3a3a3a' : '#c9ced6', 'stroke-width': 2.2, 'stroke-linejoin': 'round',
        });
        g.appendChild(path);
        svg.appendChild(g);
      }
    }

    // Legal-move dots.
    for (const [sq] of this.legalTargets) {
      const { x, y } = this.xy(sq);
      const occupied = this.game.get(sq as Square);
      if (occupied) {
        svg.appendChild(el('circle', { cx: x + 50, cy: y + 50, r: 44, fill: 'none', stroke: 'rgba(30,30,30,.45)', 'stroke-width': 8 }));
      } else {
        svg.appendChild(el('circle', { cx: x + 50, cy: y + 50, r: 14, fill: 'rgba(30,30,30,.4)' }));
      }
    }

    // Best-move arrow.
    if (this.marks.arrow) {
      const a = this.xy(this.marks.arrow.from);
      const b = this.xy(this.marks.arrow.to);
      const x1 = a.x + 50, y1 = a.y + 50, x2 = b.x + 50, y2 = b.y + 50;
      const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      const ex = x2 - ux * 30, ey = y2 - uy * 30;
      const defs = el('defs');
      const marker = el('marker', { id: 'arrowhead', markerWidth: 4, markerHeight: 4, refX: 1, refY: 2, orient: 'auto' });
      marker.appendChild(el('path', { d: 'M0 0 L4 2 L0 4 Z', fill: 'rgba(40,180,90,.9)' }));
      defs.appendChild(marker);
      svg.appendChild(defs);
      svg.appendChild(el('line', {
        x1, y1, x2: ex, y2: ey, stroke: 'rgba(40,180,90,.9)', 'stroke-width': 16,
        'stroke-linecap': 'round', 'marker-end': 'url(#arrowhead)',
      }));
    }

    // Promotion chooser.
    if (this.pendingPromotion) {
      const { to } = this.pendingPromotion;
      const { x } = this.xy(to);
      const color = this.game.turn();
      const top = (this.flipped ? color === 'b' : color === 'w') ? 0 : 400;
      svg.appendChild(el('rect', { x: 0, y: 0, width: 800, height: 800, fill: 'rgba(0,0,0,.45)' }));
      (['q', 'r', 'b', 'n'] as const).forEach((t, i) => {
        const y = top + i * 100;
        const g = el('g', { 'data-promo': t, style: 'cursor:pointer' });
        g.appendChild(el('rect', { x, y, width: 100, height: 100, fill: '#f3f5f8', stroke: '#222', 'stroke-width': 2 }));
        const pg = el('g', { transform: `translate(${x + 6} ${y + 4}) scale(${92 / PIECE_VIEWBOX})` });
        pg.appendChild(el('path', {
          d: PIECE_PATHS[t], 'fill-rule': PIECE_FILL_RULE[t],
          fill: color === 'w' ? '#f7f2e8' : '#26292e', stroke: color === 'w' ? '#3a3a3a' : '#c9ced6', 'stroke-width': 2.2,
        }));
        g.appendChild(pg);
        svg.appendChild(g);
      });
    }
  }
}
