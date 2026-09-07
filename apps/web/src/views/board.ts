import { type Lane, ago, curve, laneOf, num, pct, usd } from '@stonkz/shared';
import { navigate } from '../app/route.js';
import { pix } from '../canvas/pix.js';
import { spark } from '../canvas/spark.js';
import { burst } from '../fx/debris.js';
import { punchIn } from '../fx/punch.js';
import { toast } from '../fx/toast.js';
import { $, $$, must, reflow } from '../lib/dom.js';
import { DOT, ud } from '../lib/fmt.js';
import { attr, html, render } from '../lib/html.js';
import { reducedMotion } from '../lib/motion.js';
import { COINS, histOf, type SimCoin } from '../state/coins.js';
import { currentView } from '../app/view.js';

/**
 * The three-lane board.
 *
 * Cards are built once and cached on `c.el`, then patched field by field by
 * `paint()`. Nothing here re-renders a lane on a price move: an `innerHTML`
 * rebuild would throw away scroll position, focus and the flash classes on
 * every beat. Lane changes move the cached node and animate with FLIP.
 * `index.html:1416`
 */

type SortKey = 'new' | 'mc' | 'chg' | 'rep';

let LANES: Record<Lane, HTMLElement>;
let sortKey: SortKey = 'new';

/** Build a card once. `index.html:1418` */
function card(c: SimCoin): HTMLElement {
  const b = document.createElement('div');
  b.className = 'coin';
  b.dataset['sym'] = c.sym;
  b.setAttribute('role', 'button');
  b.tabIndex = 0;
  render(
    b,
    html`<canvas width="96" height="96" aria-hidden="true"></canvas
      ><div>
        <div class="cn"><b>${c.sym}</b><span class="nm">${c.name}</span
          ><span class="chg ${ud(c.chg)}" data-f="chg">${pct(c.chg)}</span></div
        ><div class="cmeta">by <i class="addrlink" data-addr="${attr(c.dev)}">${c.dev}</i> ${DOT} ${ago(c.age)} ${DOT}
          <span data-f="rep">${c.reps}</span> replies</div
        ><p class="cdesc">${c.desc}</p
        ><div class="cstats"><span class="mc" data-f="mc">${usd(c.mc)}</span><span>HOLDERS ${num(c.hold)}</span
          ><span class="cv" data-f="cv">${curve(c) >= 100 ? 'GRADUATED' : curve(c).toFixed(0) + '%'}</span></div
        ></div
      ><i class="cbar" data-f="bar" style="width:${attr(curve(c))}%"></i>`,
  );
  pix(b.querySelector('canvas'), c.seed);
  b.addEventListener('click', (e) => {
    // The creator link is a nested control; let the board delegate handle it.
    if ((e.target as Element | null)?.closest('.addrlink')) return;
    navigate({ view: 'token', sym: c.sym });
  });
  b.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      navigate({ view: 'token', sym: c.sym });
    }
  });
  c.el = b;
  return b;
}

/** Patch a cached card in place. `index.html:1438` */
export function paint(c: SimCoin): void {
  const e = c.el;
  if (!e) return;
  const mcEl = $('[data-f="mc"]', e);
  const v = usd(c.mc);
  if (mcEl && mcEl.textContent !== v) {
    mcEl.classList.remove('fu', 'fd');
    reflow(mcEl);
    mcEl.classList.add(c.mc >= c.lastMc ? 'fu' : 'fd');
    mcEl.textContent = v;
  }
  const ch = $('[data-f="chg"]', e);
  if (ch) {
    ch.textContent = pct(c.chg);
    ch.className = 'chg ' + ud(c.chg);
  }
  const rep = $('[data-f="rep"]', e);
  if (rep) rep.textContent = String(c.reps);
  const cv = curve(c);
  const cvEl = $('[data-f="cv"]', e);
  if (cvEl) cvEl.textContent = cv >= 100 ? 'GRADUATED' : cv.toFixed(0) + '%';
  const bar = $('[data-f="bar"]', e);
  if (bar) bar.style.width = cv + '%';
}

function sortCoins(list: SimCoin[]): SimCoin[] {
  return list.slice().sort((x, y) => {
    if (sortKey === 'mc') return y.mc - x.mc;
    if (sortKey === 'chg') return y.chg - x.chg;
    if (sortKey === 'rep') return y.reps - x.reps;
    return x.age - y.age;
  });
}

/** Build and place a coin that appeared after boot. `index.html:4074` */
export function addCoin(c: SimCoin): void {
  if (!c.el) card(c);
  landIn(c, (c.lane ?? 'new') as Lane);
  counts();
}

/**
 * Hide cards that do not match the query.
 *
 * A filter, not a re-render: hiding is a `display` flip on the cached nodes so
 * the flash classes and scroll position survive. `index.html:4014`
 */
export function filterBoard(query: string): void {
  const v = query.trim().toUpperCase();
  let n = 0;
  for (const c of COINS) {
    const hit = !v || c.sym.indexOf(v) > -1 || c.name.toUpperCase().indexOf(v) > -1 || c.dev.toUpperCase().indexOf(v) > -1;
    if (c.el) c.el.style.display = hit ? '' : 'none';
    if (hit) n++;
  }
  must('#count').textContent = n + (v ? ' MATCH' : ' COINS');
}

