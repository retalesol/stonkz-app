import {
  CB_MS,
  GRAD,
  SUPPLY,
  type Quote,
  type QuoteHop,
  type TokenFees,
  ago,
  cbLeft,
  curve,
  effFee,
  inCashback,
  laneOf,
  liq,
  num,
  pct,
  price,
  px,
  usd,
  vol24,
} from '@stonkz/shared';
import { NET_INFO, isEvm, nativeUnit as nativeUnitOf, type Net } from '@stonkz/shared';
import { fetchChatHistory, fetchXProfile, sendChatMessage, SocialApiError } from '../api/social.js';
import { api } from '../api/index.js';
import { LiveApiError, subscribeChatRoom, type LiveChatFrame } from '../api/live.js';
import { navigate, retitle } from '../app/route.js';
import { SignerCancelledError } from '../app/signer.js';
import { describeWalletError, isPracticeSession, isRejection } from '../wallet/index.js';
import { showView } from '../app/view.js';
import { drawTokenChart } from '../canvas/chart.js';
import { paintCoinArt } from '../canvas/pix.js';
import { burst } from '../fx/debris.js';
import { toast } from '../fx/toast.js';
import { $, $$, clear, must, reflow } from '../lib/dom.js';
import { ARR, DOT, MID, clock, clockSec, fmtSupply, ud } from '../lib/fmt.js';
import { type Html, attr, html, render } from '../lib/html.js';
import { copyText } from '../lib/clipboard.js';
import { displayName, myDisplayName, rememberIdentity } from '../lib/identity.js';
import { reducedMotion } from '../lib/motion.js';
import { canHover } from '../lib/pointer.js';
import { ensureSession, hasSession, sessionWallet } from '../app/session.js';
import { type Comment, type SimCoin, holdersOf, seedSeries, seedTrades } from '../state/coins.js';
import { holdOf } from '../state/holdings.js';
import { syncHoldingFromChain, safeSellAmountInput } from '../api/live-holding.js';
import { SET } from '../state/settings.js';
import { NATIVE_PRICE, WALLET, nativeUnit } from '../state/wallet.js';
import { openStake } from '../modals/stake.js';
import { setChatToken, roomOf, addChat } from './chat.js';
import { netPill, paint } from './board.js';
import { connectWallet } from '../app/wallet.js';

/**
 * The token page.
 *
 * Rebuilt from a string on open, then patched by `syncToken()` on every beat —
 * the same split the board uses, for the same reason.
 * `index.html:1677`
 */

export interface TokenViewState {
  c: SimCoin | null;
  tab: 'trades' | 'holders' | 'comments' | 'fees';
  side: 'BUY' | 'SELL';
  range: number;
  cross: number | null;
  qTimer: number;
  /** Drops stale quotes when the live adapter answers out of order. */
  qSeq: number;
}

export const TV: TokenViewState = {
  c: null,
  tab: 'trades',
  side: 'BUY',
  range: 90,
  cross: null,
  qTimer: 0,
  qSeq: 0,
};

/* ------------------------------- markup ----------------------------------- */

function caLabel(c: SimCoin): string {
  const raw = (c.mint && c.mint.length > 8 ? c.mint : '') || '';
  if (raw) return raw.length > 16 ? raw.slice(0, 6) + '…' + raw.slice(-4) : raw;
  return 'PENDING';
}

function tradeHint(c: SimCoin): string {
  if (api.mode !== 'live') return 'ORDERS ARE SIMULATED. NOTHING IS SIGNED, SENT OR SETTLED.';
  if (c.lane === 'grad') {
    return 'GRADUATED — CURVE TRADING IS CLOSED. OPEN THE DEX POOL IN AN EXPLORER / UNISWAP (IN-APP DEX ROUTING NOT WIRED).';
  }
  if (!c.tradeable) {
    return 'FIXTURE TOKEN — NO ON-CHAIN MINT. PICK A TRADEABLE TOKEN (LIVE CURVE) TO PLACE ORDERS.';
  }
  return 'LIVE CURVE — YOUR WALLET SIGNS AND BROADCASTS THE TRADE.';
}

/** True when the connected wallet cannot sign for this coin's chain. */
function crossChain(c: SimCoin): boolean {
  return WALLET.on && (c.net ?? 'SOL') !== WALLET.net;
}

function crossChainHTML(c: SimCoin): Html {
  if (!crossChain(c)) return html``;
  const here = NET_INFO[c.net ?? 'SOL'];
  const mine = NET_INFO[WALLET.net];
  return html`<div class="xchain" role="status">
    <span class="xl">WRONG CHAIN</span>
    <span class="xs"
      >THIS COIN LIVES ON <b>${here.name}</b>. YOUR WALLET IS CONNECTED TO <b>${mine.name}</b>, SO
      IT CANNOT SIGN HERE.</span
    >
    <span class="grow"></span>
    <button type="button" class="custbtn" id="xchain-switch">SWITCH TO ${here.short}</button>
  </div>`;
}

