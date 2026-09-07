import {
  CB_MS,
  GRAD,
  SUPPLY,
  type Quote,
  type QuoteHop,
  ago,
  cbLeft,
  curve,
  effFee,
  hash,
  inCashback,
  laneOf,
  liq,
  num,
  pct,
  price,
  px,
  rng,
  usd,
  vol24,
} from '@stonkz/shared';
import { api } from '../api/index.js';
import { navigate, retitle } from '../app/route.js';
import { SignerCancelledError } from '../app/signer.js';
import { describeWalletError, isRejection } from '../wallet/index.js';
import { showView } from '../app/view.js';
import { drawTokenChart } from '../canvas/chart.js';
import { pix } from '../canvas/pix.js';
import { burst } from '../fx/debris.js';
import { toast } from '../fx/toast.js';
import { $, $$, clear, must, reflow } from '../lib/dom.js';
import { ARR, DOT, MID, clockSec, fmtSupply, ud } from '../lib/fmt.js';
import { type Html, attr, html, raw, render } from '../lib/html.js';
import { copyText } from '../lib/clipboard.js';
import { reducedMotion } from '../lib/motion.js';
import { canHover } from '../lib/pointer.js';
import { type SimCoin, holdersOf, seedComments, seedSeries, seedTrades } from '../state/coins.js';
import { holdOf } from '../state/holdings.js';
import { SET } from '../state/settings.js';
import { NATIVE_PRICE, WALLET, nativeUnit } from '../state/wallet.js';
import { openStake } from '../modals/stake.js';
import { setChatToken, roomOf, addChat } from './chat.js';
import { paint } from './board.js';

/**
 * The token page.
 *
 * Rebuilt from a string on open, then patched by `syncToken()` on every beat —
 * the same split the board uses, for the same reason.
 * `index.html:1677`
 */

export interface TokenViewState {
  c: SimCoin | null;
  tab: 'trades' | 'holders' | 'comments';
  side: 'BUY' | 'SELL';
  range: number;
  cross: number | null;
  qTimer: number;
  /** Drops stale quotes when the live adapter answers out of order. */
  qSeq: number;
}

export const TV: TokenViewState = { c: null, tab: 'trades', side: 'BUY', range: 90, cross: null, qTimer: 0, qSeq: 0 };

/* ------------------------------- markup ----------------------------------- */

