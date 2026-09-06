/** A deterministic `[0, 1)` source. Matches the `Math.random` signature. */
export type Random = () => number;

/**
 * Linear congruential generator, seeded. Same constants and the same `>>> 0`
 * wraparound as the simulation, so seeded art and series reproduce exactly.
 * `index.html:1088`
 */
export function rng(seed: number): Random {
  let s = seed >>> 0 || 1;
  return function next(): number {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * FNV-1a, 32-bit unsigned. Used to derive stable seeds from addresses and
 * tickers. `index.html:1089`
 */
export function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h;
}