function tokenHTML(c: SimCoin): Html {
  const grad = c.lane === 'grad';
  const unit = nativeUnit();
  const pair = c.base || unit;
  const ca = caLabel(c);
  const caFull = c.mint || '';
  return html`<div class="tk-bar">
      <button class="back" id="tk-back">${ARR} BOARD</button
      ><canvas width="128" height="128" aria-hidden="true"></canvas>
      <div class="tk-id">
        <h1>${c.sym}<small>${c.name}</small></h1>
        <div class="sub">
          ${
            c.base
              ? html`PAIR <b>${c.sym}/${c.base}</b> ${DOT} SUPPLY
                  <b>${fmtSupply(c.supply || SUPPLY)}</b> ${DOT} FEE
                  <b>${Number(c.tfee).toFixed(1)}%</b> ${DOT} `
              : ''
          }CA
          ${
            caFull
              ? html`<b class="addrlink" title="${attr(caFull)}" data-addr="${attr(caFull)}"
                  >${ca}</b
                >`
              : html`<b class="dm">${ca}</b>`
          }
          ${DOT} DEV
          <b class="addrlink" data-addr="${attr(c.dev)}"
            >${c.dev.length > 12 ? c.dev.slice(0, 4) + '…' + c.dev.slice(-4) : c.dev}</b
          >
          ${DOT} ${ago(c.age)} ${DOT} ON ${netPill(c.net ?? 'SOL')} ${DOT}
          <span class="${grad ? 'gd' : 'up'}" id="s-state">${grad ? 'BONDED' : 'ACTIVE'}</span>
        </div>
      </div>
      <div class="tk-stats">
        <div><span class="lbl">PRICE</span><span class="v" id="s-px">${px(price(c))}</span></div>
        <div>
          <span class="lbl">MARKET CAP</span><span class="v am" id="s-mc">${usd(c.mc)}</span>
        </div>
        <div>
          <span class="lbl">24H</span><span class="v ${ud(c.chg)}" id="s-chg">${pct(c.chg)}</span>
        </div>
        <div>
          <span class="lbl">VOL 24H</span><span class="v" id="s-vol">${usd(vol24(c))}</span>
        </div>
        <div>
          <span class="lbl">LIQUIDITY</span><span class="v" id="s-liq">${usd(liq(c))}</span>
        </div>
        <div><span class="lbl">HOLDERS</span><span class="v" id="s-hold">${num(c.hold)}</span></div>
      </div>
      <button class="back" id="tk-share" title="Copy link">SHARE</button>
      <button class="stakebtn" id="tk-stake">STAKE</button>
    </div>
    <div id="cbWrap">${cbBannerHTML(c)}</div>
    <div id="xchainWrap">${crossChainHTML(c)}</div>

    <div class="tk-grid">
      <section class="pnl">
        <div class="pnl-hd">
          <h2>Price</h2>
          <span class="sub">${c.sym}/${pair} ${DOT} 1M CANDLES</span>
          <div class="rt">
            <button class="tab" data-rg="45">45M</button
            ><button class="tab on" data-rg="90">90M</button
            ><button class="tab" data-rg="140">140M</button
            ><button class="tab" data-rg="200">ALL</button>
          </div>
        </div>
        <div class="chartbox">
          <canvas id="tchart"></canvas>
          <div class="hud" id="ch-hud"></div>
        </div>
        <div class="curvebar">
          <div class="pt">
            <span>BONDING CURVE</span><b class="am" id="cv-pct">${curve(c).toFixed(1)}%</b>
          </div>
          <div class="ptrack">
            <i id="cv-bar" class="${grad ? 'done' : ''}" style="width:${attr(curve(c))}%"></i>
          </div>
          <div class="note" id="cv-note"></div>
        </div>
      </section>

      <section class="pnl" id="tradePnl">
        <div class="pnl-hd">
          <h2>Trade</h2>
          <span class="sub"
            >MARKET ${DOT}
            ${
              api.mode === 'live'
                ? c.tradeable
                  ? 'LIVE CURVE'
                  : 'STAGING / INDICATIVE'
                : 'SIMULATED'
            }</span
          >
        </div>
        <div class="pnl-bd">
          <div class="seg" id="t-side">
            <button type="button" data-s="BUY" class="on">BUY</button
            ><button type="button" data-s="SELL">SELL</button>
          </div>
          <div>
            <span class="lbl" id="t-amt-lbl">AMOUNT (${unit})</span
            ><input
              class="fld"
              id="t-amt"
              value="${Number(SET.defBuy).toFixed(2)}"
              inputmode="decimal"
            />
          </div>
          <div class="amt-row" id="t-quick"></div>
          <div class="quote" id="t-quote"></div>
          <button
            class="big"
            id="t-go"
            ${api.mode === 'live' && (!c.tradeable || c.lane === 'grad') ? ' disabled' : ''}
          >
            BUY ${c.sym}
          </button>
          <div class="bal" id="t-bal"></div>
          <div class="pos" id="t-pos" hidden></div>
          <p class="hint">${tradeHint(c)}</p>
        </div>
      </section>

      <section class="pnl">
        <div class="pnl-hd">
          <h2>Activity</h2>
          <div class="rt tabs">
            <button class="tab on" data-tab="trades">RECENT TRADES</button
            ><button class="tab" data-tab="holders">HOLDERS</button
            ><button class="tab" data-tab="comments">COMMENTS</button
            ><button class="tab" data-tab="fees">FEES</button>
          </div>
        </div>
        <div id="tabbody"></div>
      </section>

      <section class="pnl">
        <div class="pnl-hd">
          <h2>X Stream</h2>
          <span class="sub" id="xSub">LOOKING UP…</span>
        </div>
        <div class="pnl-bd">
          <form class="xhandle" id="xform">
            <input
              class="fld"
              id="xin"
              value="${attr(c.x ?? '')}"
              maxlength="20"
              aria-label="X account"
            /><button class="send" type="submit">LOAD</button>
          </form>
          <div id="xfeed"></div>
          <p class="xnote" id="xNote">ENTER AN @HANDLE TO LOOK UP THE REAL X PROFILE.</p>
        </div>
      </section>
    </div>`;
}

/* -------------------------------- chart ----------------------------------- */

export function drawTChart(): void {
  const c = TV.c;
  if (!c) return;
  if (api.mode === 'sim') seedSeries(c);
  const box = $('#tchart')?.parentElement;
  if (!c.h || !c.hv || c.h.length < 1) {
    const cvs = $<HTMLCanvasElement>('#tchart');
    if (cvs) {
      const g = cvs.getContext('2d');
      if (g) {
        const w = cvs.clientWidth || 400;
        const h = cvs.clientHeight || 220;
        cvs.width = w;
        cvs.height = h;
        g.fillStyle = '#040507';
        g.fillRect(0, 0, w, h);
        g.fillStyle = '#6b675c';
        g.font = '11px "IBM Plex Mono", monospace';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(api.mode === 'live' ? 'LOADING CANDLES…' : 'NO SERIES', w / 2, h / 2);
      }
    }
    if (box) render($('#ch-hud'), html`<span class="dm">NO CANDLE HISTORY YET</span>`);
    return;
  }
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
  const sized =
    Number.isFinite(h.inAmount) && Number.isFinite(h.outAmount)
      ? ` ${DOT} ${fmtNativeAmt(h.inAmount)} \u2192 ${fmtNativeAmt(h.outAmount)}`
      : '';
  return html`<div class="qrow">
    <span>HOP ${i + 1} ${DOT} ${venueName(h.venue)}</span
    ><b>${h.inSymbol} ${'\u203A'} ${h.outSymbol}${sized} ${DOT} <span class="dm">${fee}</span></b>
  </div>`;
}