function tokenHTML(c: SimCoin): Html {
  const grad = c.lane === 'grad';
  const unit = nativeUnit();
  const pair = c.base || unit;
  return html`<div class="tk-bar">
      <button class="back" id="tk-back">${ARR} BOARD</button
      ><canvas width="128" height="128" aria-hidden="true"></canvas
      ><div class="tk-id"><h1>${c.sym}<small>${c.name}</small></h1
        ><div class="sub">${c.base
          ? html`PAIR <b>${c.sym}/${c.base}</b> ${DOT} SUPPLY <b>${fmtSupply(c.supply || SUPPLY)}</b> ${DOT} FEE
            <b>${Number(c.tfee).toFixed(1)}%</b> ${DOT} `
          : ''}CA <b>${c.dev.toLowerCase()}stkz</b> ${DOT} DEV
          <b class="addrlink" data-addr="${attr(c.dev)}">${c.dev}</b> ${DOT} ${ago(c.age)} ${DOT}
          <span class="${grad ? 'gd' : 'up'}" id="s-state">${grad ? 'BONDED' : 'ACTIVE'}</span></div></div
      ><div class="tk-stats">
        <div><span class="lbl">PRICE</span><span class="v" id="s-px">${px(price(c))}</span></div
        ><div><span class="lbl">MARKET CAP</span><span class="v am" id="s-mc">${usd(c.mc)}</span></div
        ><div><span class="lbl">24H</span><span class="v ${ud(c.chg)}" id="s-chg">${pct(c.chg)}</span></div
        ><div><span class="lbl">VOL 24H</span><span class="v" id="s-vol">${usd(vol24(c))}</span></div
        ><div><span class="lbl">LIQUIDITY</span><span class="v" id="s-liq">${usd(liq(c))}</span></div
        ><div><span class="lbl">HOLDERS</span><span class="v" id="s-hold">${num(c.hold)}</span></div>
      </div>
      <button class="back" id="tk-share" title="Copy link">SHARE</button>
      <button class="stakebtn" id="tk-stake">STAKE</button>
    </div>
    <div id="cbWrap">${cbBannerHTML(c)}</div>

    <div class="tk-grid">
      <section class="pnl">
        <div class="pnl-hd"><h2>Price</h2><span class="sub">${c.sym}/${pair} ${DOT} MARKET CAP SCALE</span>
          <div class="rt"><button class="tab" data-rg="45">15M</button><button class="tab on" data-rg="90">1H</button
            ><button class="tab" data-rg="140">6H</button><button class="tab" data-rg="200">ALL</button></div>
        </div>
        <div class="chartbox"><canvas id="tchart"></canvas><div class="hud" id="ch-hud"></div></div>
        <div class="curvebar">
          <div class="pt"><span>BONDING CURVE</span><b class="am" id="cv-pct">${curve(c).toFixed(1)}%</b></div>
          <div class="ptrack"><i id="cv-bar" class="${grad ? 'done' : ''}" style="width:${attr(curve(c))}%"></i></div>
          <div class="note" id="cv-note"></div>
        </div>
      </section>

      <section class="pnl" id="tradePnl">
        <div class="pnl-hd"><h2>Trade</h2><span class="sub">MARKET ${DOT} ${api.mode === 'live' ? 'LIVE CURVE' : 'SIMULATED'}</span></div>
        <div class="pnl-bd">
          <div class="seg" id="t-side"><button type="button" data-s="BUY" class="on">BUY</button
            ><button type="button" data-s="SELL">SELL</button></div>
          <div><span class="lbl" id="t-amt-lbl">AMOUNT (${unit})</span
            ><input class="fld" id="t-amt" value="${Number(SET.defBuy).toFixed(2)}" inputmode="decimal"></div>
          <div class="amt-row" id="t-quick"></div>
          <div class="quote" id="t-quote"></div>
          <button class="big" id="t-go">BUY ${c.sym}</button>
          <div class="bal" id="t-bal"></div>
          <div class="pos" id="t-pos" hidden></div>
          <p class="hint">${
            api.mode === 'live'
              ? 'QUOTES AND ORDERS HIT THE REAL API. SIGNING USES A LOCAL PRACTICE KEY, NOT A BROADCAST TO A LIVE CHAIN.'
              : 'ORDERS ARE SIMULATED. NOTHING IS SIGNED, SENT OR SETTLED.'
          }</p>
        </div>
      </section>

      <section class="pnl">
        <div class="pnl-hd"><h2>Activity</h2>
          <div class="rt tabs"><button class="tab on" data-tab="trades">RECENT TRADES</button
            ><button class="tab" data-tab="holders">HOLDERS</button
            ><button class="tab" data-tab="comments">COMMENTS</button></div>
        </div>
        <div id="tabbody"></div>
      </section>

      <section class="pnl">
        <div class="pnl-hd"><h2>X Stream</h2><span class="sub">SIMULATED FEED</span></div>
        <div class="pnl-bd">
          <form class="xhandle" id="xform"><input class="fld" id="xin" value="${attr(c.x ?? '')}" maxlength="20"
            aria-label="X account"><button class="send" type="submit">LOAD</button></form>
          <div id="xfeed"></div>
          <p class="xnote">POSTS RENDER IN TERMINAL STYLE ${DOT} NO X ACCOUNT IS CONTACTED IN THIS MOCK.</p>
        </div>
      </section>
    </div>`;
}

/* -------------------------------- chart ----------------------------------- */

