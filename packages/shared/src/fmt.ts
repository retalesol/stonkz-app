/**
 * Terminal formatters. Every quirk of the originals is intentional — the
 * board, tape and token page are diffed against `index.html`.
 */

/** `$1.20M` / `$4.5K` / `$482`. `index.html:1090` */
export function usd(v: number): string {
  return v >= 1e6
    ? '$' + (v / 1e6).toFixed(2) + 'M'
    : v >= 1e3
      ? '$' + (v / 1e3).toFixed(1) + 'K'
      : '$' + v.toFixed(0);
}

/** Token price. Eight decimals under a hundredth of a cent, six above. `index.html:1091` */
export function px(v: number): string {
  return v < 0.0001 ? '$' + v.toFixed(8) : '$' + v.toFixed(6);
}

/** Signed percent, one decimal. `index.html:1092` */
export function pct(v: number): string {
  return (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
}

/** Grouped integer, en-US. `index.html:1093` */
export function num(v: number): string {
  return Math.round(v).toLocaleString('en-US');
}

/** Relative age from minutes. Hours and days round, they do not floor. `index.html:1094` */
export function ago(m: number): string {
  return m < 1
    ? 'just now'
    : m < 60
      ? m + 'm ago'
      : m < 1440
        ? (m / 60).toFixed(0) + 'h ago'
        : (m / 1440).toFixed(0) + 'd ago';
}

/**
 * Escape user strings before they reach an `innerHTML` template.
 * Only `<`, `>` and `&` — quotes are never interpolated into attributes.
 * `index.html:1097`
 */
export function esc(t: unknown): string {
  return String(t).replace(/[<>&]/g, (m) => (m === '<' ? '&lt;' : m === '>' ? '&gt;' : '&amp;'));
}
