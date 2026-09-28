import { describe, expect, it } from 'vitest';
import { fmtCurve, fmtUnits } from './fmt.js';

describe('fmtUnits', () => {
  it('keeps up to four decimals and trims trailing zeros', () => {
    expect(fmtUnits(0.0042)).toBe('0.0042');
    expect(fmtUnits(0.01)).toBe('0.01');
    expect(fmtUnits(0.123456)).toBe('0.1235');
    expect(fmtUnits(0.25)).toBe('0.25');
    expect(fmtUnits(2)).toBe('2');
  });
});

describe('fmtCurve', () => {
  it('formats the same fill identically on every surface', () => {
    expect(fmtCurve(0)).toBe('0.0%');
    expect(fmtCurve(0.1)).toBe('0.1%');
    expect(fmtCurve(0.04)).toBe('0.0%');
    expect(fmtCurve(9.94)).toBe('9.9%');
    expect(fmtCurve(42.6)).toBe('43%');
    expect(fmtCurve(250)).toBe('100%');
    expect(fmtCurve(Number.NaN)).toBe('0.0%');
  });
});
