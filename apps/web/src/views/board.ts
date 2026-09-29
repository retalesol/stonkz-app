import {
  ALL_NETS,
  NET_INFO,
  type Lane,
  type Net,
  ago,
  curve,
  laneOf,
  num,
  pct,
  usd,
} from '@stonkz/shared';
import { api } from '../api/index.js';
import { navigate } from '../app/route.js';
import { currentView } from '../app/view.js';
import { paintCoinArt } from '../canvas/pix.js';
import { spark } from '../canvas/spark.js';
import { burst } from '../fx/debris.js';
import { punchIn } from '../fx/punch.js';
import { toast } from '../fx/toast.js';
import { on } from '../lib/bus.js';
import { $, $$, clear, must, reflow } from '../lib/dom.js';
import { DOT, fmtCurve, shortAddr, ud } from '../lib/fmt.js';
import { attr, html, render } from '../lib/html.js';
import { reducedMotion } from '../lib/motion.js';
import { COINS, histOf, type SimCoin } from '../state/coins.js';
import { WALLET } from '../state/wallet.js';
import { isDeployed } from '../wallet/chain.js';
import {
  type BoardParams,
  type NetFilter,
  type SortKey,
  boardParamsToSearch,
  compareCoins,
  matchesQuery,
  parseBoardParams,
  visibleNets,
} from './board-state.js';

export type { NetFilter, SortKey } from './board-state.js';

/**
 * The three-lane board.
 *
 * Cards are built once and cached on `c.el`, then patched field by field by
 * `paint()`. Nothing here re-renders a lane on a price move: an `innerHTML`
 * rebuild would throw away scroll position, focus and the flash classes on
 * every beat. Lane changes move the cached node and animate with FLIP.
 *
 * Paints are batched: a WS burst marks cards dirty and one animation frame
 * writes them all, with a single forced layout for the flash restarts rather
 * than one per card. The SORT / NET chips and the FIND box round-trip through
 * `?sort=&net=&q=` so a filtered board can be linked and comes back the same
 * way after BACK. `index.html:1416`
 */

let LANES: Record<Lane, HTMLElement>;
/** The copy each lane shows when nothing is in it. */
let EMPTY: Record<Lane, HTMLElement>;
let sortKey: SortKey = 'new';
/** Which chain the board shows. `ALL` is the guest view; a wallet pins its own net. */
let netFilter: NetFilter = 'ALL';
let query = '';
/** "API UNREACHABLE" and the like, shown in the empty lanes instead of a shrug. */
let notice: string | null = null;
/** Installed by the shell: what to do when a connected user taps another chain's chip. */
let switchNet: ((net: Net) => void) | null = null;
let moreBtn: HTMLButtonElement | null = null;

const EMPTY_COPY: Record<Lane, string> = {
  new: 'NO NEW MINTS HERE YET ' + DOT + ' LAUNCH THE FIRST',
  soon: 'NOTHING CLOSE TO GRADUATING RIGHT NOW',
  grad: 'NO GRADUATES YET ' + DOT + ' FIRST TO $69K MOVES HERE',
};

export function setNetSwitchHandler(fn: (net: Net) => void): void {
  switchNet = fn;
}

/** The chain badge every card and token header carries. */
export function netPill(net: Net): ReturnType<typeof html> {
  const info = NET_INFO[net];
  return html`<span class="netpill" style="--nc:${attr(info.col)}" title="${attr(info.name)}"
    ><i></i>${info.short}</span
  >`;
}

/* --------------------------------- URL state ------------------------------ */

function params(): BoardParams {
  return { sort: sortKey, net: netFilter, q: query };
}

let urlTimer = 0;

/**
 * Mirror the chips and the query into the address bar. `replaceState`, never
 * push: a filter is a view of the board, not a place BACK should stop at.
 * Debounced because Safari rate-limits history writes and the FIND box
 * fires per keystroke.
 */
function writeUrl(immediate = false): void {
  if (urlTimer) {
    clearTimeout(urlTimer);
    urlTimer = 0;
  }
  const flush = (): void => {
    urlTimer = 0;
    if (location.pathname !== '/') return;
    const next = '/' + boardParamsToSearch(params());
    if (location.pathname + location.search === next) return;
    history.replaceState(history.state, '', next);
  };
  if (immediate) flush();
  else urlTimer = window.setTimeout(flush, 300);
}

