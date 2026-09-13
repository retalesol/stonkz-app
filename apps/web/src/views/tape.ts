import type { Fill } from '@stonkz/shared';
import { pct, usd } from '@stonkz/shared';
import { api } from '../api/index.js';
import { navigate } from '../app/route.js';
import { miniChart } from '../canvas/spark.js';
import { pix } from '../canvas/pix.js';
import { burst } from '../fx/debris.js';
import { $, must, reflow } from '../lib/dom.js';
import { DOT, fakeAddr, ud } from '../lib/fmt.js';
import { attr, html, node, render } from '../lib/html.js';
import { reducedMotion } from '../lib/motion.js';
import { canHover } from '../lib/pointer.js';
import { COINS, bySym, seedSeries, type SimCoin } from '../state/coins.js';

/**
 * The live tape.
 *
 * Sim mode still invents its own prints on a loop (cosmetic, unrelated to any
 * particular trade). Live mode drives the exact same strip from real
 * `board`/`tape` WS fills via `pushFill()` — the punch, the jolt, the debris,
 * the frozen hover print and its chart are unchanged either way.
 * `plan step 65`, `index.html:1278`
 */

let run: HTMLElement;
let vp: HTMLElement;
let tape: HTMLElement;
let loop = 0;

function vw(): number {
  return vp.clientWidth;
}

/** A wholly-invented print — sim mode only. `index.html:1278` */
function randomFill(): Fill {
  const c = COINS[(Math.random() * COINS.length) | 0] as SimCoin;
  return {
    t: Date.now(),
    sym: c.sym,
    net: c.net ?? 'SOL',
    buy: Math.random() > 0.42,
    sol: 0.05 + Math.random() * 9,
    tok: 0,
    mc: c.mc,
    w: fakeAddr((Math.random() * 1e6) | 0),
    v: 0,
  };
}

function build(f: Fill): HTMLElement {
  const el = node(
    html`<span class="tx" data-sym="${attr(f.sym)}"
      ><i class="blk ${f.buy ? 'up' : 'dn'}"></i><b class="${f.buy ? 'up' : 'dn'}">${f.buy ? 'BUY' : 'SELL'}</b
      ><span>${f.sol.toFixed(2)} ${f.net === 'RH' ? 'ETH' : 'SOL'}</span><b class="gd">${f.sym}</b><b class="dm">${DOT}</b
      ><span class="dm">${f.w}</span></span
    >`,
  );
  return el as HTMLElement;
}

function trim(): void {
  while (run.children.length > 60) run.removeChild(run.firstChild as ChildNode);
  const w = vw();
  if (!w) return;
  while (run.offsetWidth > w * 2.6 && run.children.length > 4) run.removeChild(run.firstChild as ChildNode);
}

function push(f: Fill, animate: boolean): void {
  const el = build(f);
  run.appendChild(el);
  if (!animate || reducedMotion()) {
    trim();
    return;
  }
  const w = el.getBoundingClientRect().width;
  run.style.transition = 'none';
  run.style.transform = 'translateX(' + w + 'px)';
  reflow(run);
  run.style.transition = 'transform .26s cubic-bezier(.12,.86,.24,1)';
  run.style.transform = 'translateX(0)';
  el.classList.add('punch');
  tape.classList.remove('jolt');
  reflow(tape);
  tape.classList.add('jolt');
  setTimeout(() => {
    const r = el.getBoundingClientRect();
    burst(r.left, r.top + 2, Math.max(6, r.height - 4), { n: 20 });
  }, 130);
  trim();
}

/** The live renderer: a real `board`/`tape` WS fill, or the initial seed batch. */
export function pushFill(f: Fill, animate: boolean): void {
  push(f, animate);
}

/* ----------------------------- hover: freeze one print, chart it ----------- */

let pinned: HTMLElement | null = null;
let src: HTMLElement | null = null;
let pop: HTMLElement | null = null;

function hit(r: DOMRect, e: MouseEvent, pad = 6): boolean {
  return e.clientX >= r.left - pad && e.clientX <= r.right + pad && e.clientY >= r.top - pad && e.clientY <= r.bottom + pad;
}

/** Pick a candle window from the coin's age, the way a terminal would. `index.html:1320` */
function tfOf(c: SimCoin): { label: string; n: number } {
  const a = c.age;
  const t: [string, number] =
    a >= 1440
      ? ['24H', 160]
      : a >= 720
        ? ['12H', 120]
        : a >= 240
          ? ['4H', 90]
          : a >= 60
            ? ['1H', 60]
            : a >= 30
              ? ['30M', 40]
              : a >= 15
                ? ['15M', 25]
                : ['5M', 14];
  return { label: t[0], n: Math.max(8, Math.min(t[1], c.h ? c.h.length : 0)) };
}

