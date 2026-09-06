import { describe, expect, it } from 'vitest';
import { ago, esc, num, pct, px, usd } from '../src/fmt.js';

describe('usd', () => {
  it('formats millions with two decimals', () => {
    expect(usd(3020000)).toBe('$3.02M');
    expect(usd(1e6)).toBe('$1.00M');
  });

  it('formats thousands with one decimal', () => {
    expect(usd(69000)).toBe('$69.0K');
    expect(usd(1000)).toBe('$1.0K');
    expect(usd(999.9)).toBe('$1000');
  });

  it('formats sub-thousand as whole dollars', () => {
    expect(usd(482)).toBe('$482');
    expect(usd(0)).toBe('$0');
  });

  it('passes negatives straight through the whole-dollar branch', () => {
    expect(usd(-500)).toBe('$-500');
  });
});

describe('px', () => {
  it('uses eight decimals below 0.0001', () => {
    expect(px(0.000012345678)).toBe('$0.00001235');
    expect(px(0)).toBe('$0.00000000');
  });

  it('uses six decimals at or above 0.0001', () => {
    expect(px(0.0001)).toBe('$0.000100');
    expect(px(0.003021)).toBe('$0.003021');
  });
});

describe('pct', () => {
  it('signs positive values', () => {
    expect(pct(18.74)).toBe('+18.7%');
    expect(pct(0)).toBe('+0.0%');
  });

  it('leaves the minus sign on negatives', () => {
    expect(pct(-11.44)).toBe('-11.4%');
  });
});

describe('num', () => {
  it('rounds and groups', () => {
    expect(num(1840)).toBe('1,840');
    expect(num(128400.6)).toBe('128,401');
    expect(num(0)).toBe('0');
  });
});

describe('ago', () => {
  it('collapses under a minute', () => {
    expect(ago(0)).toBe('just now');
    expect(ago(0.9)).toBe('just now');
  });

  it('shows minutes under an hour', () => {
    expect(ago(1)).toBe('1m ago');
    expect(ago(59)).toBe('59m ago');
  });

  it('rounds hours rather than flooring them', () => {
    expect(ago(60)).toBe('1h ago');
    // 90 minutes rounds up to 2h — a quirk of toFixed(0), kept deliberately.
    expect(ago(90)).toBe('2h ago');
    expect(ago(1439)).toBe('24h ago');
  });

  it('rounds days the same way', () => {
    expect(ago(1440)).toBe('1d ago');
    expect(ago(4102)).toBe('3d ago');
  });
});

describe('esc', () => {
  it('escapes the three HTML-significant characters', () => {
    expect(esc('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(esc('a & b')).toBe('a &amp; b');
  });

  it('double-escapes an existing entity, matching the original', () => {
    expect(esc('&lt;')).toBe('&amp;lt;');
  });

  it('leaves quotes alone — templates never interpolate into attributes', () => {
    expect(esc(`"'`)).toBe(`"'`);
  });

  it('stringifies non-strings', () => {
    expect(esc(42)).toBe('42');
    expect(esc(null)).toBe('null');
    expect(esc(undefined)).toBe('undefined');
  });
});