function quoteHTML(c: SimCoin, q: Quote): Html {
  const buy = q.side === 'buy';
  const slip = Number(SET.slip);
  const feeHop = q.hops.find((h) => h.feeAmount > 0) ?? q.hops.find((h) => h.feeBps > 0);
  const feeNative = feeHop?.feeAmount ?? q.hops.reduce((n, h) => n + h.feeAmount, 0);
  const feeUnit = feeHop ? (buy ? feeHop.inSymbol : feeHop.outSymbol) : q.nativeUnit;
  const impact = q.impactPct;
  const hops = q.hops.length > 1 ? q.hops.map((h, i) => hopRow(h, i)) : '';
  const banner = q.indicative
    ? html`<div class="qrow">
        <span>STATUS</span><b class="am">INDICATIVE ${DOT} FIXTURE ONLY</b>
      </div>`
    : '';
  // Amount box is always native (ETH/SOL) on buy and the launched token on sell.
  // Never label the pay/get row with `c.base` — that made 0.01 ETH read as 0.01 USDG.
  const payAmt = buy ? q.amountIn : q.amountOut;
  const payUnit = q.nativeUnit;
  const payUsd =
    q.nativeUsd && payAmt > 0 ? ` ${DOT} \u2248 $${(payAmt * q.nativeUsd).toFixed(2)}` : '';
  // `/quote` ships minOut with slip=0; mirror the sim and apply the trader's
  // settings so MIN RECEIVED is not identical to YOU GET / YOU RECEIVE.
  const minReceived = q.amountOut * (1 - slip / 100);
  const minLabel = buy
    ? `${num(minReceived)} ${c.sym}`
    : `${fmtNativeAmt(minReceived)} ${q.nativeUnit}`;
  return html`${banner}
    <div class="qrow hero">
      <span>${buy ? 'YOU RECEIVE' : 'YOU SELL'}</span
      ><b>${num(buy ? q.amountOut : (q.hops[0] as QuoteHop).inAmount)} ${c.sym}</b>
    </div>
    <div class="qrow">
      <span>${buy ? 'YOU PAY' : 'YOU GET'}</span><b>${fmtNativeAmt(payAmt)} ${payUnit}${payUsd}</b>
    </div>
    <div class="qrow"><span>PRICE</span><b>${px(price(c))}</b></div>
    ${hops}
    <div class="qrow">
      <span>PRICE IMPACT</span
      ><b class="${impact < 2 ? 'up' : impact < 8 ? 'am' : 'dn'}">${impact.toFixed(2)}%</b>
    </div>
    <div class="qrow">
      <span>SLIPPAGE / FEE</span
      ><b>${slip.toFixed(1)}% ${DOT} ${fmtNativeAmt(feeNative)} ${feeUnit}</b>
    </div>
    <div class="qrow">
      <span>NETWORK</span
      ><b
        >${
          isEvm(c.net ?? WALLET.net)
            ? nativeUnitOf(c.net ?? WALLET.net) + ' GAS · PRIO/MEV N/A ON ' + NET_INFO[c.net ?? WALLET.net].name
            : 'PRIO ' +
              Number(SET.prio).toFixed(4) +
              ' ' +
              DOT +
              ' MEV ' +
              (SET.mev === 'OFF' ? 'OFF' : Number(SET.mevTip).toFixed(4) + ' ' + SET.mev)
        }</b
      >
    </div>
    <div class="qrow"><span>MIN RECEIVED</span><b>${minLabel}</b></div>
    <div class="qrow">
      <span>ROUTE</span><b>${q.hops.map((h) => venueName(h.venue)).join(' \u203A ')}</b>
    </div>
    <div class="qfoot">
      <span>QUOTE</span><span class="qbar"><i id="qbar-i"></i></span><span>8S</span>
    </div>`;
}

/** Enough decimals for sub-0.01 ETH buys without lying as `0.00`. */
function fmtNativeAmt(v: number): string {
  if (!Number.isFinite(v) || v === 0) return '0';
  if (Math.abs(v) >= 1) return v.toFixed(4).replace(/\.?0+$/, '');
  if (Math.abs(v) >= 0.01) return v.toFixed(4).replace(/\.?0+$/, '');
  return v.toFixed(6).replace(/\.?0+$/, '');
}

export function renderQuote(): void {
  const c = TV.c;
  if (!c) return;
  const amount = parseFloat(($('#t-amt') as HTMLInputElement | null)?.value ?? '') || 0;
  const buy = TV.side === 'BUY';
  const seq = ++TV.qSeq;

  const go = $('#t-go') as HTMLButtonElement | null;
  if (go) {
    go.textContent = crossChain(c)
      ? 'SWITCH TO ' + NET_INFO[c.net ?? 'SOL'].short + ' TO TRADE'
      : TV.side + ' ' + c.sym;
    go.className = 'big' + (buy ? '' : ' sell');
    if (api.mode === 'live') go.disabled = !c.tradeable || c.lane === 'grad';
  }

  if (!(amount > 0)) {
    render(
      $('#t-quote'),
      html`<div class="qrow"><span>QUOTE</span><b class="dm">ENTER AN AMOUNT</b></div>`,
    );
    if (go && api.mode === 'live') go.disabled = true;
  } else {
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
        const goBtn = $('#t-go') as HTMLButtonElement | null;
        if (goBtn && api.mode === 'live') {
          goBtn.disabled = !c.tradeable || c.lane === 'grad' || !!q.indicative;
        }
      })
      .catch((err: unknown) => {
        render(
          $('#t-quote'),
          html`<div class="qrow"><span>QUOTE</span><b class="dn">${String(err)}</b></div>`,
        );
      });
  }
  const lbl = $('#t-amt-lbl');
  if (lbl) {
    lbl.textContent = buy ? 'AMOUNT (' + nativeUnit() + ')' : 'AMOUNT (' + c.sym + ')';
  }
  // Quick picks: native units on buy, % of position on sell.
  const quick = $('#t-quick');
  if (quick) {
    if (buy) {
      render(
        quick,
        html`${[0.1, 0.5, 1, 5].map((x) => html`<button type="button" class="qa" data-a="${attr(x)}">${x}</button>`)}<button
            type="button"
            class="qa"
            data-a="max"
          >
            MAX
          </button>`,
      );
    } else {
      render(
        quick,
        html`${[25, 50, 75].map(
            (p) => html`<button type="button" class="qa" data-a="pct:${attr(p)}">${p}%</button>`,
          )}<button type="button" class="qa" data-a="max">MAX</button>`,
      );
    }
  }
  syncPosition(c);
}