export function drawTChart(): void {
  const c = TV.c;
  if (!c) return;
  // Live mode hydrates `c.h`/`c.hv` from real candles in `api.watchToken()`;
  // `seedSeries` is the sim-only synthetic fallback and must not overwrite
  // that with a random walk while the fetch is still in flight. `plan step 63`
  if (api.mode === 'sim') seedSeries(c);
  if (!c.h || !c.hv || c.h.length < 2) return;
  const hud = drawTokenChart($<HTMLCanvasElement>('#tchart'), {
    series: c.h as number[],
    volume: c.hv as number[],
    range: TV.range,
    cross: TV.cross,
    coin: c,
  });
  if (hud) render($('#ch-hud'), hud);
}

/* -------------------------------- quote ----------------------------------- */

/** How a venue reads in the route line. `index.html:1826` */
const VENUE_NAME: Record<string, string> = {
  CURVE: 'STONKZ CURVE',
  RAYDIUM: 'RAY V4',
  JUPITER: 'JUP',
  UNISWAP: 'UNI V4',
};

const venueName = (v: string): string => VENUE_NAME[v] ?? v;

/**
 * One route leg, rendered only when the route actually has two.
 *
 * A coin paired against the native unit is a single curve hop and the ROUTE row
 * already says so. A coin paired against USDC or AAPLx routes native -> base ->
 * token, and the aggregator leg has to be visible because Stonkz charges
 * nothing on it — that is the invariant Phase 2.R has to keep. `plan step 22`
 */
function hopRow(h: QuoteHop, i: number): Html {
  const fee = h.feeBps ? (h.feeBps / 100).toFixed(1) + '%' : 'NO FEE';
  return html`<div class="qrow"><span>HOP ${i + 1} ${DOT} ${venueName(h.venue)}</span
    ><b>${h.inSymbol} ${'\u203A'} ${h.outSymbol} ${DOT} <span class="dm">${fee}</span></b></div>`;
}

function quoteHTML(c: SimCoin, q: Quote): Html {
  const buy = q.side === 'buy';
  const slip = Number(SET.slip);
  const feeNative = q.hops.reduce((n, h) => n + h.feeAmount, 0);
  const impact = q.impactPct;
  const hops = q.hops.length > 1 ? q.hops.map((h, i) => hopRow(h, i)) : '';
  return html`<div class="qrow hero"><span>${buy ? 'YOU RECEIVE' : 'YOU SELL'}</span
      ><b>${num(buy ? q.amountOut : (q.hops[0] as QuoteHop).inAmount)} ${c.sym}</b></div
    ><div class="qrow"><span>${buy ? 'YOU PAY' : 'YOU GET'}</span
      ><b>${(buy ? q.amountIn : q.amountOut).toFixed(2)} ${c.base || q.nativeUnit}</b></div
    ><div class="qrow"><span>PRICE</span><b>${px(price(c))}</b></div
    >${hops}<div class="qrow"><span>PRICE IMPACT</span
      ><b class="${impact < 2 ? 'up' : impact < 8 ? 'am' : 'dn'}">${impact.toFixed(2)}%</b></div
    ><div class="qrow"><span>SLIPPAGE / FEE</span
      ><b>${slip.toFixed(1)}% ${DOT} ${feeNative.toFixed(4)} ${q.nativeUnit}</b></div
    ><div class="qrow"><span>NETWORK</span><b>PRIO ${Number(SET.prio).toFixed(4)} ${DOT} MEV
      ${SET.mev === 'OFF' ? 'OFF' : Number(SET.mevTip).toFixed(4) + ' ' + SET.mev}</b></div
    ><div class="qrow"><span>MIN RECEIVED</span><b>${num(q.minOut)}</b></div
    ><div class="qrow"><span>ROUTE</span><b>${q.hops.map((h) => venueName(h.venue)).join(' \u203A ')}</b></div
    ><div class="qfoot"><span>QUOTE</span><span class="qbar"><i id="qbar-i"></i></span><span>8S</span></div>`;
}

