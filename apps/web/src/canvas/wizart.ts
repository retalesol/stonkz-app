import { MEMEMAN_FULL_SRC } from '../lib/avatar.js';
import { paintFace } from './face.js';
import { fitCanvas, miniAv } from './pix.js';

/**
 * Drawn stand-ins for the how-it-works wizard.
 *
 * Real art paths in `WIZART` render as <img>; otherwise canvas drawings run.
 */
export const WIZART: Record<string, string> = {
  pick: '',
  buy: '',
  grad: '',
  finish: MEMEMAN_FULL_SRC,
};

/** The little arrow cursor drawn into the board panel. `index.html:2826` */
function cursor(g: CanvasRenderingContext2D, x: number, y: number): void {
  g.fillStyle = '#0b0a08';
  g.beginPath();
  g.moveTo(x, y);
  g.lineTo(x, y + 19);
  g.lineTo(x + 5, y + 14);
  g.lineTo(x + 9, y + 21);
  g.lineTo(x + 12, y + 19);
  g.lineTo(x + 8, y + 13);
  g.lineTo(x + 14, y + 12);
  g.closePath();
  g.fill();
  g.fillStyle = '#fff';
  g.beginPath();
  g.moveTo(x + 1.5, y + 2);
  g.lineTo(x + 1.5, y + 16);
  g.lineTo(x + 5, y + 12);
  g.lineTo(x + 8.5, y + 18);
  g.lineTo(x + 10, y + 17);
  g.lineTo(x + 6.5, y + 11);
  g.lineTo(x + 11, y + 10.5);
  g.closePath();
  g.fill();
}

type ArtFn = (g: CanvasRenderingContext2D, w: number, h: number) => void;

const pick: ArtFn = (g, w, h) => {
  g.fillStyle = '#05070b';
  g.fillRect(0, 0, w, h);
  const lanes: Array<[string, string]> = [
    ['NEW MINTS', '#ffd23f'],
    ['ABOUT TO GRADUATE', '#ffa22b'],
    ['GRADUATED', '#00d26a'],
  ];
  const names = [
    ['PONZI', 'VIBEZ', 'FLOORD', 'GRIFT'],
    ['SER', 'JEETZ', 'BONKD', 'FLOOR'],
    ['WOJAK', 'TRENCH', 'MOONR', 'CULT'],
  ];
  const caps = [
    ['$5.8K', '$2.6K', '$5.6K', '$1.4K'],
    ['$68.9K', '$40.5K', '$55.8K', '$46.2K'],
    ['$499K', '$1.31M', '$132K', '$230K'],
  ];
  const colW = (w - 26) / 3;
  for (let i = 0; i < 3; i++) {
    const x = 9 + i * (colW + 4);
    g.fillStyle = '#08090c';
    g.fillRect(x, 10, colW, h - 20);
    g.strokeStyle = '#1e2431';
    g.lineWidth = 1;
    g.strokeRect(x + 0.5, 10.5, colW - 1, h - 21);
    g.fillStyle = '#121826';
    g.fillRect(x, 10, colW, 15);
    g.fillStyle = (lanes[i] as [string, string])[1];
    g.fillRect(x + 6, 15, 5, 5);
    g.font = '700 9px "IBM Plex Sans Condensed", sans-serif';
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.fillText((lanes[i] as [string, string])[0], x + 15, 18);
    for (let j = 0; j < 4; j++) {
      const cy = 32 + j * 47;
      miniAv(g, x + 7, cy, 28, (i * 11 + j) * 613 + 7);
      g.fillStyle = '#ffd23f';
      g.font = '700 11px "IBM Plex Sans Condensed", sans-serif';
      g.fillText((names[i] as string[])[j] as string, x + 42, cy + 8);
      g.fillStyle = '#cac6ba';
      g.font = '10px "IBM Plex Mono", monospace';
      g.fillText((caps[i] as string[])[j] as string, x + 42, cy + 21);
      const up = (i + j) % 4 !== 1;
      g.fillStyle = up ? '#00d26a' : '#ff4c3b';
      g.textAlign = 'right';
      g.font = '10px "IBM Plex Mono", monospace';
      g.fillText((up ? '+' : '-') + (9 + j * 23 + i * 7) + '%', x + colW - 7, cy + 8);
      g.textAlign = 'left';
      g.fillStyle = '#151a24';
      g.fillRect(x + 7, cy + 33, colW - 14, 2);
      g.fillStyle = i === 2 ? '#00d26a' : '#ffa22b';
      g.fillRect(x + 7, cy + 33, (colW - 14) * (0.18 + j * 0.19 + i * 0.2), 2);
    }
  }
  g.strokeStyle = '#ffa22b';
  g.lineWidth = 2;
  g.strokeRect(10, 77, colW - 2, 44);
  cursor(g, 9 + colW * 0.55, 104);
};

