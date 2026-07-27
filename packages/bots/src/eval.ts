/**
 * Position evaluation, four-way-specific.
 *
 * The cardinal rule: in FFA the points race IS the win condition (RULES.md §10), so banked
 * points weigh alongside material. A bot that plays "good chess" while ignoring the score is
 * playing the wrong game — it will decline a +9 queen capture to improve a structure that
 * never pays out.
 *
 * Weights are PER ARMY: max-n assumes each player maximises their own utility, and giving each
 * army its own weight profile is exactly how four different personalities sit at one table.
 *
 * Kept deliberately cheap — one board scan plus O(pieces × kings) — because search calls this
 * at every leaf and the per-move budget is milliseconds.
 */

import {
  ARMIES, PARTNER, PIECE_VALUES, codeArmy, codePromoted, codeType, fileOf, rankOf, toOwn,
} from '@4wc/engine';
import type { Army, PieceType, Position } from '@4wc/engine';

export interface EvalWeights {
  /** Banked FFA points. 1.0 means one banked point is worth one unit. */
  points: number;
  /** Own material on the board, at capture values. */
  material: number;
  /** Centralisation: pieces near the middle of the 14x14 board. */
  center: number;
  /** Pawn progress toward the promotion rank. */
  pawnAdvance: number;
  /** Penalty for enemy pressure near the own king (higher = more cautious). */
  kingSafety: number;
  /** Bonus for own pressure near enemy kings (higher = more aggressive). */
  aggression: number;
  /** Kingmaker: how much this army wants the current leader pulled down. */
  leaderAversion: number;
}

export const DEFAULT_WEIGHTS: EvalWeights = {
  points: 1.0,
  material: 0.9,
  center: 0.03,
  pawnAdvance: 0.05,
  kingSafety: 0.35,
  aggression: 0.15,
  leaderAversion: 0,
};

export type WeightsByArmy = Readonly<Record<Army, EvalWeights>>;

export function uniformWeights(w: EvalWeights = DEFAULT_WEIGHTS): WeightsByArmy {
  return { red: w, blue: w, yellow: w, green: w };
}

interface PieceInfo {
  army: Army;
  type: PieceType;
  x: number;
  y: number;
  value: number;
}

/** Score for every army, each computed with that army's own weights. Higher is better. */
export function evaluate(pos: Position, weights: WeightsByArmy): Record<Army, number> {
  const pieces: PieceInfo[] = [];
  const kings: Partial<Record<Army, { x: number; y: number }>> = {};
  const material: Record<Army, number> = { red: 0, blue: 0, yellow: 0, green: 0 };
  const center: Record<Army, number> = { red: 0, blue: 0, yellow: 0, green: 0 };
  const pawnAdv: Record<Army, number> = { red: 0, blue: 0, yellow: 0, green: 0 };

  for (let s = 0; s < pos.board.length; s++) {
    const code = pos.board[s];
    if (code === 0) continue;
    const army = codeArmy(code);
    if (!pos.isActive(army)) continue; // dead pieces are terrain: no value, no threat
    const type = codeType(code);
    const x = fileOf(s);
    const y = rankOf(s);
    const value = type === 'q' && codePromoted(code) ? 1 : PIECE_VALUES[type];

    if (type === 'k') {
      kings[army] = { x, y };
    } else {
      material[army] += value;
      // Distance from board centre (6.5, 6.5): 0 at centre, ~1 at the rim.
      const d = Math.max(Math.abs(x - 6.5), Math.abs(y - 6.5)) / 6.5;
      center[army] += (1 - d) * value;
      if (type === 'p') {
        const ownRank = toOwn(army, s)[1];
        // Progress from the starting rank (2) toward promotion (8 in FFA, 11 in Teams).
        const span = pos.rules.promotionRank - 2;
        pawnAdv[army] += Math.max(0, ownRank - 2) / span;
      }
    }
    pieces.push({ army, type, x, y, value });
  }

  // Pressure: how much enemy material bears near each king, discounted by distance.
  const danger: Record<Army, number> = { red: 0, blue: 0, yellow: 0, green: 0 };
  const pressure: Record<Army, number> = { red: 0, blue: 0, yellow: 0, green: 0 };
  for (const p of pieces) {
    if (p.type === 'k') continue;
    for (const a of ARMIES) {
      const k = kings[a];
      if (k === undefined || !pos.areEnemies(p.army, a)) continue;
      const cheb = Math.max(Math.abs(p.x - k.x), Math.abs(p.y - k.y));
      const w = p.value / (1 + cheb);
      danger[a] += w;      // enemy piece threatening a's king
      pressure[p.army] += w; // the same term credited to the attacker
    }
  }

  const base: Record<Army, number> = { red: 0, blue: 0, yellow: 0, green: 0 };
  for (const a of ARMIES) {
    const w = weights[a];
    if (!pos.isActive(a)) {
      // Eliminated players keep their banked points — in FFA they can still win (RULES.md §12).
      base[a] = w.points * pos.points[a];
      continue;
    }
    base[a] =
      w.points * pos.points[a] +
      w.material * material[a] +
      w.center * center[a] +
      w.pawnAdvance * pawnAdv[a] -
      w.kingSafety * danger[a] +
      w.aggression * pressure[a];
  }

  // Kingmaker: subtract a slice of the leading opponent's standing from your own score, so
  // lines that pull the leader down look better than lines that ignore them.
  const out: Record<Army, number> = { ...base };
  for (const a of ARMIES) {
    const w = weights[a];
    if (w.leaderAversion <= 0 || !pos.isActive(a)) continue;
    let leader: Army | null = null;
    let best = -Infinity;
    for (const other of ARMIES) {
      if (!pos.areEnemies(a, other)) continue;
      const standing = pos.points[other] + material[other];
      if (standing > best) {
        best = standing;
        leader = other;
      }
    }
    if (leader !== null) out[a] = base[a] - w.leaderAversion * best;
  }

  // Teams: your partner's fate is your own. Each army adds its partner's base standing, which
  // also makes "do not hurt your partner" fall out of the numbers rather than a special case.
  if (pos.rules.mode === 'teams') {
    for (const a of ARMIES) out[a] = out[a] + base[PARTNER[a]];
  }

  return out;
}