function syncPosition(c: SimCoin): void {
  const pe = $('#t-pos');
  if (!pe) return;

  // Live RH: overwrite HOLD from ERC-20 balance so we never show the
  // usd÷price fantasy that invents ~2.7M when MetaMask holds 21M.
  if (api.mode === 'live' && c.net && isEvm(c.net) && c.mint && WALLET.on && WALLET.full) {
    void syncHoldingFromChain(c, WALLET.full || sessionWallet(c.net)).then((tok) => {
      if (tok === null || TV.c !== c) return;
      paintPosition(c);
    });
  }
  paintPosition(c);
}

function paintPosition(c: SimCoin): void {
  const pe = $('#t-pos');
  if (!pe) return;
  const hp = holdOf(c.sym);
  if (hp && hp.tok > 0.5) {
    const pv = hp.tok * price(c);
    const ppl = hp.cost > 0 ? (pv / hp.cost - 1) * 100 : 0;
    render(
      pe,
      html`<span>YOUR POSITION <b>${num(hp.tok)} ${c.sym}</b></span
        ><span
          ><b>${usd(pv)}</b>${hp.cost > 0 ? html` <b class="${ud(ppl)}">${pct(ppl)}</b>` : ''}</span
        >`,
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
        : html`<span class="dm">NO WALLET CONNECTED</span
            ><span class="dm"
              >${api.mode === 'live' ? 'CONNECT TO TRADE' : 'SIM FILLS ONLY'}</span
            >`,
    );
  }
}

/* --------------------------------- tabs ----------------------------------- */

function tradesHTML(c: SimCoin): Html {
  const trades = c.trades ?? [];
  if (api.mode === 'live' && c.trades == null) {
    return html`<div class="pnl-bd"><p class="hint">LOADING TRADES…</p></div>`;
  }
  if (!trades.length) {
    return html`<div class="pnl-bd"><p class="hint">NO RECENT TRADES YET.</p></div>`;
  }
  return html`<div class="scrolly">
    <table class="tbl">
      <thead>
        <tr>
          <th scope="col">TIME</th>
          <th scope="col">TYPE</th>
          <th scope="col" class="r">${nativeUnit()}</th>
          <th scope="col" class="r">TOKENS</th>
          <th scope="col" class="r">MCAP</th>
          <th scope="col">TRADER</th>
          <th scope="col">VEN</th>
        </tr>
      </thead>
      <tbody>
        ${trades.map((t, i) => {
          const link = t.addr || t.w;
          const multi = !!(t.hops && t.hops.length > 1);
          const open = !!t.open && multi;
          const rowClass = [
            'tr-row',
            t.fresh && i === 0 ? 'newrow' : '',
            multi ? 'tr-hop' : '',
            open ? 'open' : '',
          ]
            .filter(Boolean)
            .join(' ');
          const hopAttrs = multi
            ? html` data-tr="${i}" tabindex="0" role="button"
              aria-expanded="${open ? 'true' : 'false'}"`
            : '';
          return html`<tr class="${attr(rowClass)}" ${hopAttrs}>
              <td class="dm">${clockSec(t.t)}</td>
              <td class="${t.buy ? 'up' : 'dn'}">${t.buy ? 'BUY' : 'SELL'}</td>
              <td class="r">${t.sol.toFixed(2)}</td>
              <td class="r">${num(t.tok)}</td>
              <td class="r">${usd(t.mc)}</td>
              <td class="${t.cb ? '' : 'bl'}">
                ${
                  t.cb
                    ? html`<span class="tag cb">CASHBACK</span>`
                    : html`<span class="addrlink" data-addr="${attr(link)}"
                        >${displayName(t.w)}</span
                      >`
                }
              </td>
              <td class="dm ven-cell">
                ${t.v}${multi ? html`<span class="ven-chev" aria-hidden="true">${open ? '▾' : '▸'}</span>` : ''}
              </td>
            </tr>
            ${
              open && t.hops
                ? html`<tr class="tr-hops">
                    <td colspan="7">
                      <div class="hop-detail">
                        ${t.hops.map(
                      (h, hi) =>
                        html`<div class="hop-leg">
                          <span class="hop-n">HOP ${hi + 1}</span
                          ><span class="hop-v">${h.venue}</span
                          ><span class="hop-path"
                            >${h.inAmount < 0.001 ? h.inAmount.toPrecision(3) : num(h.inAmount)}
                            ${h.inSymbol} →
                            ${h.outAmount < 0.001 ? h.outAmount.toPrecision(3) : num(h.outAmount)}
                            ${h.outSymbol}</span
                          >
                        </div>`,
                    )}
                      </div>
                    </td>
                  </tr>`
                : ''
            }`;
        })}
      </tbody>
    </table>
  </div>`;
}

function holdersHTML(c: SimCoin): Html {
  // Live mode: only show API holders (or empty). Never invent wallets.
  // Sim mode: synthetic `holdersOf` until/unless live rows exist.
  const rows = api.mode === 'live' ? (c.liveHolders ?? []) : (c.liveHolders ?? holdersOf(c));
  if (api.mode === 'live' && c.liveHolders == null) {
    return html`<div class="pnl-bd"><p class="hint">LOADING HOLDERS…</p></div>`;
  }
  if (!rows.length) {
    return html`<div class="pnl-bd"><p class="hint">NO HOLDERS ON RECORD YET.</p></div>`;
  }
  return html`<div class="scrolly">
    <table class="tbl">
      <thead>
        <tr>
          <th scope="col">#</th>
          <th scope="col">WALLET</th>
          <th scope="col" class="r">HOLDING</th>
          <th scope="col" class="r">VALUE</th>
          <th scope="col">TAG</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((h, i) => {
          const link = h.addr || h.w;
          return html`<tr>
            <td class="dm">${i + 1}</td>
            <td class="${h.curve ? 'am' : 'bl'}">
              ${
                h.curve
                  ? h.w
                  : html`<span class="addrlink" data-addr="${attr(link)}"
                      >${displayName(h.w)}</span
                    >`
              }
            </td>
            <td class="r">${h.p.toFixed(2)}%</td>
            <td class="r">${usd((c.mc * h.p) / 100)}</td>
            <td>
              ${h.tag ? html`<span class="tag ${h.tag[1]}">${h.tag[0]}</span>` : html`<span class="dm">${MID}</span>`}
            </td>
          </tr>`;
        })}
      </tbody>
    </table>
  </div>`;
}