function showPop(el: HTMLElement, c: SimCoin): void {
  seedSeries(c);
  const t = tfOf(c);
  const d = (c.h as number[]).slice(-t.n);
  pop = document.createElement('div');
  pop.className = 'tpop';
  render(
    pop,
    html`<div class="tp-hd">
        <canvas class="av" width="64" height="64" aria-hidden="true"></canvas>
        <div><div class="sy">${c.sym}</div><div class="nm">${c.name}</div></div>
        <div class="px"><b class="am">${usd(c.mc)}</b><span class="${ud(c.chg)}">${pct(c.chg)}</span></div>
      </div>
      <canvas class="tp-chart"></canvas>
      <div class="tp-ft">
        <span>LAST ${t.label} ${DOT} ${t.n} CANDLES</span><span class="am">CLICK TO OPEN</span>
      </div>`,
  );
  document.body.appendChild(pop);
  pix(pop.querySelector<HTMLCanvasElement>('.av'), c.seed);
  const r = el.getBoundingClientRect();
  const w = pop.offsetWidth;
  pop.style.left = Math.max(6, Math.min(window.innerWidth - w - 6, r.left)) + 'px';
  pop.style.top = r.bottom + 3 + 'px';
  miniChart(pop.querySelector<HTMLCanvasElement>('.tp-chart'), d, c.chg >= 0);
}

function pin(el: HTMLElement): void {
  const c = bySym(el.dataset['sym'] ?? '');
  if (!c) return;
  const vr = vp.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  // Freeze a copy; the original keeps sliding.
  const clone = el.cloneNode(true) as HTMLElement;
  // `punch`'s fill-mode would otherwise keep the clone transparent.
  clone.classList.remove('punch', 'fading');
  clone.classList.add('pinned');
  clone.style.left = r.left - vr.left + 'px';
  clone.style.width = r.width + 'px';
  vp.appendChild(clone);
  el.classList.add('src');
  pinned = clone;
  src = el;
  showPop(clone, c);
  document.addEventListener('mousemove', onMove);
}

export function unpin(): void {
  if (!pinned) return;
  const el = pinned;
  pinned = null;
  if (src) {
    src.classList.remove('src');
    src = null;
  }
  document.removeEventListener('mousemove', onMove);
  if (pop) {
    pop.remove();
    pop = null;
  }
  // The frozen copy dissolves; the strip itself is untouched.
  el.classList.add('fading');
  setTimeout(() => {
    if (el.parentNode) el.parentNode.removeChild(el);
  }, 340);
}

function onMove(e: MouseEvent): void {
  if (!pinned) return;
  if (hit(pinned.getBoundingClientRect(), e)) return;
  if (pop && hit(pop.getBoundingClientRect(), e, 4)) return;
  unpin();
}

export function initTape(): void {
  run = must('#tape');
  vp = run.parentNode as HTMLElement;
  tape = vp.parentNode as HTMLElement;

  // Hover-only. A tap on a touch device goes straight to the token below.
  vp.addEventListener('mouseover', (e) => {
    if (pinned || !canHover()) return;
    const el = (e.target as Element | null)?.closest<HTMLElement>('.tx') ?? null;
    if (el && !el.classList.contains('pinned')) pin(el);
  });
  vp.addEventListener('click', (e) => {
    const el = (e.target as Element | null)?.closest<HTMLElement>('.tx') ?? null;
    if (!el) return;
    const c = bySym(el.dataset['sym'] ?? '');
    unpin();
    if (c) navigate({ view: 'token', sym: c.sym, ...(c.mint ? { mint: c.mint } : {}) });
  });
  document.addEventListener('mouseleave', () => {
    if (pinned) unpin();
  });
  window.addEventListener('scroll', () => { if (pinned) unpin(); }, { passive: true });
  window.addEventListener('resize', () => { if (pinned) unpin(); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) trim();
  });

  // Live mode seeds from `GET /tape` and drives every print after that from
  // real WS fills (`pushFill`, wired in `app/loop.ts`). The self-looping
  // random strip stays sim-only. `plan step 65`
  if (api.mode === 'sim') {
    for (let i = 0; i < 16; i++) push(randomFill(), false);
    const next = (): void => {
      loop = window.setTimeout(() => {
        push(randomFill(), true);
        next();
      }, 850 + Math.random() * 1500);
    };
    next();
  }
}

/** Only the tests need this; the tape runs for the life of the page. */
export function stopTape(): void {
  if (loop) clearTimeout(loop);
  loop = 0;
}

/** The hidden `#tapefx` canvas the markup reserves for the Phase 1 fill stream. */
export const tapeFx = (): HTMLCanvasElement | null => $<HTMLCanvasElement>('#tapefx');