export function renderQuote(): void {
  const c = TV.c;
  if (!c) return;
  const amount = parseFloat(($('#t-amt') as HTMLInputElement | null)?.value ?? '') || 0;
  const buy = TV.side === 'BUY';
  const seq = ++TV.qSeq;
  void api
    .quote({ coin: c, side: buy ? 'buy' : 'sell', amountIn: amount })
    .then((q) => {
      if (seq !== TV.qSeq || TV.c !== c) return;
      render($('#t-quote'), quoteHTML(c, q));
      const bar = $('#qbar-i');
      if (bar && !reducedMotion()) {
        bar.classList.remove('run');
        reflow(bar);
        bar.classList.add('run');
      }
    })
    .catch((err: unknown) => {
      // The live adapter throws until Phase 2.R. Say so instead of showing
      // a stale route.
      render($('#t-quote'), html`<div class="qrow"><span>QUOTE</span><b class="dn">${String(err)}</b></div>`);
    });

  const go = $('#t-go');
  if (go) {
    go.textContent = TV.side + ' ' + c.sym;
    go.className = 'big' + (buy ? '' : ' sell');
  }
  const lbl = $('#t-amt-lbl');
  if (lbl) lbl.textContent = buy ? 'AMOUNT (' + nativeUnit() + ')' : 'AMOUNT (' + nativeUnit() + ' EQUIVALENT)';
  syncPosition(c);
}

function syncPosition(c: SimCoin): void {
  const pe = $('#t-pos');
  if (!pe) return;
  const hp = holdOf(c.sym);
  if (hp && hp.tok > 0.5) {
    const pv = hp.tok * price(c);
    const ppl = (pv / Math.max(1e-9, hp.cost) - 1) * 100;
    render(
      pe,
      html`<span>YOUR POSITION <b>${num(hp.tok)} ${c.sym}</b></span
        ><span><b>${usd(pv)}</b> <b class="${ud(ppl)}">${pct(ppl)}</b></span>`,
    );
    pe.hidden = false;
  } else {
    pe.hidden = true;
  }
  const bal = $('#t-bal');
  if (bal) {
    render(
      bal,
      WALLET.on
        ? html`<span>BALANCE <b class="am">${WALLET.sol.toFixed(2)} ${nativeUnit()}</b></span
            ><span>PAIR ${c.base || nativeUnit()} ${DOT} ${WALLET.addr}</span>`
        : html`<span class="dm">NO WALLET CONNECTED</span><span class="dm">SIM FILLS ONLY</span>`,
    );
  }
}

/* --------------------------------- tabs ----------------------------------- */

function tradesHTML(c: SimCoin): Html {
  const trades = c.trades ?? [];
  return html`<div class="scrolly"><table class="tbl"><thead><tr><th scope="col">TIME</th><th scope="col">TYPE</th
    ><th scope="col" class="r">${nativeUnit()}</th><th scope="col" class="r">TOKENS</th
    ><th scope="col" class="r">MCAP</th><th scope="col">TRADER</th><th scope="col">VEN</th></tr></thead><tbody
    >${trades.map(
      (t, i) => html`<tr${raw(t.fresh && i === 0 ? ' class="newrow"' : '')}><td class="dm">${clockSec(t.t)}</td
        ><td class="${t.buy ? 'up' : 'dn'}">${t.buy ? 'BUY' : 'SELL'}</td><td class="r">${t.sol.toFixed(2)}</td
        ><td class="r">${num(t.tok)}</td><td class="r">${usd(t.mc)}</td><td class="${t.cb ? '' : 'bl'}"
        >${t.cb
          ? html`<span class="tag cb">CASHBACK</span>`
          : html`<span class="addrlink" data-addr="${attr(t.w)}">${t.w}</span>`}</td
        ><td class="dm">${t.v}</td></tr>`,
    )}</tbody></table></div>`;
}

