import { feePie } from '@stonkz/shared';
import { fitCanvas } from './pix.js';

/**
 * Slice colours, shared with the legend in the stake modal so the two cannot
 * drift apart.
 */
export const PIE_COLOURS = {
  /** Stonkz protocol revenue vault. */
  protocol: '#4d9bff',
  /** Stonkz Game buyback vault (`$STONKZ` for the daily pot). */
  stonkzOps: '#26d0c4',
  /** Buyback-and-burn vault. */
  burn: '#ff4c3b',
  /** The creator's remainder of their 60% bucket. */
  creator: '#a273ff',
  /** This memecoin's stakers, out of the same 60% bucket. */
  stakers: '#ffa22b',
} as const;

/**
 * The stake modal donut.
 *
 * The oracle drew a two-slice pie against the old 1%-to-protocol model. It now
 * shows the real split of a curve fee: protocol 20, Stonkz Game buyback 10,
 * burn 10, and the 60 creator bucket divided between the creator and this
 * coin's stakers by `poolFrac`. Stakers top out at 30% of the fee, creator
 * floors at 30%.
 *
 * @see plan step 23, "Fee pie"
 */
export function drawPie(cv: HTMLCanvasElement | null, poolFraction: number): void {
  if (!cv) return;
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  if (w < 2) {
    setTimeout(() => drawPie(cv, poolFraction), 40);
    return;
  }
  const g = fitCanvas(cv);
  if (!g) return;
  g.clearRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(w, h) / 2 - 6;
  const r0 = R * 0.56;
  const pie = feePie(1, poolFraction);
  const parts: Array<[number, string]> = [
    [pie.stakers, PIE_COLOURS.stakers],
    [pie.creator, PIE_COLOURS.creator],
    [pie.protocol, PIE_COLOURS.protocol],
    [pie.stonkzOps, PIE_COLOURS.stonkzOps],
    [pie.burn, PIE_COLOURS.burn],
  ];
  let a0 = -Math.PI / 2;
  for (const [frac, col] of parts) {
    const a1 = a0 + frac * Math.PI * 2;
    g.beginPath();
    g.moveTo(cx, cy);
    g.arc(cx, cy, R, a0, a1);
    g.closePath();
    g.fillStyle = col;
    g.fill();
    a0 = a1;
  }
  g.globalCompositeOperation = 'destination-out';
  g.beginPath();
  g.arc(cx, cy, r0, 0, Math.PI * 2);
  g.fill();
  g.globalCompositeOperation = 'source-over';

  g.fillStyle = PIE_COLOURS.stakers;
  g.font = '700 18px "IBM Plex Sans Condensed", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText((pie.stakers * 100).toFixed(1) + '%', cx, cy - 5);
  g.fillStyle = '#6b675c';
  g.font = '9px "IBM Plex Sans Condensed", sans-serif';
  g.fillText('TO STAKERS', cx, cy + 11);
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
}
