import { rng } from '@stonkz/shared';

/** Avatar palette. `index.html:1145` */
export const PAL = ['#ffa22b', '#00d26a', '#4d9bff', '#a273ff', '#ffd23f', '#ff4c3b', '#26d0c4', '#ff7ac0'];

/**
 * Seeded 8x8 mirrored pixel avatar. Stays the default art after Phase 5 —
 * uploads only replace it when one exists. `index.html:1146`
 */
export function pix(cv: HTMLCanvasElement | null | undefined, seed: number): void {
  if (!cv) return;
  const g = cv.getContext('2d');
  if (!g) return;
  const r = rng(seed);
  const n = 8;
  const s = cv.width / n;
  const fg = PAL[(r() * PAL.length) | 0] as string;
  const fg2 = PAL[(r() * PAL.length) | 0] as string;
  g.fillStyle = '#0b0e14';
  g.fillRect(0, 0, cv.width, cv.height);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < 4; x++) {
      const v = r();
      if (v > 0.5) {
        g.fillStyle = v > 0.86 ? fg2 : fg;
        g.fillRect(x * s, y * s, s, s);
        g.fillRect((n - 1 - x) * s, y * s, s, s);
      }
    }
  }
}

/** The same avatar drawn into an existing context, for the wizard art. `index.html:2816` */
export function miniAv(g: CanvasRenderingContext2D, x: number, y: number, size: number, seed: number): void {
  const r = rng(seed);
  const n = 8;
  const c = size / n;
  const fg = PAL[(r() * PAL.length) | 0] as string;
  const fg2 = PAL[(r() * PAL.length) | 0] as string;
  g.fillStyle = '#0b0e14';
  g.fillRect(x, y, size, size);
  for (let yy = 0; yy < n; yy++) {
    for (let xx = 0; xx < 4; xx++) {
      const v = r();
      if (v > 0.5) {
        g.fillStyle = v > 0.86 ? fg2 : fg;
        g.fillRect(x + xx * c, y + yy * c, Math.ceil(c), Math.ceil(c));
        g.fillRect(x + (n - 1 - xx) * c, y + yy * c, Math.ceil(c), Math.ceil(c));
      }
    }
  }
}

/** Paint every `[data-seed]` canvas inside a freshly rendered subtree. */
export function paintSeeded(root: ParentNode | null): void {
  if (!root) return;
  root.querySelectorAll<HTMLCanvasElement>('canvas[data-seed]').forEach((cv) => {
    pix(cv, Number(cv.dataset['seed']));
  });
}

/** Device-pixel-ratio setup shared by every non-pixel canvas. */
export function fitCanvas(cv: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  if (w < 2 || h < 2) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = w * dpr;
  cv.height = h * dpr;
  const g = cv.getContext('2d');
  if (!g) return null;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return g;
}
