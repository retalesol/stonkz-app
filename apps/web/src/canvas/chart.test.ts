import { describe, expect, it } from 'vitest';
import { fmtAxisPrice, fmtBucketTime, fmtSig } from './chart.js';

describe('chart axis formatting', () => {
  it('spells small native prices out without exponent notation', () => {
    expect(fmtSig(1.6128e-6)).toBe('0.000001613');
    expect(fmtSig(0.0196)).toBe('0.0196');
    expect(fmtSig(25.21)).toBe('25.21');
    expect(fmtSig(1234.5)).toBe('1235');
    expect(fmtSig(0)).toBe('0');
  });

  it('keeps the USD axis on the header price format and converts for native', () => {
    const usdAxis = { unit: 'USD', rate: 1 };
    expect(fmtAxisPrice(0.004413656488, usdAxis)).toBe('$0.004414');
    const ethAxis = { unit: 'ETH', rate: 1 / 2736.6 };
    expect(fmtAxisPrice(0.004413656488, ethAxis)).toBe('0.000001613 ETH');
  });

  it('labels buckets as finely as the timeframe needs', () => {
    const t = Date.UTC(2026, 8, 29, 12, 34, 0);
    expect(fmtBucketTime(t, 60_000)).toMatch(/^\d\d:\d\d$/);
    expect(fmtBucketTime(t, 3_600_000)).toMatch(/^\d\d-\d\d \d\d:\d\d$/);
    expect(fmtBucketTime(t, 86_400_000)).toMatch(/^\d\d-\d\d$/);
  });
});