export function counts(): void {
  const n: Record<Lane, number> = { new: 0, soon: 0, grad: 0 };
  for (const c of COINS) if (c.lane) n[c.lane]++;
  must('#n-new').textContent = n.new + ' LIVE';
  must('#n-soon').textContent = n.soon + ' CLOSE';
  must('#n-grad').textContent = n.grad + ' ON DEX';
  must('#count').textContent = COINS.length + ' COINS';
}

export function renderBoard(): void {
  for (const k of Object.keys(LANES) as Lane[]) LANES[k].innerHTML = '';
  for (const c of COINS) {
    c.lane = laneOf(c);
    if (!c.el) card(c);
  }
  for (const c of sortCoins(COINS)) LANES[c.lane as Lane].appendChild(c.el as HTMLElement);
  counts();
}

/** FLIP: the neighbours start where they were and slide to where they are. `index.html:1475` */
function slideFrom(els: HTMLElement[], dy: number): void {
  if (!els.length) return;
  for (const el of els) {
    el.style.transition = 'none';
    el.style.transform = 'translateY(' + dy + 'px)';
  }
  reflow(els[0] as HTMLElement);
  for (const el of els) {
    el.style.transition = 'transform .34s cubic-bezier(.12,.86,.24,1)';
    el.style.transform = 'translateY(0)';
  }
  setTimeout(() => {
    for (const el of els) {
      el.style.transition = '';
      el.style.transform = '';
    }
  }, 400);
}

/** Move a cached card into a new lane, animating both lanes. `index.html:1487` */
export function landIn(c: SimCoin, lane: Lane): void {
  const el = c.el;
  if (!el) return;
  const L = LANES[lane];
  const from = el.parentNode as HTMLElement | null;
  const live = currentView() === 'board' && !must('#boardView').hidden && !reducedMotion();
  let h = live ? el.offsetHeight : 0;
  const vacated: HTMLElement[] = [];
  if (live && from && from !== L) {
    // The lane it leaves closes its gap smoothly too.
    let seen = false;
    for (const sib of Array.from(from.children) as HTMLElement[]) {
      if (sib === el) {
        seen = true;
        continue;
      }
      if (seen) vacated.push(sib);
    }
  }
  L.insertBefore(el, L.firstChild);
  if (!live) return;
  if (!h) h = el.offsetHeight;
  slideFrom(vacated, h);
  slideFrom(Array.from(L.children).slice(1) as HTMLElement[], -h);
  punchIn(el, { n: 16 });
}

/* ---------------------------- king of the hill ---------------------------- */

let kothId: number | null = null;

export function king(): void {
  let best: SimCoin | null = null;
  for (const c of COINS) if (c.lane !== 'grad' && (!best || c.mc > best.mc)) best = c;
  if (!best) best = COINS[0] as SimCoin;
  const koth = must('#koth');
  if (best.id !== kothId) {
    const first = kothId === null;
    kothId = best.id;
    render(
      koth,
      html`<span class="crown">KING OF THE HILL</span
        ><canvas width="128" height="128" style="width:74px;height:74px"></canvas
        ><div>
          <div class="kn">${best.sym}<small>${best.name}</small></div>
          <p>${best.desc}</p>
          <div class="kstats">
            <span><span class="lbl">MARKET CAP</span><b class="am" id="k-mc">${usd(best.mc)}</b></span
            ><span><span class="lbl">24H</span><b class="${ud(best.chg)}" id="k-chg">${pct(best.chg)}</b></span
            ><span><span class="lbl">CURVE</span><b id="k-cv">${curve(best).toFixed(1)}%</b></span
            ><span><span class="lbl">HOLDERS</span><b>${num(best.hold)}</b></span
            ><span><span class="lbl">CREATED</span><b>${ago(best.age)}</b></span>
          </div>
        </div
      ><canvas class="ksp" width="300" height="88"></canvas>`,
    );
    pix($<HTMLCanvasElement>('#koth canvas'), best.seed);
    spark($<HTMLCanvasElement>('#koth .ksp'), histOf(best, 48));
    if (!first && !reducedMotion()) {
      koth.classList.remove('crowned');
      reflow(koth);
      koth.classList.add('crowned');
      setTimeout(() => {
        const r = koth.getBoundingClientRect();
        burst(r.left, r.top + 4, Math.max(8, r.height - 8), { n: 36, gold: true, spread: 1.3 });
      }, 140);
      toast(best.sym + ' TAKES THE HILL ' + DOT + ' ' + usd(best.mc));
    }
  } else {
    const mc = $('#k-mc');
    if (mc) mc.textContent = usd(best.mc);
    const ce = $('#k-chg');
    if (ce) {
      ce.textContent = pct(best.chg);
      ce.className = ud(best.chg);
    }
    const cv = $('#k-cv');
    if (cv) cv.textContent = curve(best).toFixed(1) + '%';
  }
}

/* -------------------------------- wiring ---------------------------------- */

export function initBoard(): void {
  LANES = {
    new: must('#lane-new'),
    soon: must('#lane-soon'),
    grad: must('#lane-grad'),
  };
  renderBoard();
  king();

  for (const chip of $$('.filters .chip')) {
    chip.addEventListener('click', () => {
      sortKey = (chip.dataset['sort'] as SortKey) ?? 'new';
      for (const other of $$('.filters .chip')) other.classList.toggle('on', other === chip);
      renderBoard();
    });
  }

  // One delegated listener for every creator link on the board.
  must('.board').addEventListener('click', (e) => {
    const link = (e.target as Element | null)?.closest<HTMLElement>('.addrlink');
    if (!link) return;
    e.stopPropagation();
    navigate({ view: 'profile', addr: link.dataset['addr'] as string });
  });
}
