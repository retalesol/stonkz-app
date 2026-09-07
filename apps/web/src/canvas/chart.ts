import { SUPPLY, curveMc, px, usd, vol24 } from '@stonkz/shared';
import { fmtSupply } from '../lib/fmt.js';
import { type Html, html } from '../lib/html.js';
import { fitCanvas } from './pix.js';

export interface TokenChartInput {
  /** Market-cap series, oldest first. */
  series: number[];
  /** Volume series, index-aligned with `series`. */
  volume: number[];
  /** Candle count to show: 45 / 90 / 140 / 200. */
  range: number;
  /** Crosshair x in CSS pixels, or null. */
  cross: number | null;
  /** Only read for the static HUD line. */
  coin: { mc: number; seed: number; supply?: number | undefined };
}

/**
 * The token page chart: market-cap line with a gradient fill, volume bars,
 * hi/lo callouts, a last-price tag and an optional crosshair. Returns the HUD
 * markup so the caller owns the DOM write. `index.html:1747`
 */
export function drawTokenChart(cvs: HTMLCanvasElement | null, input: TokenChartInput): Html | null {
  if (!cvs) return null;
  const w = cvs.clientWidth;
  const h = cvs.clientHeight;
  const g = fitCanvas(cvs);
  if (!g) return null;
  g.clearRect(0, 0, w, h);

  const d = input.series.slice(-input.range);
  const v = input.volume.slice(-input.range);
  const n = d.length;
  const pl = 6;
  const pr = 72;
  const pt = 16;
  const pb = 17;
  const volH = Math.max(24, h * 0.18);
  const plotH = h - pt - pb - volH - 6;
  let mn = Math.min(...d);
  let mx = Math.max(...d);
  let rg = mx - mn || mx * 0.1;
  mn -= rg * 0.1;
  mx += rg * 0.1;
  rg = mx - mn;
  const vmx = Math.max(...v) || 1;
  const X = (i: number): number => pl + (i * (w - pl - pr)) / (n - 1);
  const Y = (p: number): number => pt + ((mx - p) / rg) * plotH;
  const base = h - pb;

  g.font = '9px "IBM Plex Mono", monospace';
  g.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const yy = pt + (i * plotH) / 4;
    g.strokeStyle = '#141a24';
    g.beginPath();
    g.moveTo(pl, yy + 0.5);
    g.lineTo(w - pr, yy + 0.5);
    g.stroke();
    g.fillStyle = '#6b675c';
    g.textAlign = 'left';
    g.fillText(usd(mx - (rg * i) / 4), w - pr + 7, yy);
  }

  const bw = Math.max(1, (w - pl - pr) / n - 1);
  for (let i = 0; i < n; i++) {
    const up = i === 0 || (d[i] as number) >= (d[i - 1] as number);
    g.fillStyle = up ? 'rgba(0,210,106,.4)' : 'rgba(255,76,59,.4)';
    const vh = ((v[i] as number) / vmx) * volH;
    g.fillRect(X(i) - bw / 2, base - vh, bw, vh);
  }
  g.strokeStyle = '#1e2431';
  g.beginPath();
  g.moveTo(pl, base + 0.5);
  g.lineTo(w - pr, base + 0.5);
  g.stroke();

  const gr = g.createLinearGradient(0, pt, 0, pt + plotH);
  gr.addColorStop(0, 'rgba(255,162,43,.3)');
  gr.addColorStop(1, 'rgba(255,162,43,0)');
  g.beginPath();
  g.moveTo(X(0), pt + plotH);
  for (let i = 0; i < n; i++) g.lineTo(X(i), Y(d[i] as number));
  g.lineTo(X(n - 1), pt + plotH);
  g.closePath();
  g.fillStyle = gr;
  g.fill();
  g.beginPath();
  for (let i = 0; i < n; i++) {
    if (i) g.lineTo(X(i), Y(d[i] as number));
    else g.moveTo(X(i), Y(d[i] as number));
  }
  g.strokeStyle = '#ffa22b';
  g.lineWidth = 1.5;
  g.stroke();

  let hi = 0;
  let lo = 0;
  for (let i = 0; i < n; i++) {
    if ((d[i] as number) > (d[hi] as number)) hi = i;
    if ((d[i] as number) < (d[lo] as number)) lo = i;
  }
  g.fillStyle = '#cac6ba';
  g.textAlign = hi > n * 0.75 ? 'right' : 'left';
  g.fillText('HI ' + usd(d[hi] as number), X(hi) + (hi > n * 0.75 ? -5 : 5), Y(d[hi] as number) - 8);
  g.textAlign = lo > n * 0.75 ? 'right' : 'left';
  g.fillText('LO ' + usd(d[lo] as number), X(lo) + (lo > n * 0.75 ? -5 : 5), Y(d[lo] as number) + 9);

  const ly = Y(d[n - 1] as number);
  g.fillStyle = '#ffa22b';
  g.fillRect(w - pr + 3, ly - 7, pr - 6, 14);
  g.fillStyle = '#150d00';
  g.textAlign = 'left';
  g.fillText(usd(d[n - 1] as number), w - pr + 7, ly + 0.5);
  g.strokeStyle = 'rgba(255,162,43,.4)';
  g.setLineDash([2, 3]);
  g.beginPath();
  g.moveTo(pl, ly + 0.5);
  g.lineTo(w - pr, ly + 0.5);
  g.stroke();
  g.setLineDash([]);
  g.fillStyle = '#6b675c';
  g.textAlign = 'left';
  g.fillText('T-' + n + 'M', pl + 2, h - 6);
  g.textAlign = 'right';
  g.fillText('NOW', w - pr - 3, h - 6);

  let hud = html`<span><b>HI</b> ${usd(d[hi] as number)}</span><span><b>LO</b> ${usd(d[lo] as number)}</span
    ><span><b>VOL</b> ${usd(vol24(input.coin))}</span
    ><span><b>SUPPLY</b> ${fmtSupply(input.coin.supply || SUPPLY)}</span>`;

  if (input.cross !== null) {
    const idx = Math.max(0, Math.min(n - 1, Math.round((input.cross - pl) / ((w - pl - pr) / (n - 1)))));
    const cx = X(idx);
    const cy = Y(d[idx] as number);
    g.strokeStyle = 'rgba(202,198,186,.45)';
    g.setLineDash([1, 3]);
    g.beginPath();
    g.moveTo(cx + 0.5, pt);
    g.lineTo(cx + 0.5, base);
    g.stroke();
    g.beginPath();
    g.moveTo(pl, cy + 0.5);
    g.lineTo(w - pr, cy + 0.5);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = '#ffd23f';
    g.fillRect(cx - 2, cy - 2, 4, 4);
    hud = html`<span><b>T-</b>${n - 1 - idx}m</span><span><b>MCAP</b> ${usd(d[idx] as number)}</span
      ><span><b>PRICE</b> ${px((d[idx] as number) / SUPPLY)}</span><span><b>VOL</b> ${usd(v[idx] as number)}</span>`;
  }
  return hud;
}