function commentsHTML(c: SimCoin): Html {
  const list = c.comments ?? [];
  if (api.mode === 'live' && c.comments == null) {
    return html`<div class="pnl-bd"><p class="hint">LOADING COMMENTS…</p></div>`;
  }
  return html`<div class="pnl-bd">
    <div class="scrolly" style="display:flex;flex-direction:column;gap:7px" id="cmt-list">
      ${
        list.length
          ? list.map(
              (m) =>
                html`<div class="cmt${m.mine ? ' mine' : ''}">
                  <div class="who">
                    ${html`<span class="addrlink" data-addr="${attr(m.who)}"
                      >${m.mine ? myDisplayName() : displayName(m.who)}</span
                    >`}<span>${m.t}</span>
                  </div>
                  <p>${m.text}</p>
                </div>`,
            )
          : html`<p class="hint" style="margin:0">NO COMMENTS YET ${DOT} BE THE FIRST.</p>`
      }
    </div>
    <form class="inline-form" id="cmt-form">
      <input
        class="fld"
        id="cmt-in"
        maxlength="140"
        placeholder="POST A REPLY"
        aria-label="Comment"
      /><button class="send" type="submit">POST</button>
    </form>
  </div>`;
}

let commentUnsub: (() => void) | null = null;
let commentsLoadedFor: string | null = null;

function commentRoomNet(c: SimCoin): Net {
  return c.net ?? 'SOL';
}

function pushComment(c: SimCoin, m: Comment): void {
  if (!c.comments) c.comments = [];
  // Dedupe by wallet+text+time bucket for WS echoes of our own POST.
  if (c.comments.some((x) => x.who === m.who && x.text === m.text && x.t === m.t)) return;
  c.comments.push(m);
  c.reps = c.comments.length;
}

async function loadLiveComments(c: SimCoin): Promise<void> {
  const net = commentRoomNet(c);
  const room = c.sym.toUpperCase();
  const key = net + ':' + room;
  if (commentsLoadedFor === key && c.comments) return;
  commentsLoadedFor = key;
  c.comments = null;
  if (TV.c === c && TV.tab === 'comments') renderTab();

  commentUnsub?.();
  commentUnsub = null;

  try {
    const res = await fetchChatHistory(net, room);
    if (TV.c !== c) return;
    c.comments = res.messages.map((m) => {
      if (m.username || m.avatarUrl) {
        rememberIdentity(m.wallet, {
          username: m.username ?? null,
          avatarUrl: m.avatarUrl ?? null,
        });
      }
      return {
        who: m.wallet,
        t: clock(new Date(m.createdAtMs)),
        text: m.text,
        mine: m.wallet === sessionWallet(net) || m.wallet === WALLET.full,
      };
    });
    c.reps = c.comments.length;
  } catch {
    if (TV.c !== c) return;
    c.comments = [];
  }

  commentUnsub = subscribeChatRoom(net, room, (msg: LiveChatFrame) => {
    if (TV.c !== c) return;
    if (msg.username || msg.avatarUrl) {
      rememberIdentity(msg.wallet, {
        username: msg.username ?? null,
        avatarUrl: msg.avatarUrl ?? null,
      });
    }
    pushComment(c, {
      who: msg.wallet,
      t: clock(new Date(msg.createdAtMs)),
      text: msg.text,
      mine: msg.wallet === sessionWallet(net) || msg.wallet === WALLET.full,
    });
    paint(c);
    if (TV.tab === 'comments') renderTab();
  });

  if (TV.c === c && TV.tab === 'comments') renderTab();
  paint(c);
}

/* --------------------------------- fees ----------------------------------- */

function feesLoadingHTML(): Html {
  return html`<div class="pnl-bd"><p class="hint">LOADING THE FEE LEDGER…</p></div>`;
}

async function loadFees(c: SimCoin): Promise<void> {
  const b = $('#tabbody');
  if (!b || !api.tokenFees) return;
  try {
    const f = await api.tokenFees(c);
    if (TV.c !== c || TV.tab !== 'fees') return;
    render(b, feesHTML(f));
  } catch (err) {
    if (TV.c !== c || TV.tab !== 'fees') return;
    render(b, html`<div class="pnl-bd"><p class="hint dn">FEE LEDGER UNAVAILABLE: ${String(err)}</p></div>`);
  }
}