const buy: ArtFn = (g, w, h) => {
  g.fillStyle = '#05070b';
  g.fillRect(0, 0, w, h);
  const cw = w * 0.6;
  g.fillStyle = '#08090c';
  g.fillRect(8, 10, cw - 16, h - 20);
  g.strokeStyle = '#1e2431';
  g.strokeRect(8.5, 10.5, cw - 17, h - 21);
  g.fillStyle = '#121826';
  g.fillRect(8, 10, cw - 16, 15);
  g.fillStyle = '#ffa22b';
  g.font = '700 9px "IBM Plex Sans Condensed", sans-serif';
  g.textBaseline = 'middle';
  g.fillText('PONZI/SOL', 14, 18);
  const n = 30;
  const x0 = 16;
  const x1 = cw - 26;
  const base = h - 34;
  const top = 38;
  for (let i = 0; i <= 3; i++) {
    const yy = top + (i * (base - top)) / 3;
    g.strokeStyle = '#131923';
    g.beginPath();
    g.moveTo(14, yy + 0.5);
    g.lineTo(cw - 16, yy + 0.5);
    g.stroke();
  }
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const p = Math.pow(t, 2.4);
    const y = base - p * (base - top) * 0.92 - 4;
    const prev = base - Math.pow(Math.max(0, (i - 1) / (n - 1)), 2.4) * (base - top) * 0.92 - 4;
    const up = y <= prev;
    const cx = x0 + t * (x1 - x0);
    const bw = ((x1 - x0) / n) * 0.62;
    const wick = 6 + Math.random() * 10;
    g.strokeStyle = up ? '#00d26a' : '#ff4c3b';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(cx, y - wick / 2);
    g.lineTo(cx, y + wick / 2);
    g.stroke();
    g.fillStyle = up ? '#00d26a' : '#ff4c3b';
    g.fillRect(cx - bw / 2, Math.min(y, prev), bw, Math.max(3, Math.abs(prev - y)));
  }
  g.fillStyle = '#ffd23f';
  g.beginPath();
  g.arc(cw - 52, 72, 15, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = 'rgba(255,210,63,.18)';
  g.beginPath();
  g.arc(cw - 52, 72, 23, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#00d26a';
  g.font = '700 12px "IBM Plex Sans Condensed", sans-serif';
  g.textAlign = 'left';
  g.fillText('TO THE MOON', 22, 52);
  const tx = cw + 2;
  const tw = w - cw - 10;
  g.fillStyle = '#08090c';
  g.fillRect(tx, 10, tw, h - 20);
  g.strokeStyle = '#2c3444';
  g.strokeRect(tx + 0.5, 10.5, tw - 1, h - 21);
  g.fillStyle = '#121826';
  g.fillRect(tx, 10, tw, 15);
  g.fillStyle = '#ffa22b';
  g.font = '700 9px "IBM Plex Sans Condensed", sans-serif';
  g.fillText('TRADE', tx + 7, 18);
  g.fillStyle = '#0d3319';
  g.fillRect(tx + 8, 32, tw / 2 - 12, 20);
  g.strokeStyle = '#00d26a';
  g.strokeRect(tx + 8.5, 32.5, tw / 2 - 13, 19);
  g.fillStyle = '#6cf0a5';
  g.font = '700 11px "IBM Plex Sans Condensed", sans-serif';
  g.textAlign = 'center';
  g.fillText('BUY', tx + 8 + (tw / 2 - 12) / 2, 43);
  g.fillStyle = '#12161f';
  g.fillRect(tx + tw / 2 + 2, 32, tw / 2 - 10, 20);
  g.strokeStyle = '#2c3444';
  g.strokeRect(tx + tw / 2 + 2.5, 32.5, tw / 2 - 11, 19);
  g.fillStyle = '#948e80';
  g.fillText('SELL', tx + tw / 2 + 2 + (tw / 2 - 10) / 2, 43);
  g.textAlign = 'left';
  g.fillStyle = '#c87c14';
  g.font = '8px "IBM Plex Sans Condensed", sans-serif';
  g.fillText('AMOUNT (SOL)', tx + 8, 64);
  g.fillStyle = '#df8f1e';
  g.fillRect(tx + 8, 70, tw - 16, 18);
  g.fillStyle = '#140c00';
  g.font = '700 12px "IBM Plex Mono", monospace';
  g.fillText('1.00', tx + 13, 80);
  const rows: Array<[string, string]> = [
    ['EST. RECEIVE', '2,140,880'],
    ['PRICE IMPACT', '0.8%'],
    ['SLIPPAGE', '2.5%'],
  ];
  for (let i = 0; i < rows.length; i++) {
    g.fillStyle = '#948e80';
    g.font = '9px "IBM Plex Mono", monospace';
    g.fillText((rows[i] as [string, string])[0], tx + 8, 104 + i * 15);
    g.textAlign = 'right';
    g.fillStyle = '#cac6ba';
    g.fillText((rows[i] as [string, string])[1], tx + tw - 8, 104 + i * 15);
    g.textAlign = 'left';
  }
  g.fillStyle = '#0f7a3d';
  g.fillRect(tx + 8, h - 52, tw - 16, 26);
  g.strokeStyle = '#3fe08a';
  g.lineWidth = 1;
  g.strokeRect(tx + 8.5, h - 51.5, tw - 17, 25);
  g.fillStyle = '#eafff2';
  g.font = '700 13px "IBM Plex Sans Condensed", sans-serif';
  g.textAlign = 'center';
  g.fillText('BUY PONZI', tx + tw / 2, h - 38);
  g.textAlign = 'left';
};

const grad: ArtFn = (g, w, h) => {
  g.fillStyle = '#070910';
  g.fillRect(0, 0, w, h);
  for (let i = 0; i < 70; i++) {
    g.fillStyle = i % 3 ? '#ffd23f' : '#00d26a';
    g.globalAlpha = 0.25 + Math.random() * 0.5;
    g.fillRect(Math.random() * w, Math.random() * h, 4, 7);
  }
  g.globalAlpha = 1;
  const bx = w * 0.42;
  const bw = w - bx - 14;
  g.fillStyle = '#05070b';
  g.fillRect(bx, 14, bw, h - 28);
  g.strokeStyle = '#2c3444';
  g.strokeRect(bx + 0.5, 14.5, bw - 1, h - 29);
  const n = 26;
  g.beginPath();
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const x = bx + 10 + t * (bw - 20);
    const y = h - 40 - Math.pow(t, 2.2) * (h - 90);
    if (i) g.lineTo(x, y);
    else g.moveTo(x, y);
  }
  g.strokeStyle = '#00d26a';
  g.lineWidth = 2;
  g.stroke();
  g.fillStyle = '#00d26a';
  for (let i = 0; i < n; i += 2) {
    const t2 = i / (n - 1);
    const x2 = bx + 10 + t2 * (bw - 20);
    const y2 = h - 40 - Math.pow(t2, 2.2) * (h - 90);
    g.fillRect(x2 - 2, y2 - 2, 5, 5);
  }
  g.fillStyle = '#2bff8f';
  g.font = '700 30px "IBM Plex Sans Condensed", sans-serif';
  g.textBaseline = 'middle';
  g.fillText('$69,000', bx + 14, 52);
  g.fillStyle = '#ffd23f';
  g.font = '700 12px "IBM Plex Sans Condensed", sans-serif';
  g.fillText('+1,420.69%', bx + 14, 74);
  g.fillStyle = '#c87c14';
  g.font = '9px "IBM Plex Sans Condensed", sans-serif';
  g.fillText('FROM DEGENS TO DEGREES', bx + 14, h - 24);
  paintFace(g, 26, 58, 116);
  const cx = 84;
  const cy = 62;
  g.fillStyle = '#0b0a08';
  g.beginPath();
  g.moveTo(cx, cy - 26);
  g.lineTo(cx + 52, cy - 8);
  g.lineTo(cx, cy + 10);
  g.lineTo(cx - 52, cy - 8);
  g.closePath();
  g.fill();
  g.fillRect(cx - 20, cy + 4, 40, 10);
  g.strokeStyle = '#ffd23f';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(cx + 40, cy - 11);
  g.lineTo(cx + 46, cy + 18);
  g.stroke();
  g.fillStyle = '#ffd23f';
  g.fillRect(cx + 42, cy + 16, 7, 12);
  g.fillStyle = '#ffa22b';
  g.font = '700 11px "IBM Plex Sans Condensed", sans-serif';
  g.textAlign = 'center';
  g.fillText('GRADUATED', 84, h - 24);
  g.textAlign = 'left';
};

