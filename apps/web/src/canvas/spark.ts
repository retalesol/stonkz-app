import { fitCanvas } from './pix.js';

/**
 * The King of the Hill sparkline. Fixed backing store (300x88 in the markup),
 * so it draws in device pixels directly. `index.html:1545`
 */
export function spark(cv: HTMLCanvasElement | null, d: number[]): void {
  if (!cv) return;
  const g = cv.getContext('2d');
  if (!g) return;
  const w = cv.width;
  const h = cv.height;
  const mn = Math.min(...d);
  const mx = Math.max(...d);
  const r = mx - mn || 1;
  const X = (i: number): number => (i * (w - 2)) / (d.length - 1) + 1;
  const Y = (v: number): number => h - 4 - ((v - mn) / r) * (h - 10);
  g.clearRect(0, 0, w, h);
  const gr = g.createLinearGradient(0, 0, 0, h);
  gr.addColorStop(0, 'rgba(255,162,43,.35)');
  gr.addColorStop(1, 'rgba(255,162,43,0)');
  g.beginPath();
  g.moveTo(X(0), h);
  d.forEach((v, i) => g.lineTo(X(i), Y(v)));
  g.lineTo(X(d.length - 1), h);
  g.closePath();
  g.fillStyle = gr;
  g.fill();
  g.beginPath();
  d.forEach((v, i) => (i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v))));
  g.strokeStyle = '#ffa22b';
  g.lineWidth = 2;
  g.stroke();
  g.fillStyle = '#ffd23f';
  g.fillRect(X(d.length - 1) - 3, Y(d[d.length - 1] as number) - 3, 6, 6);
}

/**
 * The 62px chart inside the tape hover card. DPR-aware because it is sized by
 * CSS, unlike `spark`. `index.html:1326`
 */
export function miniChart(cv: HTMLCanvasElement | null, d: number[], up: boolean): void {
  if (!cv) return;
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  const g = fitCanvas(cv);
  if (!g) return;
  g.clearRect(0, 0, w, h);
  let mn = Math.min(...d);
  let mx = Math.max(...d);
  let rg = mx - mn || mx * 0.08 || 1;
  mn -= rg * 0.12;
  mx += rg * 0.12;
  rg = mx - mn;
  const X = (i: number): number => 3 + (i * (w - 6)) / Math.max(1, d.length - 1);
  const Y = (v: number): number => 4 + ((mx - v) / rg) * (h - 8);
  for (let i = 1; i < 3; i++) {
    const yy = 4 + (i * (h - 8)) / 3;
    g.strokeStyle = '#131923';
    g.beginPath();
    g.moveTo(0, yy + 0.5);
    g.lineTo(w, yy + 0.5);
    g.stroke();
  }
  const gr = g.createLinearGradient(0, 0, 0, h);
  gr.addColorStop(0, up ? 'rgba(0,210,106,.34)' : 'rgba(255,76,59,.3)');
  gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.beginPath();
  g.moveTo(X(0), h);
  d.forEach((v, i) => g.lineTo(X(i), Y(v)));
  g.lineTo(X(d.length - 1), h);
  g.closePath();
  g.fillStyle = gr;
  g.fill();
  g.beginPath();
  d.forEach((v, i) => (i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v))));
  g.strokeStyle = up ? '#00d26a' : '#ff4c3b';
  g.lineWidth = 1.4;
  g.stroke();
  g.fillStyle = up ? '#9dffcb' : '#ffb0a6';
  g.fillRect(X(d.length - 1) - 2, Y(d[d.length - 1] as number) - 2, 4, 4);
}