function holdersHTML(c: SimCoin): Html {
  // Live mode fetches real holders in `api.watchToken()`; `holdersOf` is the
  // sim-only synthetic generator and is only reached if that fetch hasn't
  // landed yet. `plan step 64`
  const rows = c.liveHolders ?? holdersOf(c);
  return html`<div class="scrolly"><table class="tbl"><thead><tr><th scope="col">#</th><th scope="col">WALLET</th
    ><th scope="col" class="r">HOLDING</th><th scope="col" class="r">VALUE</th><th scope="col">TAG</th></tr></thead
    ><tbody>${rows.map(
      (h, i) => html`<tr><td class="dm">${i + 1}</td><td class="${h.curve ? 'am' : 'bl'}"
        >${h.curve ? h.w : html`<span class="addrlink" data-addr="${attr(h.w)}">${h.w}</span>`}</td
        ><td class="r">${h.p.toFixed(2)}%</td><td class="r">${usd((c.mc * h.p) / 100)}</td><td
        >${h.tag ? html`<span class="tag ${h.tag[1]}">${h.tag[0]}</span>` : html`<span class="dm">${MID}</span>`}</td></tr>`,
    )}</tbody></table></div>`;
}

function commentsHTML(c: SimCoin): Html {
  const list = c.comments ?? [];
  return html`<div class="pnl-bd"><div class="scrolly" style="display:flex;flex-direction:column;gap:7px" id="cmt-list"
    >${list.map(
      (m) => html`<div class="cmt${m.mine ? ' mine' : ''}"><div class="who"
        >${m.mine ? 'YOU' : html`<span class="addrlink" data-addr="${attr(m.who)}">${m.who}</span>`}<span>${m.t}</span></div
        ><p>${m.text}</p></div>`,
    )}</div
    ><form class="inline-form" id="cmt-form"><input class="fld" id="cmt-in" maxlength="140" placeholder="POST A REPLY"
      aria-label="Comment"><button class="send" type="submit">POST</button></form></div>`;
}

export function renderTab(): void {
  const c = TV.c;
  const b = $('#tabbody');
  if (!c || !b) return;
  render(b, TV.tab === 'trades' ? tradesHTML(c) : TV.tab === 'holders' ? holdersHTML(c) : commentsHTML(c));
  if (TV.tab === 'comments') {
    $('#cmt-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('#cmt-in') as HTMLInputElement | null;
      const v = input?.value.trim();
      if (!input || !v) return;
      seedComments(c);
      c.comments?.push({ who: 'YOU', t: 'now', text: v, mine: true });
      c.reps++;
      paint(c);
      input.value = '';
      renderTab();
      const l = $('#cmt-list');
      if (l) l.scrollTop = l.scrollHeight;
    });
  }
}

/* -------------------------------- X feed ---------------------------------- */

const XLINES = [
  'we are not a company, we are a candle. $SYM',
  '$SYM holders check in. how many of you are still here from the first hour',
  'chart update: it went up. that is the entire update',
  'the curve does not care about your feelings and neither does the dev',
  'someone just bought $SYM with what i can only assume is rent money. respect',
  'liquidity burns on graduation. no take backs, no multisig, no excuses',
  'every $SYM chart looks like a heart monitor and today it is beating',
  'reminder that this is barely advice, let alone financial advice',
];

export function renderX(handle: string): void {
  const c = TV.c;
  if (!c) return;
  const r = rng(hash(handle.toLowerCase()) ^ c.seed);
  const feed = $('#xfeed');
  if (!feed) return;
  const used: Record<number, 1> = {};
  const posts: Html[] = [];
  for (let i = 0; i < 4; i++) {
    let k: number;
    do {
      k = (r() * XLINES.length) | 0;
    } while (used[k] && Object.keys(used).length < XLINES.length);
    used[k] = 1;
    const txt = (XLINES[k] as string).replace(/\$SYM/g, '$' + c.sym);
    posts.push(
      html`<div class="xpost"><canvas width="64" height="64" data-s="${attr((r() * 1e6) | 0)}"></canvas
        ><div><div class="xh"><b>${c.name}</b><span>${handle}</span><span>${DOT} ${(i + 1) * 3 + ((r() * 9) | 0)}h</span></div
          ><p>${txt}</p
          ><div class="xmeta"><span>REPLY <b>${(r() * 90) | 0}</b></span><span>REPOST <b>${(r() * 240) | 0}</b></span
            ><span>LIKE <b>${(r() * 1400) | 0}</b></span></div></div></div>`,
    );
  }
  render(feed, html`${posts}`);
  feed.querySelectorAll<HTMLCanvasElement>('canvas').forEach((cv) => pix(cv, Number(cv.dataset['s'])));
}