const finish: ArtFn = (g, w, h) => {
  const gr = g.createLinearGradient(0, 0, w, h);
  gr.addColorStop(0, '#0b2f9c');
  gr.addColorStop(1, '#1b58e0');
  g.fillStyle = gr;
  g.fillRect(0, 0, w, h);
  g.strokeStyle = 'rgba(255,255,255,.16)';
  g.lineWidth = 1;
  for (let x = 0; x < w; x += Math.round(w / 6)) {
    g.beginPath();
    g.moveTo(x + 0.5, 0);
    g.lineTo(x + 0.5, h);
    g.stroke();
  }
  for (let y = 0; y < h; y += Math.round(h / 5)) {
    g.beginPath();
    g.moveTo(0, y + 0.5);
    g.lineTo(w, y + 0.5);
    g.stroke();
  }
  const nums = [
    '+12.4%',
    '560',
    '1.286',
    '0.168',
    '2.286',
    '0.156',
    '1.45',
    '0.0287',
    '+0.9%',
    'N/A',
    '0.1204',
    '+0.7%',
  ];
  g.font = '700 15px "IBM Plex Mono", monospace';
  g.textBaseline = 'middle';
  g.fillStyle = '#bcd4ff';
  for (let i = 0; i < nums.length; i++) {
    const cx = (i % 3) * (w / 3) + 14;
    const cy = ((i / 3) | 0) * (h / 4) + 22;
    if (cx > w * 0.28 || cy > h * 0.62) g.fillText(nums[i] as string, cx, cy);
  }
  paintFace(g, 16, h - 176, 168);
  g.fillStyle = '#0b0a08';
  g.fillRect(46, h - 58, 112, 58);
  g.fillStyle = '#12161f';
  g.fillRect(52, h - 52, 100, 52);
  g.strokeStyle = '#ff8c1a';
  g.lineWidth = 7;
  g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(w * 0.56, h - 24);
  g.lineTo(w - 40, 44);
  g.stroke();
  g.fillStyle = '#ff8c1a';
  g.beginPath();
  g.moveTo(w - 26, 30);
  g.lineTo(w - 58, 44);
  g.lineTo(w - 38, 66);
  g.closePath();
  g.fill();
  g.font = '700 34px "Silkscreen", monospace';
  g.textAlign = 'center';
  g.fillStyle = '#0b0a08';
  g.fillText('STONKZ', w * 0.68 + 3, h - 46);
  g.fillStyle = '#ffffff';
  g.fillText('STONKZ', w * 0.68, h - 49);
  g.textAlign = 'left';
};

const ART: Record<string, ArtFn> = { pick, buy, grad, finish };

/** Paint whichever stand-in the current wizard step asked for. `index.html:2806` */
export function paintWizArt(root: ParentNode = document): void {
  const cv = root.querySelector<HTMLCanvasElement>('canvas[data-art]');
  if (!cv) return;
  if (cv.clientWidth < 2 || cv.clientHeight < 2) {
    setTimeout(() => paintWizArt(root), 40);
    return;
  }
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  const g = fitCanvas(cv);
  if (!g) return;
  (ART[cv.dataset['art'] ?? ''] ?? (() => undefined))(g, w, h);
}
