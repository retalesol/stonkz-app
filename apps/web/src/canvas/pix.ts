import { MEMEMAN_SRC, paintAvatar } from '../lib/avatar.js';
import { rng } from '@stonkz/shared';

/** Avatar palette. `index.html:1145` */
export const PAL = ['#ffa22b', '#00d26a', '#4d9bff', '#a273ff', '#ffd23f', '#ff4c3b', '#26d0c4', '#ff7ac0'];

/** Amber square used when a coin has no custom upload. */
export const COIN_DEFAULT_BG = '#ffa22b';

/**
 * Seeded 8x8 mirrored pixel avatar. Kept for legacy callers (wizard / tape);
 * launch + board coin art defaults to orange mememan via `paintCoinArt`.
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

/** Mememan on a fixed amber field — default coin art when nothing was uploaded. */
export function paintDefaultCoinArt(
  cv: HTMLCanvasElement | null | undefined,
  logicalSize?: number,
): void {
  if (!cv) return;
  const size = logicalSize ?? (cv.clientWidth || Number(cv.getAttribute('width')) || 64);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = Math.round(size * dpr);
  cv.height = Math.round(size * dpr);
  cv.style.width = size + 'px';
  cv.style.height = size + 'px';
  const g = cv.getContext('2d');
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.imageSmoothingEnabled = false;
  g.fillStyle = COIN_DEFAULT_BG;
  g.fillRect(0, 0, size, size);
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => {
    const pad = size * 0.06;
    g.drawImage(img, pad, pad, size - pad * 2, size - pad * 2);
  };
  img.src = MEMEMAN_SRC;
}

/** Custom IPFS art when set; otherwise orange mememan. */
export function paintCoinArt(
  cv: HTMLCanvasElement | null | undefined,
  seed: number,
  imageUrl?: string | null,
): void {
  if (!cv) return;
  const size = cv.clientWidth || Number(cv.getAttribute('width')) || 64;
  if (imageUrl?.trim()) {
    paintAvatar(cv, { seed, avatarUrl: imageUrl.trim(), size });
    return;
  }
  paintDefaultCoinArt(cv, size);
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
