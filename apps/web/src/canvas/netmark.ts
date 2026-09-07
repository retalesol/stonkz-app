import type { Net } from '@stonkz/shared';

/** The Solana bars / Robinhood feather marks in the network picker. `index.html:2452` */
export function netMark(cv: HTMLCanvasElement | null, k: Net | string | undefined): void {
  if (!cv) return;
  const g = cv.getContext('2d');
  if (!g) return;
  const w = cv.width;
  g.clearRect(0, 0, w, w);
  if (k === 'SOL') {
    const cols = ['#9945ff', '#6f7dff', '#14f195'];
    for (let i = 0; i < 3; i++) {
      const y = w * 0.2 + i * w * 0.23;
      const sk = w * 0.15;
      const lead = i === 1;
      g.fillStyle = cols[i] as string;
      g.beginPath();
      g.moveTo(w * 0.14 + (lead ? 0 : sk), y);
      g.lineTo(w * 0.86, y);
      g.lineTo(w * 0.86 - (lead ? sk : 0), y + w * 0.14);
      g.lineTo(w * 0.14, y + w * 0.14);
      g.closePath();
      g.fill();
    }
  } else {
    g.fillStyle = '#00c805';
    g.beginPath();
    g.moveTo(w * 0.8, w * 0.14);
    g.quadraticCurveTo(w * 0.28, w * 0.2, w * 0.2, w * 0.84);
    g.quadraticCurveTo(w * 0.64, w * 0.64, w * 0.8, w * 0.14);
    g.closePath();
    g.fill();
    g.strokeStyle = '#07430a';
    g.lineWidth = Math.max(1, w * 0.045);
    g.beginPath();
    g.moveTo(w * 0.77, w * 0.17);
    g.lineTo(w * 0.23, w * 0.85);
    g.stroke();
  }
}

/** Repaint every `[data-mark]` canvas — the picker only paints when it opens. */
export function paintNetMarks(root: ParentNode = document): void {
  root.querySelectorAll<HTMLCanvasElement>('[data-mark]').forEach((cv) => netMark(cv, cv.dataset['mark']));
}
