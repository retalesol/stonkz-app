import { must } from '../lib/dom.js';
import { reducedMotion } from '../lib/motion.js';

/**
 * The full-viewport debris canvas. Every punch, fill, crowning, achievement and
 * rank-up throws pixels through here. `index.html:1215`
 */

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  s: number;
  l: number;
  c: string;
}

export interface BurstOptions {
  /** Particle count for the leading spray. Default 22. */
  n?: number;
  /** Velocity multiplier. Default 1. */
  spread?: number;
  gold?: boolean;
  green?: boolean;
}

const ORANGE = ['#ffa22b', '#ffd23f', '#c87c14', '#ff8c00', '#ffb454'];
const GOLD = ['#ffd23f', '#ffe680', '#fff3c0', '#ffa22b'];
const GREEN = ['#00d26a', '#6cf0a5', '#2bff8f', '#b6ffd8'];

let cv: HTMLCanvasElement;
let g: CanvasRenderingContext2D;
const parts: Particle[] = [];
let raf = 0;
let W = 0;
let H = 0;

function size(): void {
  const d = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  cv.width = Math.max(1, W * d);
  cv.height = Math.max(1, H * d);
  g.setTransform(d, 0, 0, d, 0, 0);
}

function step(): void {
  g.clearRect(0, 0, W, H);
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i] as Particle;
    p.x += p.vx;
    p.y += p.vy;
    p.vy += 0.12;
    p.vx *= 0.982;
    p.l -= 0.034;
    if (p.l <= 0 || p.x < -10 || p.x > W + 10 || p.y > H + 10) {
      parts.splice(i, 1);
      continue;
    }
    g.globalAlpha = p.l > 1 ? 1 : p.l;
    g.fillStyle = p.c;
    g.fillRect(p.x | 0, p.y | 0, p.s, p.s);
  }
  g.globalAlpha = 1;
  raf = parts.length ? requestAnimationFrame(step) : 0;
}

/** Wire the canvas once at boot. */
export function initFx(): void {
  cv = must<HTMLCanvasElement>('#fx');
  const ctx = cv.getContext('2d');
  if (!ctx) throw new Error('#fx has no 2d context');
  g = ctx;
  size();
  window.addEventListener('resize', size);
}

/** Throw debris from a rectangle. Silent under `prefers-reduced-motion`. */
export function burst(x: number, y: number, h: number, o: BurstOptions = {}): void {
  if (reducedMotion()) return;
  if (!cv) return;
  if (!W) size();
  if (y + h < 0 || y > H || x < -40 || x > W + 40) return;
  const n = o.n ?? 22;
  const sp = o.spread ?? 1;
  const pal = o.gold ? GOLD : o.green ? GREEN : ORANGE;
  for (let i = 0; i < n; i++) {
    parts.push({
      x: x + Math.random() * 3 - 1,
      y: y + Math.random() * h,
      vx: -(0.5 + Math.random() * 3.6) * sp,
      vy: (Math.random() - 0.5) * 3.2 * sp,
      s: Math.random() > 0.72 ? 3 : 2,
      l: 1,
      c: pal[(Math.random() * pal.length) | 0] as string,
    });
  }
  const m = Math.max(3, Math.round(n / 3));
  for (let i = 0; i < m; i++) {
    parts.push({
      x: x + 2 + Math.random() * 15,
      y: y + Math.random() * h,
      vx: (0.4 + Math.random() * 2) * sp,
      vy: (Math.random() - 0.5) * 2.4 * sp,
      s: 2,
      l: 0.85,
      c: pal[(Math.random() * pal.length) | 0] as string,
    });
  }
  if (parts.length > 460) parts.splice(0, parts.length - 460);
  if (!raf) raf = requestAnimationFrame(step);
}

/** Burst along an element's left edge, the shape every caller actually wants. */
export function burstFrom(el: Element, o: BurstOptions = {}): void {
  const r = el.getBoundingClientRect();
  burst(r.left, r.top + 2, Math.max(6, r.height - 4), o);
}
