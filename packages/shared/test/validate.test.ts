import { describe, expect, it } from 'vitest';
import { MIN_TIP_ETH, MIN_TIP_SOL, SUPPLIES } from '../src/constants.js';
import { DEFAULT_CURVE_PARAMS } from '../src/params.js';
import {
  isTickerTaken,
  isValidCurveFee,
  isValidSupply,
  isValidTicker,
  isValidTip,
  minTip,
  nativeUnit,
  normalizeTicker,
} from '../src/validate.js';

describe('normalizeTicker — GOLDEN', () => {
  it('uppercases', () => {
    expect(normalizeTicker('wojak')).toBe('WOJAK');
  });

  it('strips everything outside A-Z0-9', () => {
    expect(normalizeTicker('$WOJAK!')).toBe('WOJAK');
    expect(normalizeTicker('pe pe-2.0')).toBe('PEPE20');
    expect(normalizeTicker('  giga  ')).toBe('GIGA');
    expect(normalizeTicker('🚀moon🚀')).toBe('MOON');
  });

  it('keeps digits', () => {
    expect(normalizeTicker('PEPE2')).toBe('PEPE2');
    expect(normalizeTicker('1000X')).toBe('1000X');
  });

  it('truncates to ten characters', () => {
    expect(normalizeTicker('ABCDEFGHIJKLMNOP')).toBe('ABCDEFGHIJ');
    expect(normalizeTicker('ABCDEFGHIJKLMNOP')).toHaveLength(10);
    // Stripping happens before truncation, so punctuation does not eat length.
    expect(normalizeTicker('A-B-C-D-E-F-G-H-I-J-K')).toBe('ABCDEFGHIJ');
  });

  it('collapses empty and nullish input to an empty string', () => {
    expect(normalizeTicker('')).toBe('');
    expect(normalizeTicker('---')).toBe('');
    expect(normalizeTicker(null)).toBe('');
    expect(normalizeTicker(undefined)).toBe('');
  });
});

describe('isValidTicker', () => {
  it('accepts anything that normalises to at least one character', () => {
    expect(isValidTicker('WOJAK')).toBe(true);
    expect(isValidTicker('a')).toBe(true);
  });

  it('rejects empty results', () => {
    expect(isValidTicker('')).toBe(false);
    expect(isValidTicker('!!!')).toBe(false);
    expect(isValidTicker(null)).toBe(false);
  });
});

describe('isTickerTaken', () => {
  const taken = ['GIGA', 'WOJAK', 'PEPE2'];

  it('detects a collision after normalisation', () => {
    expect(isTickerTaken('wojak', taken)).toBe(true);
    expect(isTickerTaken('$GIGA', taken)).toBe(true);
  });

  it('allows a fresh ticker', () => {
    expect(isTickerTaken('COPIUM', taken)).toBe(false);
  });

  it('treats an unusable ticker as not taken — isValidTicker rejects it first', () => {
    expect(isTickerTaken('!!!', taken)).toBe(false);
  });
});

describe('nativeUnit', () => {
  it('is SOL on Solana and ETH on Robinhood', () => {
    expect(nativeUnit('SOL')).toBe('SOL');
    expect(nativeUnit('RH')).toBe('ETH');
    expect(nativeUnit('BASE')).toBe('ETH');
  });
});

describe('isEvm / parseNet', () => {
  it('treats RH and BASE as EVM', async () => {
    const { isEvm, parseNet, inferNetFromAddress } = await import('../src/validate.js');
    expect(isEvm('RH')).toBe(true);
    expect(isEvm('BASE')).toBe(true);
    expect(isEvm('SOL')).toBe(false);
    expect(parseNet('BASE')).toBe('BASE');
    expect(parseNet('foo')).toBeNull();
    expect(inferNetFromAddress('0x' + 'a'.repeat(40), 'BASE')).toBe('BASE');
    expect(inferNetFromAddress('7xKQ8mNvRk4pB2sT9dLcW6hJ1yZaQe3Ux9fRt')).toBe('SOL');
  });
});

describe('minTip — GOLDEN', () => {
  it('is 0.001 SOL', () => {
    expect(minTip('SOL')).toBe(0.001);
    expect(MIN_TIP_SOL).toBe(0.001);
  });

  it('is 0.0001 ETH', () => {
    expect(minTip('ETH')).toBe(0.0001);
    expect(MIN_TIP_ETH).toBe(0.0001);
  });
});

describe('isValidTip', () => {
  it('accepts a tip at or above the floor', () => {
    expect(isValidTip(0.001, 'SOL')).toBe(true);
    expect(isValidTip(0.35, 'SOL')).toBe(true);
    expect(isValidTip(0.0001, 'ETH')).toBe(true);
  });

  it('rejects a tip below the floor', () => {
    expect(isValidTip(0.0009, 'SOL')).toBe(false);
    expect(isValidTip(0.00009, 'ETH')).toBe(false);
    expect(isValidTip(0, 'SOL')).toBe(false);
  });

  it('rejects non-finite amounts', () => {
    expect(isValidTip(Number.NaN, 'SOL')).toBe(false);
    expect(isValidTip(Number.POSITIVE_INFINITY, 'SOL')).toBe(false);
  });
});

describe('isValidSupply', () => {
  it('accepts the four fixed supplies', () => {
    for (const [v] of SUPPLIES) expect(isValidSupply(v)).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isValidSupply(1234)).toBe(false);
    expect(isValidSupply(0)).toBe(false);
  });
});

describe('isValidSupply with a chain cap', () => {
  it('refuses a fixed supply above maxSupply', () => {
    const p = { ...DEFAULT_CURVE_PARAMS, maxSupply: 1e9 };
    expect(isValidSupply(1e9, p)).toBe(true);
    expect(isValidSupply(5e8, p)).toBe(true);
    expect(isValidSupply(1e12, p)).toBe(false);
    // Still only the four fixed values, even under the cap.
    expect(isValidSupply(2e8, p)).toBe(false);
  });
});

describe('isValidCurveFee with chain bounds', () => {
  it('reads the slider range off minFeeBps / maxFeeBps', () => {
    const p = { ...DEFAULT_CURVE_PARAMS, minFeeBps: 50, maxFeeBps: 300 };
    expect(isValidCurveFee(0.5, p)).toBe(true);
    expect(isValidCurveFee(3, p)).toBe(true);
    expect(isValidCurveFee(0.4, p)).toBe(false);
    expect(isValidCurveFee(3.1, p)).toBe(false);
    expect(isValidCurveFee(5, p)).toBe(false);
  });
});

describe('isValidCurveFee', () => {
  it('accepts the 1.0 to 5.0 slider range', () => {
    expect(isValidCurveFee(1)).toBe(true);
    expect(isValidCurveFee(2.5)).toBe(true);
    expect(isValidCurveFee(5)).toBe(true);
  });

  it('rejects outside the range', () => {
    expect(isValidCurveFee(0.9)).toBe(false);
    expect(isValidCurveFee(5.1)).toBe(false);
    expect(isValidCurveFee(Number.NaN)).toBe(false);
  });
});
