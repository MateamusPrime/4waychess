/**
 * Seeded xorshift32.
 *
 * Bots must be deterministic under a seed: reproducible tests, replayable bugs, and — later —
 * server-side verification that a bot move was really produced by the claimed bot. Math.random
 * is banned in this package by the architecture test for exactly that reason.
 */

export type Rng = () => number;

export function makeRng(seed: number): Rng {
  // Mix the seed and warm the generator up. Raw xorshift32 emits TINY first outputs for small
  // seeds (1 -> ~6e-5), which made "seeds 1..12" all roll the same softmax choice — every bot
  // opened identically regardless of seed. Knuth's multiplicative hash spreads the seed across
  // the word, and two discarded outputs finish the job.
  let s = (Math.imul(seed, 2654435761) >>> 0) || 0x9e3779b9;
  const next = (): number => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
  next();
  next();
  return next;
}