export interface LaunchChartInput {
  /** Dev buy, in the base mint. */
  buy: number;
  /** Fixed supply the stepper picked. */
  supply: number;
  /** Base symbol, for the axis labels. */
  base: string;
}

/**
 * The launch stepper's bonding-curve preview. Axis is the base mint, matching
 * the program; the trade box remains native-denominated. `index.html:3897`
 */
export function drawLaunchChart(cv: HTMLCanvasElement | null, input: LaunchChartInput): void {
  if (!cv) return;
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  if (w < 2 || h < 2) {
    setTimeout(() => drawLaunchChart(cv, input), 40);
    return;
  }
  const g = fitCanvas(cv);
  if (!g) return;
  const { buy, supply: sup, base } = input;
  g.fillStyle = '#040507';
  g.fillRect(0, 0, w, h);
  const pl = 8;
  const pr = 68;
  const pt = 16;
  const pb = 18;
  const maxSol = Math.max(6, buy * 1.7);
  const maxMc = curveMc(maxSol);
  const minMc = curveMc(0);
  const X = (v: number): number => pl + (v / maxSol) * (w - pl - pr);
  const Y = (mc: number): number => pt + (1 - (mc - minMc) / Math.max(1, maxMc - minMc)) * (h - pt - pb);

  g.font = '9px "IBM Plex Mono", monospace';
  g.textBaseline = 'middle';
  for (let i = 0; i <= 3; i++) {
    const yy = pt + (i * (h - pt - pb)) / 3;
    const mcv = maxMc - ((maxMc - minMc) * i) / 3;
    g.strokeStyle = '#141a24';
    g.beginPath();
    g.moveTo(pl, yy + 0.5);
    g.lineTo(w - pr, yy + 0.5);
    g.stroke();
    g.fillStyle = '#6b675c';
    g.textAlign = 'left';
    g.fillText(px(mcv / sup), w - pr + 6, yy);
  }

  const pts: Array<[number, number]> = [];
  for (let i = 0; i <= 64; i++) {
    const sx = (maxSol * i) / 64;
    pts.push([X(sx), Y(curveMc(sx))]);
  }
  g.beginPath();
  g.moveTo((pts[0] as [number, number])[0], h - pb);
  pts.forEach((p) => g.lineTo(p[0], p[1]));
  g.lineTo((pts[pts.length - 1] as [number, number])[0], h - pb);
  g.closePath();
  const gr = g.createLinearGradient(0, pt, 0, h - pb);
  gr.addColorStop(0, 'rgba(255,162,43,.16)');
  gr.addColorStop(1, 'rgba(255,162,43,0)');
  g.fillStyle = gr;
  g.fill();
  g.beginPath();
  pts.forEach((p, k) => (k ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])));
  g.strokeStyle = '#c87c14';
  g.lineWidth = 1.4;
  g.stroke();

  if (buy > 0) {
    const bx = X(Math.min(buy, maxSol));
    const by = Y(curveMc(buy));
    g.beginPath();
    g.moveTo(X(0), h - pb);
    for (let i = 0; i <= 40; i++) {
      const sx = (buy * i) / 40;
      g.lineTo(X(sx), Y(curveMc(sx)));
    }
    g.lineTo(bx, h - pb);
    g.closePath();
    g.fillStyle = 'rgba(0,210,106,.22)';
    g.fill();
    g.beginPath();
    for (let i = 0; i <= 40; i++) {
      const sx = (buy * i) / 40;
      if (i) g.lineTo(X(sx), Y(curveMc(sx)));
      else g.moveTo(X(sx), Y(curveMc(sx)));
    }
    g.strokeStyle = '#00d26a';
    g.lineWidth = 2;
    g.stroke();
    g.strokeStyle = 'rgba(0,210,106,.5)';
    g.setLineDash([2, 3]);
    g.beginPath();
    g.moveTo(bx + 0.5, by);
    g.lineTo(bx + 0.5, h - pb);
    g.stroke();
    g.beginPath();
    g.moveTo(pl, by + 0.5);
    g.lineTo(bx, by + 0.5);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = '#00d26a';
    g.fillRect(bx - 3, by - 3, 6, 6);
    g.fillStyle = '#2bff8f';
    g.font = '700 10px "IBM Plex Sans Condensed", sans-serif';
    g.textAlign = bx > w * 0.6 ? 'right' : 'left';
    g.fillText('YOUR ENTRY ' + buy.toFixed(2) + ' ' + base, bx + (bx > w * 0.6 ? -7 : 7), by - 11);
    g.fillStyle = '#ffd23f';
    g.textAlign = 'left';
    g.fillText(px(curveMc(buy) / sup), pl + 3, Math.max(pt + 6, by - 2));
  }

  g.fillStyle = '#6b675c';
  g.font = '9px "IBM Plex Mono", monospace';
  g.textAlign = 'left';
  g.fillText('0 ' + base, pl + 1, h - 7);
  g.textAlign = 'right';
  g.fillText(maxSol.toFixed(1) + ' ' + base + ' RAISED', w - pr - 2, h - 7);
  g.textAlign = 'left';
}
