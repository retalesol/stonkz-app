import { describe, expect, it } from 'vitest';
import { fmtUnits } from './fmt.js';

describe('fmtUnits', () => {
  it('keeps up to four decimals and trims trailing zeros', () => {
    expect(fmtUnits(0.0042)).toBe('0.0042');
    expect(fmtUnits(0.01)).toBe('0.01');
    expect(fmtUnits(0.123456)).toBe('0.1235');
    expect(fmtUnits(0.25)).toBe('0.25');
    expect(fmtUnits(2)).toBe('2');
  });
});
