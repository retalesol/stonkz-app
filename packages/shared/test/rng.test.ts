import { describe, expect, it } from 'vitest';
import { hash, rng } from '../src/rng.js';

describe('rng', () => {
  it('is deterministic for a seed', () => {
    const a = rng(1009);
    const b = rng(1009);
    const first = [a(), a(), a(), a(), a()];
    const second = [b(), b(), b(), b(), b()];
    expect(first).toEqual(second);
  });

  it('reproduces the LCG sequence exactly', () => {
    const r = rng(1);
    // s = (1 * 1664525 + 1013904223) >>> 0 = 1015568748
    expect(r()).toBe(1015568748 / 4294967296);
    // s = (1015568748 * 1664525 + 1013904223) >>> 0
    expect(r()).toBe(((1015568748 * 1664525 + 1013904223) >>> 0) / 4294967296);
  });

  it('stays inside [0, 1)', () => {
    const r = rng(0xdeadbeef);
    for (let i = 0; i < 2000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('treats seed 0 as seed 1', () => {
    const zero = rng(0);
    const one = rng(1);
    expect(zero()).toBe(one());
  });

  it('coerces negative seeds through the unsigned shift', () => {
    const neg = rng(-1);
    const max = rng(4294967295);
    expect(neg()).toBe(max());
  });

  it('produces different streams for different seeds', () => {
    expect(rng(1009)()).not.toBe(rng(1586)());
  });
});

describe('hash', () => {
  it('matches canonical FNV-1a while the product still fits in a double', () => {
    expect(hash('')).toBe(2166136261);
    expect(hash('a')).toBe(0xe40c292c);
  });

  it('keeps the float-multiply drift the simulation has', () => {
    // `h * 16777619` overflows 2^53 once h is large, so the low bits differ
    // from true FNV-1a. Every seeded avatar and stake series in index.html was
    // generated with this drift, so it is the behaviour, not a bug to fix.
    expect(hash('foobar')).toBe(249808880);
    expect(hash('foobar')).not.toBe(0xbf9cf968);
  });

  it('always returns an unsigned 32-bit integer', () => {
    for (const s of ['7xKQ8mNvUx9fRt', 'WOJAK', 'a'.repeat(200)]) {
      const h = hash(s);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it('is stable and case sensitive', () => {
    expect(hash('GIGA')).toBe(hash('GIGA'));
    expect(hash('GIGA')).not.toBe(hash('giga'));
  });
});