/** Take sort / net / query from the address bar (boot, and BACK onto the board). */
function readUrl(): void {
  if (location.pathname !== '/') return;
  const p = parseBoardParams(location.search);
  sortKey = p.sort;
  for (const chip of $$('.filters .chip[data-sort]'))
    chip.classList.toggle('on', chip.dataset['sort'] === sortKey);
  // A connected wallet pins its own chain; a hidden chain falls back to ALL.
  netFilter = WALLET.on ? WALLET.net : p.net !== 'ALL' && !nets().includes(p.net) ? 'ALL' : p.net;
  query = p.q;
  const q = $<HTMLInputElement>('#q');
  if (q && q.value !== query) q.value = query;
}

/* ---------------------------------- cards --------------------------------- */

interface CardRefs {
  mc: HTMLElement;
  chg: HTMLElement;
  rep: HTMLElement;
  hold: HTMLElement;
  cv: HTMLElement;
  bar: HTMLElement;
  age: HTMLElement;
}

/** Field nodes looked up once per card, so a paint is six writes and no queries. */
const REFS = new WeakMap<HTMLElement, CardRefs>();
const COIN_OF = new WeakMap<Element, SimCoin>();

/**
 * Launch images load when the card scrolls near the viewport, not all 500 on
 * boot. Every card gets the pixel art first, so nothing is blank meanwhile.
 */
const lazyArt =
  typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(
        (entries) => {
          for (const en of entries) {
            if (!en.isIntersecting) continue;
            lazyArt?.unobserve(en.target);
            const c = COIN_OF.get(en.target);
            if (c?.image)
              paintCoinArt($<HTMLCanvasElement>('canvas', en.target), c.seed, c.image, 52);
          }
        },
        { rootMargin: '240px 0px' },
      )
    : null;

function refsOf(b: HTMLElement): CardRefs {
  return {
    mc: must('[data-f="mc"]', b),
    chg: must('[data-f="chg"]', b),
    rep: must('[data-f="rep"]', b),
    hold: must('[data-f="hold"]', b),
    cv: must('[data-f="cv"]', b),
    bar: must('[data-f="bar"]', b),
    age: must('[data-f="age"]', b),
  };
}

function curveLabel(c: SimCoin, cv: number): string {
  return cv >= 100 || c.lane === 'grad' ? 'GRADUATED' : fmtCurve(cv);
}

/** Build a card once. `index.html:1418` */
function card(c: SimCoin): HTMLElement {
  const b = document.createElement('div');
  b.className = 'coin';
  b.dataset['sym'] = c.sym;
  b.dataset['net'] = c.net ?? 'SOL';
  if (c.mint) b.dataset['mint'] = c.mint;
  b.setAttribute('role', 'button');
  b.tabIndex = 0;
  b.setAttribute('aria-label', c.sym + ' ' + c.name);
  const cv = curve(c);
  render(
    b,
    html`<canvas width="96" height="96" aria-hidden="true"></canvas>
      <div>
        <div class="cn">
          <b>${c.sym}</b><span class="nm" title="${attr(c.name)}">${c.name}</span
          ><span class="chg ${ud(c.chg)}" data-f="chg">${pct(c.chg)}</span>
        </div>
        <div class="cmeta">
          ${netPill(c.net ?? 'SOL')} by
          <i class="addrlink" data-addr="${attr(c.dev)}" title="${attr(c.dev)}"
            >${shortAddr(c.dev)}</i
          >
          ${DOT} <span data-f="age">${ago(c.age)}</span>
        </div>
        <p class="cdesc">${c.desc}</p>
        <div class="cstats">
          <span class="cv" data-f="cv">${curveLabel(c, cv)}</span
          ><span data-f="hold">HOLDERS ${num(c.hold)}</span
          ><span data-f="rep">REPLIES ${num(c.reps)}</span
          ><span class="mc" data-f="mc">${usd(c.mc)}</span>
        </div>
      </div>
      <i class="cbar" data-f="bar" style="width:${attr(cv)}%"></i>`,
  );
  REFS.set(b, refsOf(b));
  COIN_OF.set(b, c);
  const canvas = $<HTMLCanvasElement>('canvas', b);
  if (c.image && lazyArt) {
    paintCoinArt(canvas, c.seed, null, 52);
    lazyArt.observe(b);
  } else {
    paintCoinArt(canvas, c.seed, c.image, 52);
  }
  b.addEventListener('click', (e) => {
    // The creator link is a nested control; let the board delegate handle it.
    if ((e.target as Element | null)?.closest('.addrlink')) return;
    navigate({ view: 'token', sym: c.sym, ...(c.mint ? { mint: c.mint } : {}) });
  });
  b.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      navigate({ view: 'token', sym: c.sym, ...(c.mint ? { mint: c.mint } : {}) });
    }
  });
  c.el = b;
  return b;
}

