/**
 * Capture rollout — horizon resolution in TRUE turn order.
 *
 * At a search leaf, pending exchanges are played out: each army in real turn order takes its
 * best immediate capture when that capture improves its own utility, otherwise passes (a turn
 * skip — not a legal game move, but legitimate in exchange analysis). Passing is what makes
 * this work in four-way chess: the recapturing army is usually two seats away, and without a
 * pass mechanism the rollout would end at the first quiet army and hide exactly the exchanges
 * it exists to reveal ("recaptures live three plies away").
 *
 * This is the piece of Lever 1 that SURVIVED the arena. Best-reply search — both the paranoid
 * and the rational variants — lost to classic max-n at equal budget, because any scheme that
 * compresses three opponent turns into one hands the root double tempo, and tempo distortion
 * is fatal in a points race. The rollout has no such flaw: it runs in true turn order, so it
 * bolts onto the truthful model and only fixes the horizon.
 */

import { generateLegal } from '@4wc/engine';
import type { Army, Position } from '@4wc/engine';
import { evaluate } from './eval.ts';
import type { WeightsByArmy } from './eval.ts';
import { makeScored, orderMoves, unmakeScored, utility } from './core.ts';

type RolloutStep =
  | { kind: 'move'; gained: number }
  | { kind: 'pass'; prevTurn: Army };

export interface RolloutBudget {
  nodes: number;
  budget: number;
}

/**
 * Settle the position's pending exchanges and evaluate the quiet position that results.
 * Restores the position exactly; increments `counter.nodes` per make and per probe eval.
 */
export function captureRollout(
  pos: Position,
  weights: WeightsByArmy,
  maxPlies: number,
  counter: RolloutBudget,
): Record<Army, number> {
  const steps: RolloutStep[] = [];

  for (let ply = 0; ply < maxPlies && counter.nodes < counter.budget; ply++) {
    const mover = pos.turn;
    const captures = orderMoves(
      generateLegal(pos, mover).filter((m) => m.captured !== null),
    ).slice(0, 2);

    let played = false;
    if (captures.length > 0) {
      const standPat = utility(evaluate(pos, weights), mover, pos);
      counter.nodes++;
      for (const m of captures) {
        const gained = makeScored(pos, m);
        counter.nodes++;
        const after = utility(evaluate(pos, weights), mover, pos);
        if (after > standPat + 1e-9) {
          steps.push({ kind: 'move', gained });
          played = true;
          break;
        }
        unmakeScored(pos, gained);
      }
    }

    if (!played) {
      const prevTurn = mover;
      const next = pos.nextActive(mover);
      if (next === mover) break;
      pos.turn = next;
      steps.push({ kind: 'pass', prevTurn });
      const n = pos.activeArmies().length;
      const tail = steps.slice(-n);
      if (tail.length >= n && tail.every((s) => s.kind === 'pass')) break;
    }
  }

  const settled = evaluate(pos, weights);

  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.kind === 'move') unmakeScored(pos, s.gained);
    else pos.turn = s.prevTurn;
  }
  return settled;
}
