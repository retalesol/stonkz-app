import { SUPPLIES, num, rng } from '@stonkz/shared';

/**
 * View-layer formatting. The numeric formatters (`usd`, `px`, `pct`, `num`,
 * `ago`, `esc`) live in `@stonkz/shared` and are imported directly wherever
 * they are needed; this file only holds the helpers that are presentational or
 * DOM-adjacent enough to stay out of the pure package.
 */

/** Punctuation the terminal uses verbatim. `index.html:1083` */
export const DOT = '\u00B7';
export const MID = '\u2014';
export const ARR = '\u2039';

/** CSS class for a signed number. `index.html:1095` */
export function ud(v: number): 'up' | 'dn' {
  return v >= 0 ? 'up' : 'dn';
}

/** Local HH:MM, used for chat lines and the drop log. `index.html:1096` */
export function clock(d: Date = new Date()): string {
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/** Local HH:MM:SS, used by the trade and activity tables. */
export function clockSec(d: Date): string {
  return (
    String(d.getHours()).padStart(2, '0') +
    ':' +
    String(d.getMinutes()).padStart(2, '0') +
    ':' +
    String(d.getSeconds()).padStart(2, '0')
  );
}

const ADDR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ123456789';

/**
 * A deterministic shortened address, `XXXX..YYYY`. Simulation only — Phase 1
 * replaces every call site with a real wallet address. `index.html:1098`
 */
export function fakeAddr(seed: number): string {
  const r = rng(seed);
  let out = '';
  for (let i = 0; i < 4; i++) out += ADDR_ALPHABET[(r() * ADDR_ALPHABET.length) | 0];
  out += '..';
  for (let i = 0; i < 4; i++) out += ADDR_ALPHABET[(r() * ADDR_ALPHABET.length) | 0];
  return out;
}

/**
 * Shorten a real wallet address to the same `XXXX..YYYY` shape `fakeAddr`
 * renders, so live trader/holder addresses fit the same fixed-width columns.
 * `plan step 62`
 */
export function shortAddr(addr: string): string {
  if (addr.length <= 10) return addr;
  return addr.slice(0, 4) + '..' + addr.slice(-4);
}

/** `1e9` -> `1B`, falling back to a grouped integer. `index.html:3740` */
export function fmtSupply(v: number): string {
  for (const [value, label] of SUPPLIES) if (value === v) return label;
  return num(v);
}

/** Crate cooldown countdown: `2d 3h` / `4h 12m` / `9m 04s` / `7s`. `index.html:2214` */
export function cdText(ms: number): string {
  if (ms <= 0) return 'READY';
  const s = Math.ceil(ms / 1000);
  const d = (s / 86400) | 0;
  const h = ((s % 86400) / 3600) | 0;
  const m = ((s % 3600) / 60) | 0;
  const ss = s % 60;
  return d
    ? d + 'd ' + h + 'h'
    : h
      ? h + 'h ' + m + 'm'
      : m
        ? m + 'm ' + String(ss).padStart(2, '0') + 's'
        : ss + 's';
}

/**
 * Bonding-curve fill, one format everywhere (board card, KOTH, token page):
 * one decimal under 10% so an early 0.1% never reads as "0%" on one surface
 * and "0.1%" on another, whole numbers above, capped at 100.
 */
export function fmtCurve(cv: number): string {
  const v = Number.isFinite(cv) ? Math.min(100, Math.max(0, cv)) : 0;
  return (v < 10 ? v.toFixed(1) : v.toFixed(0)) + '%';
}

/** RWA units (fractional shares / ounces): up to four decimals, trailing zeros trimmed. */
export function fmtUnits(units: number): string {
  return String(Math.round(units * 10_000) / 10_000);
}