/* ------------------------------ cashback ---------------------------------- */

function cbBannerHTML(c: SimCoin): Html {
  if (!inCashback(c)) return html``;
  const left = cbLeft(c);
  const frac = left / CB_MS;
  return html`<div class="cb-banner"><span class="cbl">CASHBACK LIVE</span
    ><span class="cbv" id="cb-fee">${effFee(c).toFixed(1)}%</span
    ><span class="hint">FEE DECAYING TO ${Number(c.tfee).toFixed(1)}%</span
    ><span class="cbtrack"><i id="cb-bar" style="width:${attr((frac * 100).toFixed(1))}%"></i></span
    ><span class="cbv" id="cb-left">${Math.ceil(left / 1000)}S</span
    ><span class="hint">FEES BUY ${c.sym} FOR THE CREATOR</span></div>`;
}

function syncCashback(): void {
  const c = TV.c;
  if (!c) return;
  const wrap = $('#cbWrap');
  if (!wrap) return;
  if (!inCashback(c)) {
    clear(wrap);
    return;
  }
  if (!wrap.firstElementChild) {
    render(wrap, cbBannerHTML(c));
    return;
  }
  const left = cbLeft(c);
  const f = $('#cb-fee');
  const b = $('#cb-bar');
  const l = $('#cb-left');
  if (f) f.textContent = effFee(c).toFixed(1) + '%';
  if (b) b.style.width = ((left / CB_MS) * 100).toFixed(1) + '%';
  if (l) l.textContent = Math.ceil(left / 1000) + 'S';
}

function updateCurveNote(): void {
  const c = TV.c;
  if (!c) return;
  const n = $('#cv-note');
  if (!n) return;
  if (c.lane === 'grad') {
    n.textContent = 'GRADUATED ' + MID + ' LIQUIDITY MIGRATED TO THE DEX AND LP TOKENS WERE BURNED.';
  } else {
    render(
      n,
      html`AT ${usd(GRAD)} MARKET CAP THE CURVE FILLS, LIQUIDITY MIGRATES AND THE LP BURNS.
        <b class="am">${usd(Math.max(0, GRAD - c.mc))}</b> TO GO.`,
    );
  }
}

/** Patch the header stats without rebuilding the page. `index.html:2052` */
export function syncToken(): void {
  const c = TV.c;
  if (!c || must('#tokenView').hidden) return;
  const set = (id: string, val: string, cls?: string): void => {
    const e = $(id);
    if (!e) return;
    if (e.textContent !== val) e.textContent = val;
    if (cls) e.className = 'v ' + cls;
  };
  set('#s-px', px(price(c)));
  const mcEl = $('#s-mc');
  const v = usd(c.mc);
  if (mcEl && mcEl.textContent !== v) {
    mcEl.classList.remove('fu', 'fd');
    reflow(mcEl);
    mcEl.classList.add(c.mc >= c.lastMc ? 'fu' : 'fd');
    mcEl.textContent = v;
  }
  set('#s-chg', pct(c.chg), ud(c.chg));
  set('#s-vol', usd(vol24(c)));
  set('#s-liq', usd(liq(c)));
  set('#s-hold', num(c.hold));
  const st = $('#s-state');
  if (st) {
    st.textContent = c.lane === 'grad' ? 'BONDED' : 'ACTIVE';
    st.className = c.lane === 'grad' ? 'gd' : 'up';
  }
  syncCashback();
  const p = $('#cv-pct');
  const b = $('#cv-bar');
  if (p) p.textContent = curve(c).toFixed(1) + '%';
  if (b) {
    b.style.width = curve(c) + '%';
    b.className = c.lane === 'grad' ? 'done' : '';
  }
  updateCurveNote();
  retitle();
}