/* ------------------------------ batched paint ----------------------------- */

const dirty = new Set<SimCoin>();
let paintFrame = 0;

/**
 * Patch a cached card in place — on the next animation frame, together with
 * every other card that moved since the last one. `index.html:1438`
 */
export function paint(c: SimCoin): void {
  if (!c.el) return;
  dirty.add(c);
  if (!paintFrame) paintFrame = requestAnimationFrame(flushPaint);
}

/** Paint everything that is waiting, now. Exposed for the tests and the lane moves. */
export function flushPaint(): void {
  if (paintFrame) {
    cancelAnimationFrame(paintFrame);
    paintFrame = 0;
  }
  if (dirty.size === 0) return;
  const flashes: Array<[HTMLElement, string, string]> = [];
  for (const c of dirty) {
    const e = c.el;
    const r = e ? REFS.get(e) : undefined;
    if (!e || !r) continue;
    const v = usd(c.mc);
    if (r.mc.textContent !== v) {
      r.mc.classList.remove('fu', 'fd');
      flashes.push([r.mc, c.mc >= c.lastMc ? 'fu' : 'fd', v]);
    }
    setText(r.chg, pct(c.chg));
    const cls = 'chg ' + ud(c.chg);
    if (r.chg.className !== cls) r.chg.className = cls;
    setText(r.rep, 'REPLIES ' + num(c.reps));
    setText(r.hold, 'HOLDERS ' + num(c.hold));
    const cv = curve(c);
    setText(r.cv, curveLabel(c, cv));
    const w = cv + '%';
    if (r.bar.style.width !== w) r.bar.style.width = w;
    setText(r.age, ago(c.age));
  }
  dirty.clear();
  if (flashes.length === 0) return;
  // One layout flush restarts every flash animation; per-card reflows would
  // cost a layout each on a busy tape.
  reflow(flashes[0]![0]);
  for (const [el, cls, v] of flashes) {
    el.classList.add(cls);
    el.textContent = v;
  }
}

function setText(el: HTMLElement, v: string): void {
  if (el.textContent !== v) el.textContent = v;
}

/* --------------------------------- filters -------------------------------- */

/** Build and place a coin that appeared after boot. `index.html:4074` */
export function addCoin(c: SimCoin): void {
  if (!c.el) card(c);
  landIn(c, (c.lane ?? 'new') as Lane);
  counts();
}

let filterFrame = 0;

/**
 * Hide cards that do not match the query.
 *
 * A filter, not a re-render: hiding is a `display` flip on the cached nodes so
 * the flash classes and scroll position survive. Coalesced to a frame so fast
 * typing walks the board once, not once per key. `index.html:4014`
 */
export function filterBoard(q: string): void {
  query = q;
  if (!LANES) return;
  if (!filterFrame)
    filterFrame = requestAnimationFrame(() => {
      filterFrame = 0;
      applyFilters();
    });
  writeUrl();
}

function matchesNet(c: SimCoin): boolean {
  return netFilter === 'ALL' || (c.net ?? 'SOL') === netFilter;
}

/** Text query and chain filter together; both are `display` flips. */
function applyFilters(): void {
  const v = query.trim().toUpperCase();
  let n = 0;
  const perLane: Record<Lane, number> = { new: 0, soon: 0, grad: 0 };
  for (const c of COINS) {
    const hit = matchesNet(c) && matchesQuery(c, v);
    if (c.el) c.el.style.display = hit ? '' : 'none';
    if (hit) {
      n++;
      if (c.lane) perLane[c.lane]++;
    }
  }
  const filtered = v !== '' || netFilter !== 'ALL';
  must('#count').textContent = n + (filtered ? ' MATCH' : ' COINS');
  if (EMPTY) {
    for (const k of Object.keys(perLane) as Lane[]) {
      const el = EMPTY[k];
      const empty = perLane[k] === 0;
      el.hidden = !empty;
      if (!empty) continue;
      const text = notice ?? (v !== '' ? 'NO MATCHES IN THIS LANE' : EMPTY_COPY[k]);
      el.classList.toggle('err', notice !== null);
      setText(el, text);
    }
  }
  if (moreBtn) moreBtn.hidden = !(api.boardHasMore?.() ?? false);
}

