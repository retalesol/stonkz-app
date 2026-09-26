import { NET_INFO, type Net } from '@stonkz/shared';

type Painter = (g: CanvasRenderingContext2D, w: number) => void;

/** Solana: three skewed bars. */
function solMark(g: CanvasRenderingContext2D, w: number): void {
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
}

/** Base: the blue rounded square with a B. */
function baseMark(g: CanvasRenderingContext2D, w: number): void {
  g.fillStyle = NET_INFO.BASE.col;
  g.beginPath();
  g.roundRect(w * 0.18, w * 0.18, w * 0.64, w * 0.64, w * 0.12);
  g.fill();
  g.fillStyle = '#ffffff';
  g.font = 'bold ' + Math.round(w * 0.28) + 'px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('B', w * 0.5, w * 0.52);
}

/** Arc: a blue ring with a dollar mark — USDC is the gas. */
function arcMark(g: CanvasRenderingContext2D, w: number): void {
  g.strokeStyle = NET_INFO.ARC.col;
  g.lineWidth = Math.max(1.5, w * 0.11);
  g.beginPath();
  g.arc(w * 0.5, w * 0.5, w * 0.31, Math.PI * 0.15, Math.PI * 1.85);
  g.stroke();
  g.fillStyle = NET_INFO.ARC.col;
  g.font = 'bold ' + Math.round(w * 0.34) + 'px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('$', w * 0.5, w * 0.53);
}

/** Robinhood: the feather. */
function rhMark(g: CanvasRenderingContext2D, w: number): void {
  g.fillStyle = NET_INFO.RH.col;
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

const MARKS: Record<Net, Painter> = { SOL: solMark, BASE: baseMark, ARC: arcMark, RH: rhMark };

/** The network mark in the picker, keyed by net; unknown keys draw nothing. */
export function netMark(cv: HTMLCanvasElement | null, k: Net | string | undefined): void {
  if (!cv) return;
  const g = cv.getContext('2d');
  if (!g) return;
  const w = cv.width;
  g.clearRect(0, 0, w, w);
  const paint = MARKS[k as Net];
  if (paint) paint(g, w);
}

/** Repaint every `[data-mark]` canvas — the picker only paints when it opens. */
export function paintNetMarks(root: ParentNode = document): void {
  root
    .querySelectorAll<HTMLCanvasElement>('[data-mark]')
    .forEach((cv) => netMark(cv, cv.dataset['mark']));
}