/* --------------------------------- open ----------------------------------- */

export function openToken(c: SimCoin): void {
  if (api.mode === 'sim') {
    seedSeries(c);
    seedTrades(c);
  } else {
    // Live: candles/trades/holders come from REST and the `token:{sym}` WS
    // channel (`api.watchToken()`); render below with whatever is cached (if
    // anything), then repaint once the fetch lands. `plan step 63`, `plan step 64`
    void api.watchToken(c).then(() => {
      if (TV.c !== c) return; // navigated away before the fetch landed
      drawTChart();
      if (TV.tab !== 'comments') renderTab();
    });
  }
  // Comments/X feed stay simulated in both modes — the plan's live scope is
  // candles/trades/holders/tape/koth, not social features.
  seedComments(c);
  c.lane = laneOf(c);
  TV.c = c;
  TV.tab = 'trades';
  TV.side = 'BUY';
  TV.range = 90;
  TV.cross = null;
  const v = must('#tokenView');
  render(v, tokenHTML(c));
  showView('token');
  pix($<HTMLCanvasElement>('.tk-bar canvas'), c.seed);
  updateCurveNote();
  render(
    must('#t-quick'),
    html`${[0.1, 0.5, 1, 5].map((x) => html`<button type="button" class="qa" data-a="${attr(x)}">${x}</button>`)}<button
      type="button" class="qa" data-a="max">MAX</button>`,
  );
  renderTab();
  renderX(c.x ?? '@' + c.sym.toLowerCase());
  renderQuote();

  const cvs = must<HTMLCanvasElement>('#tchart');
  if (canHover()) {
    // A crosshair needs a pointer that can rest somewhere without committing.
    // On touch the chart is read-only and the range chips do the work.
    cvs.addEventListener('mousemove', (e) => {
      TV.cross = e.clientX - cvs.getBoundingClientRect().left;
      drawTChart();
    });
    cvs.addEventListener('mouseleave', () => {
      TV.cross = null;
      drawTChart();
    });
  }
  must('#tk-back').addEventListener('click', () => navigate({ view: 'board' }));
  must('#tk-stake').addEventListener('click', () => openStake(c));
  must('#tk-share').addEventListener('click', () => {
    // The canonical link, not this origin: a share from a preview build should
    // still point at production. `plan step 31`
    const link = 'https://ston.kz/t/' + c.sym;
    copyText(link, (ok) => toast(ok ? 'LINK COPIED ' + DOT + ' ' + link : 'COPY BLOCKED ' + DOT + ' ' + link, ok ? 'gold' : 'red'));
  });
  must('#t-side').addEventListener('click', (e) => {
    const b = (e.target as Element | null)?.closest<HTMLElement>('[data-s]');
    if (!b) return;
    TV.side = b.dataset['s'] as 'BUY' | 'SELL';
    for (const x of Array.from(must('#t-side').children)) x.classList.toggle('on', x === b);
    renderQuote();
  });
  must('#t-quick').addEventListener('click', (e) => {
    const b = (e.target as Element | null)?.closest<HTMLElement>('[data-a]');
    if (!b) return;
    const amt = must<HTMLInputElement>('#t-amt');
    amt.value = b.dataset['a'] === 'max' ? WALLET.sol.toFixed(2) : Number(b.dataset['a']).toFixed(2);
    renderQuote();
  });
  must('#t-amt').addEventListener('input', renderQuote);
  must('#t-go').addEventListener('click', () => void submitTrade(c));

  for (const b of $$('[data-rg]')) {
    b.addEventListener('click', () => {
      TV.range = Number(b.dataset['rg']);
      for (const x of $$('[data-rg]')) x.classList.toggle('on', x === b);
      drawTChart();
    });
  }
  for (const b of $$('[data-tab]')) {
    b.addEventListener('click', () => {
      TV.tab = b.dataset['tab'] as TokenViewState['tab'];
      for (const x of $$('[data-tab]')) x.classList.toggle('on', x === b);
      renderTab();
    });
  }
  must('#xform').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = must<HTMLInputElement>('#xin');
    let h = input.value.trim() || c.x || '';
    if (h[0] !== '@') h = '@' + h.replace(/^@+/, '');
    c.x = h;
    input.value = h;
    renderX(h);
    toast('LOADED ' + h + ' ' + DOT + ' SIMULATED POSTS');
  });
  // One delegated listener for every address link on the page.
  v.addEventListener('click', (e) => {
    const link = (e.target as Element | null)?.closest<HTMLElement>('.addrlink');
    if (!link) return;
    navigate({ view: 'profile', addr: link.dataset['addr'] as string });
  });

  clearInterval(TV.qTimer);
  TV.qTimer = window.setInterval(() => {
    if (TV.c) renderQuote();
  }, 8000);
  window.scrollTo(0, 0);
  setChatToken(c);
  requestAnimationFrame(drawTChart);
  setTimeout(drawTChart, 60);
}