/**
 * Pin the board to one chain (or `ALL`). Called on connect with the wallet's
 * net and on disconnect with `ALL`; the chips call it directly for guests.
 */
export function setNetFilter(net: NetFilter): void {
  netFilter = net;
  renderNetChips();
  if (LANES) {
    applyFilters();
    king();
    writeUrl(true);
  }
}

export function currentNetFilter(): NetFilter {
  return netFilter;
}

/** The chains the NET strip offers: every one in sim, only deployed ones live. */
function nets(): Net[] {
  return visibleNets(ALL_NETS, (n) => api.mode !== 'live' || isDeployed(n));
}

/** `chains.json` arrived (or changed): hide chips for chains with nothing deployed. */
export function refreshNetChips(): void {
  if (netFilter !== 'ALL' && !nets().includes(netFilter)) {
    setNetFilter('ALL');
    return;
  }
  renderNetChips();
}

function renderNetChips(): void {
  const box = $('#netChips');
  if (!box) return;
  const chips: NetFilter[] = ['ALL', ...nets()];
  render(
    box,
    html`${chips.map((k) => {
      const info = k === 'ALL' ? null : NET_INFO[k];
      const on = k === netFilter;
      const locked = WALLET.on && k !== WALLET.net;
      return html`<button
        type="button"
        class="chip net${on ? ' on' : ''}"
        data-net="${attr(k)}"
        aria-pressed="${on ? 'true' : 'false'}"
        style="--nc:${attr(info ? info.col : '#cac6ba')}"
        title="${attr(
          k === 'ALL' ? 'EVERY CHAIN' : locked ? 'SWITCH YOUR WALLET TO ' + info!.name : info!.name,
        )}"
      >
        ${info ? html`<i></i>` : ''}${k === 'ALL' ? 'ALL' : info!.short}
      </button>`;
    })}`,
  );
}

export function counts(): void {
  const n: Record<Lane, number> = { new: 0, soon: 0, grad: 0 };
  for (const c of COINS) if (c.lane && matchesNet(c)) n[c.lane]++;
  must('#n-new').textContent = n.new + ' LIVE';
  must('#n-soon').textContent = n.soon + ' CLOSE';
  must('#n-grad').textContent = n.grad + ' ON DEX';
  // `#count` belongs to the filter: a lane event must not flip a filtered
  // "3 MATCH" back to the unfiltered total.
  applyFilters();
}