function feesHTML(f: TokenFees): Html {
  const u = f.unit;
  const nat = (v: number): string => v.toFixed(u === 'USDC' ? 2 : 4) + ' ' + u;
  const usdOf = (v: number): string => usd(v * NATIVE_PRICE.usd);
  const pctOf = (v: number): string => (f.totals.gross > 0 ? ((v / f.totals.gross) * 100).toFixed(1) : '0.0') + '%';
  const row = (k: string, share: string, v: number, note: string, cls = ''): Html =>
    html`<tr>
      <td class="${cls}">${k}</td>
      <td class="r">${share}</td>
      <td class="r">${usdOf(v)}</td>
      <td class="r dm">${nat(v)}</td>
      <td class="dm">${note}</td>
    </tr>`;
  const stakerShare = f.totals.creatorBucket > 0 ? f.totals.stakers / f.totals.creatorBucket : 0;
  return html`<div class="pnl-bd">
    <div class="quad" style="margin:0">
      <div>
        <div class="lbl">BUY / SELL TAX</div>
        <div class="val am">${(f.effFeeBps / 100).toFixed(1)}%</div>
        <span class="hint"
          >${
            f.effFeeBps > f.feeBps
              ? 'CASHBACK ' + DOT + ' DECAYING TO ' + (f.feeBps / 100).toFixed(1) + '%'
              : 'SET BY THE CREATOR ' + DOT + ' 1% TO 5%'
          }</span
        >
      </div>
      <div>
        <div class="lbl">FEES COLLECTED</div>
        <div class="val">${usdOf(f.totals.gross)}</div>
        <span class="hint">${nat(f.totals.gross)} LIFETIME</span>
      </div>
      <div>
        <div class="lbl">CREATOR EARNED</div>
        <div class="val up">${usdOf(f.totals.creator)}</div>
        <span class="hint">${nat(f.totals.creator)}</span>
      </div>
      <div>
        <div class="lbl">TO STONKZ GAME</div>
        <div class="val gd">${usdOf(f.totals.game)}</div>
        <span class="hint">$STONKZ BUYBACK FOR THE DAILY POT</span>
      </div>
    </div>
    <div class="scrolly">
      <table class="tbl">
        <thead>
          <tr>
            <th>WHERE THE TAX GOES</th>
            <th class="r">SHARE</th>
            <th class="r">USD</th>
            <th class="r">${u}</th>
            <th>NOTE</th>
          </tr>
        </thead>
        <tbody>
          ${row('CREATOR', pctOf(f.totals.creator), f.totals.creator, (f.split.creatorBucket * 100).toFixed(0) + '% BUCKET, LESS THE STAKING CUT', 'gd')}
          ${row('STAKERS', pctOf(f.totals.stakers), f.totals.stakers, (stakerShare * 100).toFixed(1) + '% OF THE CREATOR BUCKET ' + DOT + ' UP TO HALF', 'am')}
          ${row('PROTOCOL REVENUE', pctOf(f.totals.protocol), f.totals.protocol, (f.split.protocol * 100).toFixed(0) + '% OF EVERY TAX')}
          ${row('STONKZ GAME BUYBACK', pctOf(f.totals.game), f.totals.game, (f.split.stonkzOps * 100).toFixed(0) + '% ' + DOT + ' BUYS $STONKZ FOR THE DAILY POT', 'gd')}
          ${row('BUYBACK AND BURN', pctOf(f.totals.burn), f.totals.burn, (f.split.burn * 100).toFixed(0) + '% ' + DOT + ' BUYS $STONKZ AND BURNS IT', 'dn')}
        </tbody>
      </table>
    </div>
    <p class="hint">
      ${
        f.source === 'chain'
          ? 'SETTLED ON CHAIN ON EVERY FILL AND READ BACK FROM THE INDEXER. REFERRAL COMMISSIONS (15 / 10 / 5%) ARE PAID FROM THE PROTOCOL LEG.'
          : 'SANDBOX ESTIMATE FROM 24H VOLUME AND AGE, SPLIT EXACTLY THE WAY THE PROGRAMS DO IT.'
      }
    </p>
  </div>`;
}

export function renderTab(): void {
  const c = TV.c;
  const b = $('#tabbody');
  if (!c || !b) return;
  render(
    b,
    TV.tab === 'trades'
      ? tradesHTML(c)
      : TV.tab === 'holders'
        ? holdersHTML(c)
        : TV.tab === 'fees'
          ? feesLoadingHTML()
          : commentsHTML(c),
  );
  if (TV.tab === 'fees') void loadFees(c);
  // `fresh` drives the one-shot orange `newrow` flash. Clear after paint so
  // the 5s board poll (which re-renders this tab) does not restart it.
  if (TV.tab === 'trades' && c.trades) {
    for (const t of c.trades) t.fresh = false;
  }
  if (TV.tab === 'trades') {
    b.querySelectorAll<HTMLElement>('tr.tr-hop').forEach((row) => {
      const toggle = (): void => {
        const idx = Number(row.dataset['tr']);
        const t = c.trades?.[idx];
        if (!t || !t.hops || t.hops.length < 2) return;
        t.open = !t.open;
        renderTab();
      };
      row.addEventListener('click', (e) => {
        if ((e.target as Element | null)?.closest('.addrlink')) return;
        toggle();
      });
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle();
        }
      });
    });
  }
  if (TV.tab === 'comments') {
    if (api.mode === 'live') void loadLiveComments(c);
    $('#cmt-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      void postComment(c);
    });
  }
}

async function postComment(c: SimCoin): Promise<void> {
  const input = $('#cmt-in') as HTMLInputElement | null;
  const v = input?.value.trim();
  if (!input || !v) return;

  if (api.mode !== 'live') {
    if (!c.comments) c.comments = [];
    c.comments.push({
      who: WALLET.full || WALLET.addr || myDisplayName(),
      t: 'now',
      text: v,
      mine: true,
    });
    c.reps = c.comments.length;
    paint(c);
    input.value = '';
    renderTab();
    return;
  }

  if (!WALLET.on) {
    toast('CONNECT A WALLET TO COMMENT');
    return;
  }
  const net = commentRoomNet(c);
  const room = c.sym.toUpperCase();
  const API_BASE = import.meta.env['VITE_API_URL'] ?? '';
  input.disabled = true;
  try {
    await ensureSession(API_BASE, net);
    const res = await sendChatMessage(net, room, v);
    if (res.message?.flagged) {
      toast('COMMENT FLAGGED BY MODERATION', 'red');
    } else if (res.message) {
      pushComment(c, {
        who: sessionWallet(net) || WALLET.full,
        t: clock(new Date(res.message.createdAtMs)),
        text: res.message.text,
        mine: true,
      });
      paint(c);
    }
    input.value = '';
    renderTab();
    const l = $('#cmt-list');
    if (l) l.scrollTop = l.scrollHeight;
  } catch (err) {
    toast(err instanceof SocialApiError ? err.message : String(err), 'red');
  } finally {
    input.disabled = false;
    input.focus();
  }
}

/* -------------------------------- X feed ---------------------------------- */