async function submitTrade(c: SimCoin): Promise<void> {
  const amount = parseFloat(must<HTMLInputElement>('#t-amt').value) || 0;
  if (amount <= 0) return;
  const buy = TV.side === 'BUY';
  const hb = holdOf(c.sym);
  let realized: number | null = null;
  if (!buy && hb && hb.tok > 0) {
    const avg = hb.cost / hb.tok;
    const sold = Math.min(hb.tok, (amount * NATIVE_PRICE.usd) / price(c));
    realized = sold * (price(c) - avg);
  }

  const go = must<HTMLButtonElement>('#t-go');
  const restoreLabel = go.textContent ?? '';
  go.disabled = true;
  go.textContent = 'SIGN IN WALLET\u2026';
  try {
    const q = await api.quote({ coin: c, side: buy ? 'buy' : 'sell', amountIn: amount });
    // The fill only renders below once this resolves — a real confirmed
    // Solana signature or every step of a Robinhood plan, never the instant
    // local mutation the sim used to do. `plan step 95`
    await api.trade(q);
  } catch (err) {
    go.disabled = false;
    go.textContent = restoreLabel;
    if (err instanceof SignerCancelledError) toast('SIGNING CANCELLED');
    // A wallet rejection is the trader's own decision, not a red failure;
    // everything else — insufficient funds, a slippage revert, the wrong
    // chain — reports the real reason it did not settle.
    else if (isRejection(err)) toast(describeWalletError(err));
    else toast(describeWalletError(err), 'red');
    return;
  }
  go.disabled = false;
  go.textContent = restoreLabel;

  toast(TV.side + ' ' + amount.toFixed(2) + ' ' + (c.base || nativeUnit()) + ' ' + DOT + ' ' + c.sym + ' ' + DOT + ' FILLED');
  if (realized !== null) toast((realized >= 0 ? '+' : '-') + usd(Math.abs(realized)) + ' REALIZED', realized >= 0 ? 'gold' : 'red');
  const tp = $('#tradePnl');
  const gb = go.getBoundingClientRect();
  if (tp && !reducedMotion()) {
    tp.classList.remove('filled');
    reflow(tp);
    tp.classList.add('filled');
  }
  burst(gb.left + 8, gb.top + 3, Math.max(8, gb.height - 6), { n: 24, green: true, spread: 1.3 });
  addChat(roomOf(c), {
    who: 'YOU',
    col: '#ffa22b',
    text: (buy ? 'aped ' : 'sold ') + amount.toFixed(2) + ' ' + nativeUnit().toLowerCase() + ' of $' + c.sym,
    mine: true,
  });
  if (TV.tab === 'trades') renderTab();
  syncToken();
  renderQuote();
  paint(c);
}

export function closeToken(): void {
  if (TV.c && api.mode === 'live') api.unwatchToken(TV.c.sym);
  clearInterval(TV.qTimer);
  TV.qTimer = 0;
  TV.c = null;
  clear(must('#tokenView'));
  setChatToken(null);
  window.scrollTo(0, 0);
}
