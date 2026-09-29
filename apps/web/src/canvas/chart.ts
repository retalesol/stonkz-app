import { curveMc, px, usd } from '@stonkz/shared';
import { type Candle } from '../lib/candles.js';
import { type Html, html } from '../lib/html.js';
import { fitCanvas } from './pix.js';

export interface ChartAxis {
  /** Axis unit label: `USD`, or the coin's gas unit (`ETH`, `SOL`, `USDC`). */
  unit: string;
  /** Multiplier from USD per token to the axis unit (1 for USD, 1 / native USD mark otherwise). */
  rate: number;
}

export interface TokenChartInput {
  /** Ascending, gap-filled candles in USD per token (`lib/candles.ts`). */
  candles: readonly Candle[];
  /** Candle count to show; `Infinity` for all. */
  range: number;
  /** Crosshair x in CSS pixels, or null. */
  cross: number | null;
  bucketMs: number;
  axis: ChartAxis;
  /** Fixed supply, for the MCAP readout. */
  supply: number;
  /** Real 24h USD volume when the API reported it; `null` hides the readout. */
  vol24Usd: number | null;
}

const UP = '#00d26a';
const DOWN = '#ff4c3b';
const DIM = '#6b675c';
const GRID = '#141a24';
const FONT = '9px "IBM Plex Mono", monospace';

/** Four significant digits without exponent notation, trailing zeros trimmed. */
export function fmtSig(v: number, sig = 4): string {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  const mag = Math.floor(Math.log10(Math.abs(v)));
  const decimals = Math.max(0, sig - 1 - mag);
  return v.toFixed(Math.min(decimals, 12)).replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
}