export function renderBoard(): void {
  for (const k of Object.keys(LANES) as Lane[]) clear(LANES[k]);
  for (const c of COINS) {
    // The server's lane is authoritative (a graduate stays graduated when its
    // cap dips); derive only when the coin never had one (sim seeds).
    if (!c.lane) c.lane = laneOf(c);
    if (!c.el) card(c);
  }
  const frag: Record<Lane, DocumentFragment> = {
    new: document.createDocumentFragment(),
    soon: document.createDocumentFragment(),
    grad: document.createDocumentFragment(),
  };
  for (const c of COINS.slice().sort(compareCoins(sortKey)))
    frag[c.lane as Lane].appendChild(c.el as HTMLElement);
  for (const k of Object.keys(LANES) as Lane[]) LANES[k].appendChild(frag[k]);
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
/** Net the crown was last painted for — reset on chain switch so a foreign king cannot stick. */
let kothNet: Net | 'ALL' | null = null;

/**
 * The connected chain crowns the hill; a guest's crown follows the chip
 * filter, and `ALL` crowns the biggest live curve across nets.
 */
function kothCandidates(net: Net | 'ALL'): SimCoin[] {
  return COINS.filter((c) => (net === 'ALL' || (c.net ?? 'SOL') === net) && c.lane !== 'grad');
}

export function king(): void {
  const net: Net | 'ALL' = WALLET.on ? WALLET.net : netFilter;
  if (kothNet !== net) {
    kothId = null;
    kothNet = net;
  }

  let best: SimCoin | null = null;
  for (const c of kothCandidates(net)) if (!best || c.mc > best.mc) best = c;

  const koth = must('#koth');
  koth.dataset['net'] = net;

  if (!best) {
    kothId = null;
    delete koth.dataset['sym'];
    delete koth.dataset['mint'];
    render(
      koth,
      html`<span class="crown">KING OF THE HILL</span>
        <div>
          <div class="kn">NO KING YET</div>
          <p>
            ${
              notice ??
              (net === 'ALL'
                ? 'No live curve tokens yet. The first launch takes the hill.'
                : 'No live curve tokens on ' + NET_INFO[net].name + ' yet.')
            }
          </p>
        </div>`,
    );
    return;
  }

  if (best.id !== kothId) {
    const first = kothId === null;
    kothId = best.id;
    koth.dataset['sym'] = best.sym;
    if (best.mint) koth.dataset['mint'] = best.mint;
    else delete koth.dataset['mint'];
    render(
      koth,
      html`<span class="crown">KING OF THE HILL</span
        ><canvas width="128" height="128" style="width:74px;height:74px"></canvas>
        <div>
          <div class="kn">${best.sym}<small>${best.name}</small> ${netPill(best.net ?? 'SOL')}</div>
          <p>${best.desc}</p>
          <div class="kstats">
            <span
              ><span class="lbl">MARKET CAP</span><b class="am" id="k-mc">${usd(best.mc)}</b></span
            ><span
              ><span class="lbl">24H</span
              ><b class="${ud(best.chg)}" id="k-chg">${pct(best.chg)}</b></span
            ><span><span class="lbl">CURVE</span><b id="k-cv">${fmtCurve(curve(best))}</b></span
            ><span><span class="lbl">HOLDERS</span><b id="k-hold">${num(best.hold)}</b></span
            ><span><span class="lbl">CREATED</span><b id="k-age">${ago(best.age)}</b></span>
          </div>
        </div>
        <canvas class="ksp" width="300" height="88"></canvas>`,
    );
    paintCoinArt($<HTMLCanvasElement>('#koth canvas'), best.seed, best.image, 74);
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
    if (mc) setText(mc, usd(best.mc));
    const ce = $('#k-chg');
    if (ce) {
      setText(ce, pct(best.chg));
      if (ce.className !== ud(best.chg)) ce.className = ud(best.chg);
    }
    const cv = $('#k-cv');
    if (cv) setText(cv, fmtCurve(curve(best)));
    const hold = $('#k-hold');
    if (hold) setText(hold, num(best.hold));
    const age = $('#k-age');
    if (age) setText(age, ago(best.age));
  }
}

/* ------------------------------ keyboard --------------------------------- */

function visibleCards(): HTMLElement[] {
  return $$<HTMLElement>('.board .coin').filter((el) => el.style.display !== 'none');
}

/** ArrowDown out of the FIND box lands on the first card the filter left visible. */
export function focusFirstCard(): boolean {
  const first = visibleCards()[0];
  if (!first) return false;
  first.focus();
  return true;
}

function onBoardKey(e: KeyboardEvent): void {
  const from = (e.target as Element | null)?.closest<HTMLElement>('.coin');
  if (!from) return;
  const cards = visibleCards();
  const i = cards.indexOf(from);
  let to: HTMLElement | undefined;
  if (e.key === 'ArrowDown') to = cards[i + 1];
  else if (e.key === 'ArrowUp') to = i > 0 ? cards[i - 1] : undefined;
  else if (e.key === 'Home') to = cards[0];
  else if (e.key === 'End') to = cards[cards.length - 1];
  else return;
  e.preventDefault();
  if (e.key === 'ArrowUp' && i === 0) {
    $<HTMLInputElement>('#q')?.focus();
    return;
  }
  to?.focus();
}

/* -------------------------------- load more ------------------------------- */

async function loadMore(): Promise<void> {
  if (!moreBtn || !api.loadMore) return;
  const btn = moreBtn;
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'LOADING…';
  try {
    const { added, more } = await api.loadMore();
    if (added === 0) toast('NO OLDER COINS ON THIS CHAIN');
    btn.hidden = !more;
  } catch {
    toast('COULD NOT LOAD MORE ' + DOT + ' TRY AGAIN', 'red');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

/* -------------------------------- wiring ---------------------------------- */

export function initBoard(): void {
  LANES = {
    new: must('#lane-new'),
    soon: must('#lane-soon'),
    grad: must('#lane-grad'),
  };
  EMPTY = {
    new: emptyNode(LANES.new),
    soon: emptyNode(LANES.soon),
    grad: emptyNode(LANES.grad),
  };
  const board = must('.board');
  moreBtn = document.createElement('button');
  moreBtn.type = 'button';
  moreBtn.className = 'board-more';
  moreBtn.textContent = 'LOAD OLDER COINS';
  moreBtn.hidden = true;
  moreBtn.addEventListener('click', () => void loadMore());
  board.insertAdjacentElement('afterend', moreBtn);

  // `ready()` may already have failed before anyone listened for `notice`.
  notice = api.apiNotice?.() ?? null;
  readUrl();
  renderBoard();
  king();

  for (const chip of $$('.filters .chip[data-sort]')) {
    chip.addEventListener('click', () => {
      sortKey = (chip.dataset['sort'] as SortKey) ?? 'new';
      for (const other of $$('.filters .chip[data-sort]'))
        other.classList.toggle('on', other === chip);
      renderBoard();
      writeUrl(true);
    });
  }
  renderNetChips();
  must('#netChips').addEventListener('click', (e) => {
    const chip = (e.target as Element | null)?.closest<HTMLElement>('[data-net]');
    if (!chip) return;
    const k = chip.dataset['net'] as NetFilter;
    if (WALLET.on && k !== WALLET.net) {
      // A connected wallet only ever sees its own chain; another chip is a
      // request to move the wallet there, not a filter.
      if (k === 'ALL') {
        toast(
          'DISCONNECT TO BROWSE EVERY CHAIN ' +
            DOT +
            ' YOUR WALLET PINS THE BOARD TO ' +
            NET_INFO[WALLET.net].name,
        );
        return;
      }
      switchNet?.(k);
      return;
    }
    setNetFilter(k);
    if (k !== 'ALL')
      toast('SHOWING ' + NET_INFO[k].name + ' COINS ' + DOT + ' TAP ALL FOR EVERY CHAIN');
  });

  // BACK onto a filtered board restores its chips and query from the URL.
  window.addEventListener('popstate', () => {
    if (location.pathname !== '/') return;
    readUrl();
    renderBoard();
    king();
  });

  // The API came back (or went away): the empty lanes say which.
  on('notice', ({ text }) => {
    notice = text;
    applyFilters();
    king();
  });

  // One delegated listener for every creator link on the board.
  board.addEventListener('click', (e) => {
    const link = (e.target as Element | null)?.closest<HTMLElement>('.addrlink');
    if (!link) return;
    e.stopPropagation();
    navigate({ view: 'profile', addr: link.dataset['addr'] as string });
  });
  board.addEventListener('keydown', onBoardKey);

  // The filter strip sticks under the header on wide screens; the header's
  // height varies with what is in it, so the offset is measured, not guessed.
  const top = $('.top');
  if (top && typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => {
      document.documentElement.style.setProperty('--top-h', top.offsetHeight + 'px');
    });
    ro.observe(top);
  }

  // The crown opens the current king's chart — same click-to-token contract
  // as a card, just for the one coin the board is already pointing at.
  const koth = must('#koth');
  koth.setAttribute('role', 'button');
  koth.tabIndex = 0;
  const openKing = (e: Event): void => {
    if ((e.target as Element | null)?.closest('.addrlink')) return;
    const sym = koth.dataset['sym'];
    const mint = koth.dataset['mint'];
    if (sym) navigate({ view: 'token', sym, ...(mint ? { mint } : {}) });
  };
  koth.addEventListener('click', openKing);
  koth.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter' || (e as KeyboardEvent).key === ' ') {
      e.preventDefault();
      openKing(e);
    }
  });
}

/** The "nothing here" line under a lane's cards; hidden while the lane has any. */
function emptyNode(laneBody: HTMLElement): HTMLElement {
  const p = document.createElement('p');
  p.className = 'lane-empty';
  p.hidden = true;
  p.setAttribute('aria-live', 'polite');
  laneBody.insertAdjacentElement('afterend', p);
  return p;
}