export function renderX(handle: string): void {
  const c = TV.c;
  if (!c) return;
  const feed = $('#xfeed');
  const sub = $('#xSub');
  const note = $('#xNote');
  if (!feed) return;

  const clean = handle.replace(/^@+/, '').trim();
  if (!clean) {
    render(feed, html`<p class="hint">NO X HANDLE SET FOR THIS TOKEN.</p>`);
    if (sub) sub.textContent = 'NO HANDLE';
    if (note) note.textContent = 'ADD AN @HANDLE ABOVE AND HIT LOAD.';
    return;
  }

  if (api.mode !== 'live') {
    render(feed, html`<p class="hint">X LOOKUP IS LIVE-MODE ONLY.</p>`);
    if (sub) sub.textContent = '@' + clean;
    if (note) note.textContent = 'SWITCH TO LIVE MODE TO RESOLVE REAL PROFILES.';
    return;
  }

  render(feed, html`<p class="hint">LOOKING UP @${clean}…</p>`);
  if (sub) sub.textContent = '@' + clean + ' · LOOKING UP';
  if (note) note.textContent = '';

  void fetchXProfile(clean)
    .then((p) => {
      if (TV.c !== c) return;
      if (!p.found) {
        const msg =
          p.status === 'suspended'
            ? 'User is banned or suspended'
            : p.status === 'unavailable'
              ? p.reason || 'X profile unavailable'
              : p.reason || "Username doesn't exist";
        render(feed, html`<p class="hint" style="color:var(--dn)">${msg.toUpperCase()}.</p>`);
        if (sub) sub.textContent = '@' + clean + ' · NOT FOUND';
        if (note) note.textContent = msg.toUpperCase() + '.';
        return;
      }

      const href = 'https://x.com/' + encodeURIComponent(p.handle);
      render(
        feed,
        html`<div class="xpost">
          <div class="xh">
            <b>${p.displayName || p.handle}</b><span>@${p.handle}</span>${
              p.verified ? html`<span class="am">✓</span>` : ''
            }
          </div>
          <p class="hint" style="margin:8px 0 0">REAL X PROFILE ${DOT} NO MOCK POSTS.</p>
          <p style="margin-top:10px">
            <a class="addrlink" href="${attr(href)}" target="_blank" rel="noopener noreferrer"
              >OPEN @${p.handle} ON X ↗</a
            >
          </p>
        </div>`,
      );
      if (sub) sub.textContent = '@' + p.handle + (p.verified ? ' ✓' : '') + ' · LIVE PROFILE';
      if (note) note.textContent = 'PROFILE FROM X API. TIMELINE POSTS ARE NOT LOADED.';
    })
    .catch(() => {
      if (TV.c !== c) return;
      render(feed, html`<p class="hint" style="color:var(--dn)">X LOOKUP FAILED.</p>`);
      if (sub) sub.textContent = '@' + clean + ' · ERROR';
      if (note) note.textContent = 'COULD NOT REACH THE X LOOKUP SERVICE.';
    });
}

/* ------------------------------ cashback ---------------------------------- */