/** A price in the axis unit: `$0.004414` on USD, `1.638e-6`-style figures spelled out on native. */
export function fmtAxisPrice(usdPrice: number, axis: ChartAxis): string {
  if (axis.unit === 'USD') return px(usdPrice);
  return fmtSig(usdPrice * axis.rate) + ' ' + axis.unit;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Candle time label, as fine as the bucket needs. */
export function fmtBucketTime(t: number, bucketMs: number): string {
  const d = new Date(t);
  const hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  const md = pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  if (bucketMs >= 86_400_000) return md;
  if (bucketMs >= 3_600_000) return md + ' ' + hm;
  return hm;
}

/** Paints a centred one-line message (loading / empty states). */
export function drawChartMessage(cvs: HTMLCanvasElement | null, text: string): void {
  if (!cvs) return;
  const g = fitCanvas(cvs);
  if (!g) return;
  const w = cvs.clientWidth;
  const h = cvs.clientHeight;
  g.fillStyle = '#040507';
  g.fillRect(0, 0, w, h);
  g.fillStyle = DIM;
  g.font = '11px "IBM Plex Mono", monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, w / 2, h / 2);
}

/**
 * The token page chart: OHLC candles with volume, a last-price tag, hi/lo
 * callouts and an optional crosshair with a per-candle readout. Returns the
 * HUD markup so the caller owns the DOM write. `index.html:1747`
 */
export function drawTokenChart(cvs: HTMLCanvasElement | null, input: TokenChartInput): Html | null {
  if (!cvs) return null;
  const w = cvs.clientWidth;
  const h = cvs.clientHeight;
  const g = fitCanvas(cvs);
  if (!g) return null;
  g.clearRect(0, 0, w, h);
  g.fillStyle = '#040507';
  g.fillRect(0, 0, w, h);

  const all = input.candles;
  const count = Number.isFinite(input.range) ? Math.max(1, Math.floor(input.range)) : all.length;
  const d = all.slice(-count);
  const n = d.length;
  if (n < 1) {
    drawChartMessage(cvs, 'NO CANDLE HISTORY YET');
    return html`<span class="dm">WAITING FOR FIRST PRINT</span>`;
  }
  const axis = input.axis;
  const pl = 6;
  const pr = w < 420 ? 58 : 76;
  // A narrow canvas wraps the HUD onto two lines; keep the plot clear of it.
  const pt = w < 520 ? 30 : 18;
  const pb = 17;
  const volH = Math.max(22, h * 0.16);
  const plotH = h - pt - pb - volH - 6;
  const plotW = w - pl - pr;

  let lo = Infinity;
  let hi = -Infinity;
  let vmx = 0;
  for (const k of d) {
    if (k.l < lo) lo = k.l;
    if (k.h > hi) hi = k.h;
    if (k.v > vmx) vmx = k.v;
  }
  let rg = hi - lo;
  if (!(rg > 0)) rg = Math.abs(hi) * 0.1 || 1e-9;
  const mn = lo - rg * 0.08;
  const mx = hi + rg * 0.08;
  const span = mx - mn;
  const slot = plotW / n;
  const X = (i: number): number => pl + slot * (i + 0.5);
  const Y = (p: number): number => pt + ((mx - p) / span) * plotH;
  const base = h - pb;

  // Grid + price axis.
  g.font = FONT;
  g.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const yy = pt + (i * plotH) / 4;
    g.strokeStyle = GRID;
    g.beginPath();
    g.moveTo(pl, yy + 0.5);
    g.lineTo(w - pr, yy + 0.5);
    g.stroke();
    g.fillStyle = DIM;
    g.textAlign = 'left';
    g.fillText(fmtAxisPrice(mx - (span * i) / 4, axis), w - pr + 7, yy);
  }

  // Time axis: a label roughly every 90px, on candle boundaries.
  const every = Math.max(1, Math.ceil(90 / slot));
  g.fillStyle = DIM;
  g.textAlign = 'center';
  for (let i = n - 1; i >= 0; i -= every) {
    const k = d[i] as Candle;
    const x = X(i);
    if (x < pl + 24 || x > w - pr - 24) continue;
    g.strokeStyle = GRID;
    g.beginPath();
    g.moveTo(Math.round(x) + 0.5, pt);
    g.lineTo(Math.round(x) + 0.5, base);
    g.stroke();
    g.fillText(fmtBucketTime(k.t, input.bucketMs), x, h - 6);
  }

  // Volume.
  const bw = Math.max(1, slot * 0.66);
  for (let i = 0; i < n; i++) {
    const k = d[i] as Candle;
    if (!(k.v > 0) || !(vmx > 0)) continue;
    const up = k.c >= k.o;
    g.fillStyle = up ? 'rgba(0,210,106,.38)' : 'rgba(255,76,59,.38)';
    const vh = Math.max(1, (k.v / vmx) * volH);
    g.fillRect(X(i) - bw / 2, base - vh, bw, vh);
  }
  g.strokeStyle = '#1e2431';
  g.beginPath();
  g.moveTo(pl, base + 0.5);
  g.lineTo(w - pr, base + 0.5);
  g.stroke();

  // Candles. Gap candles (no fills) are a thin dim tick at the carried close,
  // pending ones are translucent until the indexer confirms them.
  let hiI = 0;
  let loI = 0;
  for (let i = 0; i < n; i++) {
    const k = d[i] as Candle;
    if (k.h > (d[hiI] as Candle).h) hiI = i;
    if (k.l < (d[loI] as Candle).l) loI = i;
    const x = X(i);
    if (k.n === 0) {
      g.strokeStyle = '#2b3342';
      g.beginPath();
      g.moveTo(x - bw / 2, Math.round(Y(k.c)) + 0.5);
      g.lineTo(x + bw / 2, Math.round(Y(k.c)) + 0.5);
      g.stroke();
      continue;
    }
    const up = k.c >= k.o;
    const col = up ? UP : DOWN;
    g.globalAlpha = k.pending ? 0.45 : 1;
    g.strokeStyle = col;
    g.fillStyle = col;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(Math.round(x) + 0.5, Y(k.h));
    g.lineTo(Math.round(x) + 0.5, Y(k.l));
    g.stroke();
    const yo = Y(k.o);
    const yc = Y(k.c);
    const top = Math.min(yo, yc);
    const bh = Math.max(1, Math.abs(yo - yc));
    if (bw >= 3) g.fillRect(Math.round(x - bw / 2), top, Math.round(bw), bh);
    else g.fillRect(x - 0.5, top, 1, bh);
    if (k.pending) {
      g.setLineDash([2, 2]);
      g.strokeRect(Math.round(x - bw / 2) + 0.5, top + 0.5, Math.max(1, Math.round(bw) - 1), bh);
      g.setLineDash([]);
    }
    g.globalAlpha = 1;
  }

  // Hi / lo callouts.
  const hiK = d[hiI] as Candle;
  const loK = d[loI] as Candle;
  g.fillStyle = '#cac6ba';
  g.textAlign = hiI > n * 0.75 ? 'right' : 'left';
  g.fillText('HI ' + fmtAxisPrice(hiK.h, axis), X(hiI) + (hiI > n * 0.75 ? -5 : 5), Y(hiK.h) - 8);
  g.textAlign = loI > n * 0.75 ? 'right' : 'left';
  g.fillText('LO ' + fmtAxisPrice(loK.l, axis), X(loI) + (loI > n * 0.75 ? -5 : 5), Y(loK.l) + 9);

  // Last price tag.
  const lastK = d[n - 1] as Candle;
  const ly = Y(lastK.c);
  const lastUp = lastK.c >= lastK.o;
  g.fillStyle = lastK.pending ? '#7a5a1c' : lastUp ? '#0f7a3d' : '#8c2418';
  g.fillRect(w - pr + 3, ly - 7, pr - 6, 14);
  g.fillStyle = '#ffffff';
  g.textAlign = 'left';
  g.fillText(fmtAxisPrice(lastK.c, axis), w - pr + 7, ly + 0.5);
  g.strokeStyle = 'rgba(255,162,43,.4)';
  g.setLineDash([2, 3]);
  g.beginPath();
  g.moveTo(pl, ly + 0.5);
  g.lineTo(w - pr, ly + 0.5);
  g.stroke();
  g.setLineDash([]);

  const mcap = (k: Candle): string => usd(k.c * input.supply);
  const vis = d.reduce((s, k) => s + k.v, 0);
  let hud = html`<span><b>O</b> ${fmtAxisPrice(lastK.o, axis)}</span
    ><span><b>H</b> ${fmtAxisPrice(lastK.h, axis)}</span
    ><span><b>L</b> ${fmtAxisPrice(lastK.l, axis)}</span
    ><span class="${lastUp ? 'up' : 'dn'}"><b>C</b> ${fmtAxisPrice(lastK.c, axis)}</span
    ><span><b>MCAP</b> ${mcap(lastK)}</span
    ><span><b>VOL</b> ${usd(vis)}</span
    >${input.vol24Usd !== null ? html`<span><b>24H</b> ${usd(input.vol24Usd)}</span>` : ''}`;

  if (input.cross !== null) {
    const idx = Math.max(0, Math.min(n - 1, Math.floor((input.cross - pl) / slot)));
    const k = d[idx] as Candle;
    const cx = Math.round(X(idx)) + 0.5;
    const cy = Y(k.c);
    g.strokeStyle = 'rgba(202,198,186,.45)';
    g.setLineDash([1, 3]);
    g.beginPath();
    g.moveTo(cx, pt);
    g.lineTo(cx, base);
    g.stroke();
    g.beginPath();
    g.moveTo(pl, Math.round(cy) + 0.5);
    g.lineTo(w - pr, Math.round(cy) + 0.5);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = '#ffd23f';
    g.fillRect(cx - 2.5, cy - 2, 4, 4);
    // Time tag on the x axis.
    const label = fmtBucketTime(k.t, input.bucketMs);
    g.font = FONT;
    const tw = g.measureText(label).width + 8;
    const tx = Math.max(pl, Math.min(w - pr - tw, cx - tw / 2));
    g.fillStyle = '#2b3342';
    g.fillRect(tx, h - 13, tw, 12);
    g.fillStyle = '#e8e4d8';
    g.textAlign = 'center';
    g.fillText(label, tx + tw / 2, h - 7);
    const up = k.c >= k.o;
    hud = html`<span><b>${label}</b>${k.pending ? html` <i class="am">PENDING</i>` : ''}</span
      ><span><b>O</b> ${fmtAxisPrice(k.o, axis)}</span
      ><span><b>H</b> ${fmtAxisPrice(k.h, axis)}</span
      ><span><b>L</b> ${fmtAxisPrice(k.l, axis)}</span
      ><span class="${up ? 'up' : 'dn'}"><b>C</b> ${fmtAxisPrice(k.c, axis)}</span
      ><span><b>MCAP</b> ${mcap(k)}</span
      ><span
        ><b>VOL</b>
        ${usd(k.v)}${k.n ? html` <i class="dm">${k.n} FILL${k.n === 1 ? '' : 'S'}</i>` : ''}</span
      >`;
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
export function drawLaunchChart(
  cv: HTMLCanvasElement | null,
  input: LaunchChartInput,
  attempt = 0,
): void {
  if (!cv) return;
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  if (w < 2 || h < 2) {
    // Not laid out yet (the scrim paints a frame later). Retry briefly, but
    // never forever: a canvas the stepper already replaced, or a dialog that
    // was closed, would otherwise poll every 40ms for the rest of the session.
    if (cv.isConnected && attempt < 50) {
      setTimeout(() => drawLaunchChart(cv, input, attempt + 1), 40);
    }
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
  const Y = (mc: number): number =>
    pt + (1 - (mc - minMc) / Math.max(1, maxMc - minMc)) * (h - pt - pb);

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
