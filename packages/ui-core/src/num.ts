/**
 * Small numeric helpers shared across the view model.
 */

/**
 * Normalise negative zero to positive zero.
 *
 * `-1 * 0` and `Math.min(0, -0)` both yield `-0`. It compares equal to `0` and behaves
 * identically in arithmetic, but it stringifies as "-0" — which is enough to break cell keys,
 * map lookups, serialised scenes and snapshot comparisons in ways that are tedious to trace.
 * Any coordinate or offset that can reach zero through a sign flip goes through here.
 */
export const normalizeZero = (n: number): number => (n === 0 ? 0 : n);

export const clamp = (n: number, lo: number, hi: number): number =>
  normalizeZero(Math.min(hi, Math.max(lo, n)));