function cbBannerHTML(c: SimCoin): Html {
  if (!inCashback(c)) return html``;
  const left = cbLeft(c);
  const frac = left / CB_MS;
  return html`<div class="cb-banner">
    <span class="cbl">CASHBACK LIVE</span
    ><span class="cbv" id="cb-fee">${effFee(c).toFixed(1)}%</span
    ><span class="hint">FEE DECAYING TO ${Number(c.tfee).toFixed(1)}%</span
    ><span class="cbtrack"><i id="cb-bar" style="width:${attr((frac * 100).toFixed(1))}%"></i></span
    ><span class="cbv" id="cb-left">${Math.ceil(left / 1000)}S</span
    ><span class="hint">FEES BUY ${c.sym} FOR THE CREATOR</span>
  </div>`;
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
    const net = c.net ?? 'SOL';
    n.textContent =
      'GRADUATED ' + MID + ' LIQUIDITY MIGRATED TO ' + NET_INFO[net].dex + ' AND ' + NET_INFO[net].lpNote + '.';
  } else {
    const net = c.net ?? 'SOL';
    render(
      n,
      html`AT ${usd(GRAD)} MARKET CAP THE CURVE FILLS, LIQUIDITY MIGRATES
        (${NET_INFO[net].dex}) AND THE LP LOCKS.
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
    c.comments = [];
  } else {
    // Live: candles/trades/holders come from REST and the `token:{sym}` WS
    // channel (`api.watchToken()`); comments load from chat history when the
    // Comments tab opens. Never seed mock comments/X posts.
    c.comments = null;
    commentsLoadedFor = null;
    commentUnsub?.();
    commentUnsub = null;
    void api.watchToken(c).then(() => {
      if (TV.c !== c) return; // navigated away before the fetch landed
      paint(c);
      drawTChart();
      if (TV.tab !== 'comments') renderTab();
    });
  }
  c.lane = laneOf(c);
  TV.c = c;
  // Keep the address bar on the resolved mint so shares/back stay unambiguous.
  navigate({ view: 'token', sym: c.sym, ...(c.mint ? { mint: c.mint } : {}) }, { replace: true });
  TV.tab = 'trades';
  TV.side = 'BUY';
  TV.range = 90;
  TV.cross = null;
  const v = must('#tokenView');
  render(v, tokenHTML(c));
  showView('token');
  paintCoinArt($<HTMLCanvasElement>('.tk-bar canvas'), c.seed, c.image);
  updateCurveNote();
  render(
    must('#t-quick'),
    html`${[0.1, 0.5, 1, 5].map((x) => html`<button type="button" class="qa" data-a="${attr(x)}">${x}</button>`)}<button
        type="button"
        class="qa"
        data-a="max"
      >
        MAX
      </button>`,
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
  $('#xchain-switch')?.addEventListener('click', () => void connectWallet(c.net ?? 'SOL'));
  must('#tk-stake').addEventListener('click', () => openStake(c));
  must('#tk-share').addEventListener('click', () => {
    // Canonical production host; include mint so duplicate tickers resolve.
    const link =
      'https://ston.kz/t/' + c.sym + (c.mint ? '?mint=' + encodeURIComponent(c.mint) : '');
    copyText(link, (ok) =>
      toast(
        ok ? 'LINK COPIED ' + DOT + ' ' + link : 'COPY BLOCKED ' + DOT + ' ' + link,
        ok ? 'gold' : 'red',
      ),
    );
  });
  must('#t-side').addEventListener('click', (e) => {
    const b = (e.target as Element | null)?.closest<HTMLElement>('[data-s]');
    if (!b) return;
    TV.side = b.dataset['s'] as 'BUY' | 'SELL';
    for (const x of Array.from(must('#t-side').children)) x.classList.toggle('on', x === b);
    const amt = must<HTMLInputElement>('#t-amt');
    // Reset to a sensible default for the new side — never leave an ETH
    // balance sitting in the box after flipping to SELL.
    if (TV.side === 'BUY') amt.value = Number(SET.defBuy).toFixed(4);
    else {
      const hp = holdOf(c.sym);
      if (hp?.tokAtoms) amt.value = safeSellAmountInput(BigInt(hp.tokAtoms));
      else amt.value = hp && hp.tok > 0 ? String(hp.tok) : '0';
    }
    renderQuote();
  });
  must('#t-quick').addEventListener('click', (e) => {
    const b = (e.target as Element | null)?.closest<HTMLElement>('[data-a]');
    if (!b) return;
    const amt = must<HTMLInputElement>('#t-amt');
    const raw = b.dataset['a'] ?? '';
    if (TV.side === 'SELL') {
      const hp = holdOf(c.sym);
      const tok = hp?.tok ?? 0;
      if (raw === 'max') {
        amt.value = hp?.tokAtoms
          ? safeSellAmountInput(BigInt(hp.tokAtoms))
          : tok > 0
            ? String(tok)
            : '0';
      } else if (raw.startsWith('pct:')) {
        const p = Number(raw.slice(4)) / 100;
        if (hp?.tokAtoms && p > 0) {
          const share = (BigInt(hp.tokAtoms) * BigInt(Math.round(p * 1_000_000))) / 1_000_000n;
          amt.value = safeSellAmountInput(share);
        } else {
          amt.value = tok > 0 ? String(tok * p) : '0';
        }
      }
    } else {
      amt.value = raw === 'max' ? WALLET.sol.toFixed(4) : Number(raw).toFixed(4);
    }
    for (const x of Array.from(must('#t-quick').children)) x.classList.toggle('on', x === b);
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
    toast('LOOKING UP ' + h);
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
  if (crossChain(c)) {
    void connectWallet(c.net ?? 'SOL');
    return;
  }
  const amount = parseFloat(must<HTMLInputElement>('#t-amt').value) || 0;
  if (amount <= 0) return;
  if (api.mode === 'live' && (!c.tradeable || c.lane === 'grad')) {
    toast(
      c.lane === 'grad'
        ? 'GRADUATED — DEX TRADES NOT WIRED ON STAGING'
        : 'NOT TRADEABLE YET — PROGRAMS NOT DEPLOYED / NO ON-CHAIN MINT',
      'red',
    );
    return;
  }
  const buy = TV.side === 'BUY';
  if (SET.confirm) {
    const label =
      (buy ? 'BUY ' : 'SELL ') +
      amount +
      ' ' +
      (buy ? nativeUnit() : c.sym) +
      ' OF $' +
      c.sym +
      '?';
    if (!window.confirm(label)) {
      toast('ORDER CANCELLED', 'red');
      return;
    }
  }
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
  go.textContent = hasSession(c.net ?? WALLET.net)
    ? 'CONFIRM IN WALLET\u2026'
    : 'SIGN IN WALLET\u2026';
  try {
    const q = await api.quote({ coin: c, side: buy ? 'buy' : 'sell', amountIn: amount });
    if (q.indicative) {
      throw new Error('indicative_only');
    }
    go.textContent = 'CONFIRM IN WALLET\u2026';
    // The fill only renders below once this resolves — a real confirmed
    // Solana signature or every step of a Robinhood plan, never the instant
    // local mutation the sim used to do. `plan step 95`
    await api.trade(q);
  } catch (err) {
    go.disabled = api.mode === 'live' && (!c.tradeable || c.lane === 'grad');
    go.textContent = restoreLabel;
    if (err instanceof SignerCancelledError) toast('SIGNING CANCELLED', 'red');
    else if (isRejection(err)) toast(describeWalletError(err), 'red');
    else {
      const code = err instanceof LiveApiError ? err.code : '';
      const msg = String(err instanceof Error ? err.message : err);
      if (
        code === 'not_tradeable' ||
        msg.includes('indicative_only') ||
        msg.includes('not_tradeable')
      ) {
        toast('ORDER BLOCKED — FIXTURE TOKEN. OPEN A LIVE-CURVE TOKEN TO TRADE.', 'red');
      } else if (code === 'jupiter_alt_required' || msg.includes('jupiter_alt_required')) {
        toast('JUPITER ROUTE NEEDS ADDRESS LOOKUP TABLES — NOT SUPPORTED ON STAGING YET.', 'red');
      } else if (code === 'graduated_not_supported' || msg.includes('graduated_not_supported')) {
        toast('GRADUATED — TRADE ON THE DEX; STONKZ CURVE PREPARE IS CLOSED.', 'red');
      } else if (code === 'rh_router_required' || msg.includes('rh_router_required')) {
        toast(
          'ATOMIC ROUTER REQUIRED — PIN RH_ROUTER / V3 FEE TIER. NON-ATOMIC TRADES DISABLED.',
          'red',
        );
      } else {
        toast(describeWalletError(err), 'red');
      }
    }
    return;
  }
  go.disabled = false;
  go.textContent = restoreLabel;

  const simSuffix = api.mode !== 'live' || isPracticeSession() ? ' ' + DOT + ' SIMULATED' : '';
  toast(
    (buy ? 'Your buy order for ' : 'Your sell order for ') +
      amount.toFixed(2) +
      ' ' +
      (buy ? nativeUnit() : c.sym) +
      ' of $' +
      c.sym +
      ' was successful' +
      simSuffix,
  );
  if (realized !== null) {
    toast(
      (realized >= 0 ? 'You locked +' : 'You realized -') + usd(Math.abs(realized)),
      realized >= 0 ? 'gold' : 'red',
    );
  }
  const tp = $('#tradePnl');
  const gb = go.getBoundingClientRect();
  if (tp && !reducedMotion()) {
    tp.classList.remove('filled');
    reflow(tp);
    tp.classList.add('filled');
  }
  burst(gb.left + 8, gb.top + 3, Math.max(8, gb.height - 6), { n: 24, green: true, spread: 1.3 });
  addChat(roomOf(c), {
    who: myDisplayName(),
    col: '#ffa22b',
    text:
      (buy ? 'aped ' : 'sold ') +
      amount.toFixed(2) +
      ' ' +
      nativeUnit().toLowerCase() +
      ' of $' +
      c.sym,
    mine: true,
    wallet: WALLET.full || WALLET.addr,
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
