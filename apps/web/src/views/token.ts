import {
  BUYBACK_SPLIT,
  CB_MS,
  FEE_SPLIT,
  GRAD,
  SUPPLY,
  type NativeUnit,
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
import { NET_INFO, fmtNative, isEvm, nativeUnit as nativeUnitOf, type Net } from '@stonkz/shared';
import {
  fetchChatAccess,
  fetchChatHistory,
  fetchXProfile,
  sendChatMessage,
  SocialApiError,
} from '../api/social.js';
import { api } from '../api/index.js';
import {
  LiveApiError,
  lastTxLink,
  mapHolders,
  mapTradeRow,
  subscribeChatRoom,
  type ApiTradeRow,
  type LiveChatFrame,
} from '../api/live.js';
import { sigKey } from '../api/live-fills.js';
import {
  fetchTokenCandles,
  fetchTokenDetail,
  fetchTokenHolders,
  fetchTokenTrades,
  type TokenDetail,
} from '../api/token-detail.js';
import { dexPoolUrl, explorerAddressUrl, explorerTxUrl } from '../wallet/chain.js';
import { navigate, retitle } from '../app/route.js';
import { SignerCancelledError } from '../app/signer.js';
import { describeWalletError, isPracticeSession, isRejection } from '../wallet/index.js';
import { showView } from '../app/view.js';
import { drawChartMessage, drawTokenChart, fmtSig, type ChartAxis } from '../canvas/chart.js';
import { paintCoinArt } from '../canvas/pix.js';
import { burst } from '../fx/debris.js';
import { toast } from '../fx/toast.js';
import {
  TF_MS,
  TIMEFRAMES,
  aggregateCandles,
  bucketOf,
  defaultTimeframe,
  fillOhlcGaps,
  foldTrade,
  isTimeframe,
  seriesToCandles,
  type Candle,
  type Timeframe,
} from '../lib/candles.js';
import { $, $$, clear, must, reflow } from '../lib/dom.js';
import { ARR, DOT, MID, clock, fmtCurve, fmtSupply, ud } from '../lib/fmt.js';
import { type Html, attr, html, render } from '../lib/html.js';
import { copyText } from '../lib/clipboard.js';
import { displayName, myDisplayName, rememberIdentity } from '../lib/identity.js';
import { reducedMotion } from '../lib/motion.js';
import { canHover } from '../lib/pointer.js';
import { ensureSession, hasSession, sessionWallet } from '../app/session.js';
import {
  type Comment,
  type Holder,
  type SimCoin,
  type Trade,
  holdersOf,
  seedSeries,
  seedTrades,
} from '../state/coins.js';
import { holdOf } from '../state/holdings.js';
import { syncHoldingFromChain, safeSellAmountInput } from '../api/live-holding.js';
import { SET, evmGasPreset, settingsSummary } from '../state/settings.js';
import { NATIVE_PRICE, WALLET, nativeUnit, nativeUsd } from '../state/wallet.js';
import { openStake } from '../modals/stake.js';
import { stakeOf } from '../state/stake.js';
import { composerState, type ChatAccess } from './chat-access.js';
import { stakingSectionHTML } from './fees-staking.js';
import { creatorPanel, creatorPanelHTML } from './fees-creator.js';
import { setChatToken, roomOf, addChat } from './chat.js';
import { netPill, paint } from './board.js';
import { connectWallet } from '../app/wallet.js';
import { commentListHTML, commentsHTML as commentsTabHTML, relTime } from './token-comments.js';
import { holdersTableHTML } from './token-holders.js';
import { fmtNativeAmt, tradesTableHTML } from './token-trades.js';

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
  /** Candles shown; `0` is ALL. */
  range: number;
  cross: number | null;
  qTimer: number;
  /** Drops stale quotes when the live adapter answers out of order. */
  qSeq: number;
  /** Chart bucket. */
  tf: Timeframe;
  /** Price axis: USD, or the coin's own gas unit. */
  axis: 'USD' | 'NATIVE';
}

export const TV: TokenViewState = {
  c: null,
  tab: 'trades',
  side: 'BUY',
  range: 120,
  cross: null,
  qTimer: 0,
  qSeq: 0,
  tf: '1m',
  axis: 'USD',
};

/* ------------------------------- markup ----------------------------------- */

function caLabel(c: SimCoin): string {
  const raw = (c.mint && c.mint.length > 8 ? c.mint : '') || '';
  if (raw) return raw.length > 16 ? raw.slice(0, 6) + '…' + raw.slice(-4) : raw;
  return 'PENDING';
}

/**
 * Graduation as the chain reports it. `lane === 'grad'` only means the cap
 * crossed $69K on the board's math; the curve stays open until the
 * permissionless `graduate` lands (`graduatedAt`). The sim has no chain, so
 * there the lane is the truth.
 */
export function isGraduated(c: SimCoin): boolean {
  if (api.mode !== 'live') return c.lane === 'grad';
  return c.graduatedAt != null;
}

/** The ticket must be off: graduated, or sold out and awaiting `graduate` (buys revert "curve complete"). */
function curveClosed(c: SimCoin): boolean {
  return isGraduated(c) || (api.mode === 'live' && c.curveComplete === true);
}

function tradeHint(c: SimCoin): string {
  if (api.mode !== 'live') return 'ORDERS ARE SIMULATED. NOTHING IS SIGNED, SENT OR SETTLED.';
  if (isGraduated(c)) {
    return c.poolAddress
      ? 'GRADUATED — CURVE TRADING IS CLOSED. TRADE ON ' + NET_INFO[c.net ?? 'SOL'].dex + ' VIA THE POOL LINK BELOW.'
      : 'GRADUATED — CURVE TRADING IS CLOSED. LIQUIDITY IS MIGRATING TO ' + NET_INFO[c.net ?? 'SOL'].dex + '.';
  }
  if (c.curveComplete) {
    return 'CURVE SOLD OUT — AWAITING GRADUATION. ANYONE CAN TRIGGER IT BELOW.';
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

/** The coin's own gas unit — what its fills, quotes and ticket are denominated in. */
function coinUnit(c: SimCoin): NativeUnit {
  return nativeUnitOf(c.net ?? 'SOL');
}

/** Only http(s) links leave the page; anything else is shown as text. */
export function safeUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const v = raw.trim();
  const withScheme = /^https?:\/\//i.test(v)
    ? v
    : /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(v)
      ? 'https://' + v
      : null;
  if (!withScheme) return null;
  try {
    const u = new URL(withScheme);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export function telegramUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const v = raw.trim().replace(/^@/, '');
  if (/^https?:\/\//i.test(v)) return safeUrl(v);
  const handle = v.replace(/^(t\.me|telegram\.me)\//i, '').replace(/[^\w]/g, '');
  return handle ? 'https://t.me/' + handle : null;
}

export function xProfileUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const handle = raw
    .trim()
    .replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '')
    .replace(/^@/, '')
    .replace(/[^\w]/g, '');
  return handle ? 'https://x.com/' + handle : null;
}

function extLink(href: string | null, label: string): Html {
  if (!href) return html``;
  return html`${DOT} <a class="txlink" href="${attr(href)}" target="_blank" rel="noopener noreferrer"
      >${label} ↗</a
    >`;
}

/** Sensible default order size in the coin's unit: the trader's setting when the wallet is on that chain, else a small chain-appropriate default. */
const DEFAULT_BUY: Record<NativeUnit, number> = { SOL: 0.5, ETH: 0.02, USDC: 10 };
/** Gas kept back from MAX so the order plus its fee can still land. */
const GAS_RESERVE: Record<NativeUnit, number> = { SOL: 0.01, ETH: 0.0005, USDC: 0.5 };

function defaultBuyAmount(c: SimCoin): number {
  const u = coinUnit(c);
  const v = u === nativeUnit() ? Number(SET.defBuy) : DEFAULT_BUY[u];
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_BUY[u];
}

/** Up to six decimals, trailing zeros trimmed — what goes into the amount box. */
function fmtInput(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '0';
  return v.toFixed(6).replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
}

function tokenHTML(c: SimCoin): Html {
  const grad = isGraduated(c);
  const unit = coinUnit(c);
  const net = c.net ?? 'SOL';
  const pair = c.base || unit;
  const ca = caLabel(c);
  const caFull = c.mint || '';
  const live = api.mode === 'live';
  return html`<div class="tk-bar">
      <button class="back" id="tk-back">${ARR} BOARD</button
      ><canvas width="128" height="128" aria-hidden="true"></canvas>
      <div class="tk-id">
        <h1>${c.sym}<small>${c.name}</small></h1>
        <div class="sub">
          ${
            c.base
              ? html`PAIR <b>${c.sym}/${c.base}</b> ${DOT} SUPPLY
                  <b>${fmtSupply(c.supply || SUPPLY)}</b
                  ><span id="s-circ-wrap" hidden> ${DOT} CIRC <b id="s-circ">${MID}</b></span> ${DOT} FEE
                  <b>${Number(c.tfee).toFixed(1)}%</b> ${DOT} `
              : ''
          }CA
          ${
            caFull
              ? live
                ? html`<a
                    class="txlink"
                    title="${attr(caFull)}"
                    href="${attr(explorerAddressUrl(net, caFull))}"
                    target="_blank"
                    rel="noopener"
                    >${ca}</a
                  >`
                : html`<b title="${attr(caFull)}">${ca}</b>`
              : html`<b class="dm">${ca}</b>`
          }
          ${DOT} DEV
          <b class="addrlink" data-addr="${attr(c.dev)}"
            >${c.dev.length > 12 ? c.dev.slice(0, 4) + '…' + c.dev.slice(-4) : c.dev}</b
          >
          ${DOT} <span id="s-age" title="${attr(new Date(Date.now() - c.age * 60_000).toISOString())}">${ago(c.age)}</span> ${DOT} ON ${netPill(net)} ${DOT}
          <span class="${grad ? 'gd' : 'up'}" id="s-state">${grad ? 'BONDED' : 'ACTIVE'}</span>
          <span id="s-links"
            >${extLink(safeUrl(c.web), 'WEB')}${extLink(xProfileUrl(c.x), 'X')}${extLink(telegramUrl(c.tg), 'TG')}</span
          >
        </div>
      </div>
      <div class="tk-stats">
        <div><span class="lbl">PRICE</span><span class="v" id="s-px">${px(price(c))}</span></div>
        <div>
          <span class="lbl">MARKET CAP</span><span class="v am" id="s-mc">${usd(c.mc)}</span
          ><span class="sub2" id="s-mcn"></span>
        </div>
        <div>
          <span class="lbl">24H</span><span class="v ${ud(c.chg)}" id="s-chg">${pct(c.chg)}</span>
        </div>
        <div>
          <span class="lbl">VOL 24H</span><span class="v" id="s-vol">${live ? MID : usd(vol24(c))}</span>
        </div>
        <div>
          <span class="lbl">LIQUIDITY</span><span class="v" id="s-liq">${live ? MID : usd(liq(c))}</span
          ><span class="sub2" id="s-liqn"></span>
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
        <div class="pnl-hd chart-hd">
          <h2>Price</h2>
          <span class="sub">${c.sym}/${pair} ${DOT} <span id="ch-tf">${TV.tf.toUpperCase()}</span> CANDLES</span>
          <div class="rt chart-ctl">
            <span class="ctl-group" role="group" aria-label="Timeframe">
              ${TIMEFRAMES.map(
                (tf) =>
                  html`<button type="button" class="tab${tf === TV.tf ? ' on' : ''}" data-tf="${tf}">
                    ${tf.toUpperCase()}
                  </button>`,
              )}
            </span>
            <span class="ctl-group" role="group" aria-label="Price unit">
              <button type="button" class="tab on" data-ax="USD">USD</button
              ><button type="button" class="tab" data-ax="NATIVE">${unit}</button>
            </span>
            <span class="ctl-group" role="group" aria-label="Candles shown">
              <button type="button" class="tab" data-rg="60">60</button
              ><button type="button" class="tab on" data-rg="120">120</button
              ><button type="button" class="tab" data-rg="240">240</button
              ><button type="button" class="tab" data-rg="0">ALL</button>
            </span>
          </div>
        </div>
        <div class="chartbox">
          <canvas id="tchart"></canvas>
          <div class="hud" id="ch-hud"></div>
        </div>
        <div class="curvebar">
          <div class="pt">
            <span>BONDING CURVE</span><b class="am" id="cv-pct">${fmtCurve(curve(c))}</b>
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
              value="${fmtInput(defaultBuyAmount(c))}"
              inputmode="decimal"
            />
          </div>
          <div class="amt-row" id="t-quick"></div>
          <div class="quote" id="t-quote"></div>
          <button
            class="big"
            id="t-go"
            ${api.mode === 'live' && (!c.tradeable || curveClosed(c)) ? ' disabled' : ''}
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

/**
 * Chart state for the open coin: the REST candles for the selected timeframe
 * plus every fill that arrived after them (`c.trades` rows whose signature
 * the REST read did not cover), folded on each draw. Provisional prints stay
 * `pending` (drawn translucent) until their indexed twin clears the flag on
 * the trade row, at which point the fold picks the change up by itself.
 */
interface ChartState {
  /** `sym:mint:tf` the REST candles belong to. */
  key: string;
  rest: Candle[];
  /** Signatures already inside `rest`. */
  restSigs: Set<string>;
  basis: 'spot' | 'indexed' | null;
  loading: boolean;
  failed: boolean;
  /** The `c.trades` array the fold was last built from — a new array means REST re-hydrated. */
  tradesRef: Trade[] | null;
  view: Candle[];
  viewKey: string;
}

function freshChart(key: string): ChartState {
  return {
    key,
    rest: [],
    restSigs: new Set(),
    basis: null,
    loading: false,
    failed: false,
    tradesRef: null,
    view: [],
    viewKey: '',
  };
}

let CH: ChartState = freshChart('');

/** The detail read (`GET /tokens/:sym`) behind the header extras; `null` until it lands. */
let DETAIL: TokenDetail | null = null;
let detailKey = '';
let detailTimer = 0;

function chartKey(c: SimCoin): string {
  return c.sym + ':' + (c.mint ?? '') + ':' + TV.tf;
}

function axisFor(c: SimCoin): ChartAxis {
  if (TV.axis === 'USD') return { unit: 'USD', rate: 1 };
  const unit = coinUnit(c);
  const mark = nativeUsd(unit);
  return { unit, rate: mark > 0 ? 1 / mark : 1 };
}

async function loadChartCandles(c: SimCoin, key: string): Promise<void> {
  CH.loading = true;
  try {
    const res = await fetchTokenCandles(c, TV.tf);
    if (TV.c !== c || CH.key !== key) return;
    CH.rest = res.candles;
    CH.basis = res.basis;
    // Everything the indexer has recorded is in those candles; only prints
    // still ahead of it (pending) and anything that arrives later fold in.
    CH.restSigs = new Set(
      (c.trades ?? []).filter((t) => t.sig && !t.pending).map((t) => sigKey(t.sig as string)),
    );
    CH.tradesRef = c.trades;
    CH.failed = false;
  } catch {
    if (TV.c !== c || CH.key !== key) return;
    CH.failed = true;
  } finally {
    if (TV.c === c && CH.key === key) {
      CH.loading = false;
      CH.viewKey = '';
      drawTChart();
    }
  }
}

/** USD notional of a fill for the volume bars: the API's figure, else size × the native mark. */
function tradeUsd(c: SimCoin, t: Trade): number {
  if (t.usd !== undefined && t.usd > 0) return t.usd;
  return t.sol * nativeUsd(coinUnit(c));
}

function composeLiveCandles(c: SimCoin, bucketMs: number, supply: number, now: number): Candle[] {
  const trades = c.trades ?? [];
  if (CH.tradesRef !== null && CH.tradesRef !== trades && !CH.loading) {
    // REST re-hydrated (reconcile after a dropped provisional print): the
    // authoritative candles may have moved too — re-read them.
    CH.tradesRef = trades;
    void loadChartCandles(c, CH.key);
  }
  let pending = 0;
  for (const t of trades) if (t.pending) pending++;
  const key = [
    CH.rest.length,
    trades.length,
    trades[0]?.sig ?? '',
    pending,
    bucketOf(now, bucketMs),
    c.mc,
  ].join('|');
  if (key === CH.viewKey) return CH.view;
  const out: Candle[] = CH.rest.map((k) => ({ ...k }));
  // Oldest first so opens carry forward correctly.
  for (let i = trades.length - 1; i >= 0; i--) {
    const t = trades[i] as Trade;
    if (!t.sig || CH.restSigs.has(sigKey(t.sig))) continue;
    foldTrade(
      out,
      { t: t.t.getTime(), price: t.mc / supply, usd: tradeUsd(c, t), pending: t.pending },
      bucketMs,
    );
  }
  CH.view = fillOhlcGaps(out, bucketMs, now);
  CH.viewKey = key;
  return CH.view;
}

export function drawTChart(): void {
  const c = TV.c;
  if (!c) return;
  const cvs = $<HTMLCanvasElement>('#tchart');
  if (!cvs) return;
  const hud = $('#ch-hud');
  const bucketMs = TF_MS[TV.tf];
  const supply = c.supply || SUPPLY;
  const now = Date.now();
  let candles: Candle[];
  if (api.mode === 'sim') {
    seedSeries(c);
    const one = seriesToCandles(c.h ?? [], c.hv ?? [], supply, bucketOf(now, 60_000), 60_000);
    candles = bucketMs === 60_000 ? one : aggregateCandles(one, bucketMs);
  } else {
    const key = chartKey(c);
    if (CH.key !== key) CH = freshChart(key);
    if (c.trades === null) {
      // `api.watchToken()` has not answered yet; its `.then` redraws.
      drawChartMessage(cvs, 'LOADING CANDLES…');
      render(hud, html`<span class="dm">LOADING</span>`);
      return;
    }
    if (CH.basis === null && !CH.loading && !CH.failed) void loadChartCandles(c, key);
    if (CH.loading && CH.rest.length === 0) {
      drawChartMessage(cvs, 'LOADING CANDLES…');
      render(hud, html`<span class="dm">LOADING ${TV.tf.toUpperCase()} CANDLES</span>`);
      return;
    }
    candles = composeLiveCandles(c, bucketMs, supply, now);
    if (candles.length === 0) {
      drawChartMessage(cvs, CH.failed ? 'CANDLES UNAVAILABLE' : 'NO CANDLE HISTORY YET');
      render(
        hud,
        html`<span class="dm">${CH.failed ? 'COULD NOT LOAD CANDLES' : 'WAITING FOR FIRST PRINT'}</span>`,
      );
      return;
    }
  }
  const out = drawTokenChart(cvs, {
    candles,
    range: TV.range > 0 ? TV.range : Infinity,
    cross: TV.cross,
    bucketMs,
    axis: axisFor(c),
    supply,
    vol24Usd: api.mode === 'live' ? (DETAIL?.vol24Usd ?? null) : vol24(c),
  });
  if (out) render(hud, out);
}

/** `GET /tokens/:sym` for the header extras; debounced so a burst of fills asks once. */
function refreshDetail(c: SimCoin, delayMs = 0): void {
  if (api.mode !== 'live') return;
  const key = c.sym + ':' + (c.mint ?? '');
  window.clearTimeout(detailTimer);
  detailTimer = window.setTimeout(() => {
    void fetchTokenDetail(c)
      .then((d) => {
        if (TV.c !== c) return;
        DETAIL = d;
        detailKey = key;
        syncToken();
        drawTChart();
      })
      .catch(() => undefined);
  }, delayMs);
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
  const feePct = feeHop && feeHop.feeBps > 0 ? feeHop.feeBps / 100 : q.effFeePct;
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
      ><b>${slip.toFixed(1)}% ${DOT} ${feePct.toFixed(1)}% ${DOT} ${fmtNativeAmt(feeNative)} ${feeUnit}</b>
    </div>
    ${feeSplitRow(feeNative, feeUnit)}
    <div class="qrow">
      <span>NETWORK</span
      ><b
        >${
          isEvm(c.net ?? WALLET.net)
            ? nativeUnitOf(c.net ?? WALLET.net) + ' GAS ' + evmGasPreset() + ' · PRIO/MEV N/A ON ' + NET_INFO[c.net ?? WALLET.net].name
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

/**
 * Where this order's curve fee goes — the 69 / 15 / 10 / 6 split both
 * programs assert on every fill (`FEE_SPLIT`), sized in the fee's own unit.
 */
function feeSplitRow(feeNative: number, unit: string): Html {
  if (!(feeNative > 0)) return html``;
  const leg = (share: number): string => fmtNativeAmt(feeNative * share);
  return html`<div class="qrow qsplit">
    <span>FEE SPLIT</span
    ><b
      ><span class="gd" title="Creator bucket, shared with stakers"
        >CREATOR ${(FEE_SPLIT.creatorBucket * 100).toFixed(0)}% ${leg(FEE_SPLIT.creatorBucket)}</span
      >
      ${DOT}
      <span title="Platform">PLATFORM ${(FEE_SPLIT.protocol * 100).toFixed(0)}% ${leg(FEE_SPLIT.protocol)}</span>
      ${DOT}
      <span title="$STONKZ buyback">BUYBACK ${(FEE_SPLIT.buyback * 100).toFixed(0)}% ${leg(FEE_SPLIT.buyback)}</span>
      ${DOT}
      <span title="RWA crate fund">RWA ${(FEE_SPLIT.rwa * 100).toFixed(0)}% ${leg(FEE_SPLIT.rwa)}</span>
      <span class="dm">${unit}</span></b
    >
  </div>`;
}

/** Buy quick picks in the coin's gas unit: fractions of SOL/ETH, whole USDC under the Arc cap. */
function quickPicks(c: SimCoin): number[] {
  const info = NET_INFO[c.net ?? 'SOL'];
  if (info.unit === 'USDC') return [1, 5, 10, Math.min(25, info.maxTradeUsd ?? 25)];
  return info.unit === 'ETH' ? [0.01, 0.05, 0.1, 0.5] : [0.1, 0.5, 1, 5];
}

function quoteErrorText(err: unknown): string {
  if (err instanceof LiveApiError) {
    if (err.code === 'rate_limited') return 'TOO MANY QUOTES — HOLD ON A SECOND';
    return (err.message || err.code).toUpperCase();
  }
  return err instanceof Error ? err.message.toUpperCase() : String(err);
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
    if (api.mode === 'live') go.disabled = !c.tradeable || curveClosed(c);
  }

  const cap = NET_INFO[c.net ?? 'SOL'].maxTradeUsd;
  const capUsd = buy && cap !== undefined ? amount * NATIVE_PRICE.usd : 0;
  if (!(amount > 0)) {
    render(
      $('#t-quote'),
      html`<div class="qrow"><span>QUOTE</span><b class="dm">ENTER AN AMOUNT</b></div>`,
    );
    if (go && api.mode === 'live') go.disabled = true;
  } else if (cap !== undefined && capUsd > cap) {
    // Arc is real money: the same $25 ceiling the API and the router enforce,
    // shown before a quote is even asked for.
    render(
      $('#t-quote'),
      html`<div class="qrow">
        <span>QUOTE</span><b class="dn">MAX $${cap} PER TRADE ON ${NET_INFO[c.net ?? 'SOL'].short}</b>
      </div>`,
    );
    if (go) go.disabled = true;
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
          goBtn.disabled = !c.tradeable || curveClosed(c) || !!q.indicative;
        }
      })
      .catch((err: unknown) => {
        render(
          $('#t-quote'),
          html`<div class="qrow"><span>QUOTE</span><b class="dn">${quoteErrorText(err)}</b></div>`,
        );
      });
  }
  const lbl = $('#t-amt-lbl');
  if (lbl) {
    lbl.textContent = buy ? 'AMOUNT (' + coinUnit(c) + ')' : 'AMOUNT (' + c.sym + ')';
  }
  // Quick picks: native units on buy, % of position on sell.
  const quick = $('#t-quick');
  if (quick) {
    if (buy) {
      render(
        quick,
        html`${quickPicks(c).map((x) => html`<button type="button" class="qa" data-a="${attr(x)}">${x}</button>`)}<button
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
        ? html`<span>BALANCE <b class="am">${fmtNative(WALLET.net, WALLET.sol)} ${nativeUnit()}</b></span
            ><span>PAIR ${c.base || coinUnit(c)} ${DOT} ${WALLET.addr}</span>`
        : html`<span class="dm">NO WALLET CONNECTED</span
            ><span class="dm"
              >${api.mode === 'live' ? 'CONNECT TO TRADE' : 'SIM FILLS ONLY'}</span
            >`,
    );
  }
}

/* --------------------------------- tabs ----------------------------------- */

/** Older-page cursor state for the trades tab, reset on open. */
const TR = { hasMore: false, loading: false, nextBefore: undefined as number | undefined };
/** Holders tab state, reset on open. */
const HD = {
  shown: 25,
  loading: false,
  refreshing: false,
  source: null as 'explorer' | 'rpc' | 'db' | null,
  holderCount: null as number | null,
  /** Distinct fills seen when holders were last read; a new one schedules a refresh. */
  fillsAtRead: -1,
  timer: 0,
};

/** A wallet's label: username when known, else the short address. Short labels pass through. */
function nameOf(wallet: string): string {
  return displayName(wallet);
}

function distinctFills(c: SimCoin): number {
  const seen = new Set<string>();
  for (const t of c.trades ?? []) if (t.sig) seen.add(sigKey(t.sig));
  return seen.size;
}

function tradesHTML(c: SimCoin): Html {
  return tradesTableHTML({
    trades: c.trades ?? [],
    net: c.net ?? 'SOL',
    supply: c.supply || SUPPLY,
    live: api.mode === 'live',
    now: Date.now(),
    txUrl: (sig) => explorerTxUrl(c.net ?? 'SOL', sig),
    nameOf,
    hasMore: api.mode === 'live' && TR.hasMore,
    loading: api.mode === 'live' && (c.trades === null || TR.loading),
  });
}

/** Older fills from REST, appended behind what the socket keeps fresh. */
async function loadOlderTrades(c: SimCoin): Promise<void> {
  if (TR.loading || !c.trades) return;
  const oldest = [...c.trades].reverse().find((t) => t.id !== undefined);
  const before = TR.nextBefore ?? oldest?.id;
  if (before === undefined) {
    TR.hasMore = false;
    renderTab();
    return;
  }
  TR.loading = true;
  renderTab();
  try {
    const page = await fetchTokenTrades<ApiTradeRow>(c, { before, limit: 40 });
    if (TV.c !== c || !c.trades) return;
    const known = new Set(c.trades.map((t) => (t.sig ? sigKey(t.sig) : '')));
    for (const r of page.trades) {
      const t = mapTradeRow(c, r);
      if (t.sig && known.has(sigKey(t.sig))) continue;
      c.trades.push(t);
    }
    TR.hasMore = !!page.hasMore;
    TR.nextBefore = page.nextBefore;
  } catch (err) {
    toast('COULD NOT LOAD OLDER TRADES ' + DOT + ' ' + String(err), 'red');
  } finally {
    TR.loading = false;
    if (TV.c === c && TV.tab === 'trades') renderTab();
  }
}

function holdersHTML(c: SimCoin): Html {
  // Live mode: only show API holders (or empty). Never invent wallets.
  // Sim mode: synthetic `holdersOf` until/unless live rows exist.
  const live = api.mode === 'live';
  const rows: Holder[] = live ? (c.liveHolders ?? []) : (c.liveHolders ?? holdersOf(c));
  return holdersTableHTML({
    rows,
    mc: c.mc,
    supply: c.supply || SUPPLY,
    shown: HD.shown,
    live,
    holderCount: live ? (HD.holderCount ?? c.hold) : null,
    source: live ? HD.source : null,
    nameOf,
    loading: live && c.liveHolders == null,
    refreshing: HD.refreshing,
  });
}

/** Re-read holders from chain after a fill (the explorer lags a few seconds) or on demand. */
async function refreshHolders(c: SimCoin): Promise<void> {
  if (api.mode !== 'live' || HD.refreshing) return;
  HD.refreshing = true;
  if (TV.tab === 'holders') renderTab();
  try {
    const res = await fetchTokenHolders<Parameters<typeof mapHolders>[1][number]>(c, 100);
    if (TV.c !== c) return;
    c.liveHolders = mapHolders(c, res.holders, res.curveWallet);
    HD.source = res.source ?? null;
    HD.holderCount = typeof res.holderCount === 'number' ? res.holderCount : null;
    if (HD.holderCount !== null) c.hold = HD.holderCount;
    HD.fillsAtRead = distinctFills(c);
    paint(c);
    syncToken();
  } catch {
    // Keep what we have; the footer still says where it came from.
  } finally {
    HD.refreshing = false;
    if (TV.c === c && TV.tab === 'holders') renderTab();
  }
}

/** Called on every beat: a fill the holders read has not seen schedules one refresh. */
function holdersFollowFills(c: SimCoin): void {
  if (api.mode !== 'live' || !c.trades) return;
  const n = distinctFills(c);
  if (HD.fillsAtRead < 0) {
    HD.fillsAtRead = n;
    return;
  }
  if (n <= HD.fillsAtRead || HD.timer) return;
  HD.timer = window.setTimeout(() => {
    HD.timer = 0;
    if (TV.c === c) void refreshHolders(c);
  }, 4000);
}

/* ------------------------------- comments --------------------------------- */

const COMMENT_MAX_LEN = 140;
let commentUnsub: (() => void) | null = null;
let commentsLoadedFor: string | null = null;
let commentAccess: ChatAccess | null = null;
let commentReplyTo: string | null = null;

function commentRoomNet(c: SimCoin): Net {
  return c.net ?? 'SOL';
}

/** What the composer may do here: the chat room's own gates, plus the wallet being on the coin's chain. */
function commentGate(c: SimCoin): { canPost: boolean; note: string | null } {
  if (api.mode !== 'live') return { canPost: true, note: null };
  if (!WALLET.on) return { canPost: false, note: 'CONNECT A WALLET TO COMMENT.' };
  if (crossChain(c)) {
    return {
      canPost: false,
      note: 'SWITCH YOUR WALLET TO ' + NET_INFO[c.net ?? 'SOL'].name + ' TO COMMENT ON THIS COIN.',
    };
  }
  const st = composerState({
    room: c.sym.toUpperCase(),
    live: true,
    walletOn: WALLET.on,
    access: commentAccess,
  });
  if (st.mode === 'loading') return { canPost: false, note: 'CHECKING WHO CAN POST…' };
  return { canPost: !st.disabled, note: st.notice };
}

function commentsHTML(c: SimCoin): Html {
  const gate = commentGate(c);
  return commentsTabHTML({
    list: api.mode === 'live' ? c.comments : (c.comments ?? []),
    now: Date.now(),
    canPost: gate.canPost,
    gateNote: gate.note,
    nameOf,
    replyTo: commentReplyTo,
    maxLen: COMMENT_MAX_LEN,
  });
}

/** Repaint the list only, so a live message never wipes what is being typed. */
function paintCommentList(c: SimCoin): void {
  const l = $('#cmt-list');
  if (!l) {
    if (TV.tab === 'comments') renderTab();
    return;
  }
  const stick = l.scrollHeight - l.scrollTop - l.clientHeight < 40;
  render(
    l,
    commentListHTML({
      list: c.comments,
      now: Date.now(),
      canPost: commentGate(c).canPost,
      nameOf,
    }),
  );
  if (stick) l.scrollTop = l.scrollHeight;
}

function pushComment(c: SimCoin, m: Comment): boolean {
  if (!c.comments) c.comments = [];
  // Dedupe the WS echo of our own POST: by server id, else by wallet + text
  // inside a few seconds.
  const dup = c.comments.some(
    (x) =>
      (m.id !== undefined && x.id === m.id) ||
      (x.who === m.who &&
        x.text === m.text &&
        (m.at === undefined || x.at === undefined ? x.t === m.t : Math.abs(x.at - m.at) < 5000)),
  );
  if (dup) return false;
  c.comments.push(m);
  c.reps = c.comments.length;
  return true;
}

function commentFromWire(
  net: Net,
  m: { id?: number; wallet: string; text: string; createdAtMs: number },
): Comment {
  return {
    who: m.wallet,
    t: clock(new Date(m.createdAtMs)),
    at: m.createdAtMs,
    ...(m.id !== undefined ? { id: m.id } : {}),
    text: m.text,
    mine: m.wallet === sessionWallet(net) || m.wallet === WALLET.full,
  };
}

async function loadLiveComments(c: SimCoin): Promise<void> {
  const net = commentRoomNet(c);
  const room = c.sym.toUpperCase();
  const key = net + ':' + room;
  if (commentsLoadedFor === key && c.comments) return;
  commentsLoadedFor = key;
  c.comments = null;
  commentAccess = null;
  if (TV.c === c && TV.tab === 'comments') renderTab();

  commentUnsub?.();
  commentUnsub = null;

  const [history, access] = await Promise.all([
    fetchChatHistory(net, room).catch(() => null),
    WALLET.on ? fetchChatAccess(net, room).catch(() => null) : Promise.resolve(null),
  ]);
  if (TV.c !== c) return;
  commentAccess = access;
  c.comments = (history?.messages ?? []).map((m) => {
    if (m.username || m.avatarUrl) {
      rememberIdentity(m.wallet, {
        username: m.username ?? null,
        avatarUrl: m.avatarUrl ?? null,
      });
    }
    return commentFromWire(net, m);
  });
  c.reps = c.comments.length;

  commentUnsub = subscribeChatRoom(net, room, (msg: LiveChatFrame) => {
    if (TV.c !== c) return;
    if (msg.username || msg.avatarUrl) {
      rememberIdentity(msg.wallet, {
        username: msg.username ?? null,
        avatarUrl: msg.avatarUrl ?? null,
      });
    }
    if (!pushComment(c, commentFromWire(net, msg))) return;
    paint(c);
    if (TV.tab === 'comments') paintCommentList(c);
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
    // The viewer's own position rides along when a wallet is signed in; the
    // indexer row is enough here (the stake dialog reads the chain).
    const [f] = await Promise.all([
      api.tokenFees(c),
      api.mode === 'live' && WALLET.on && api.hydrateStake ? api.hydrateStake(c.sym) : undefined,
    ]);
    if (TV.c !== c || TV.tab !== 'fees') return;
    render(b, feesHTML(f));
    $('#fc-claim')?.addEventListener('click', () => void claimCreatorFeesHere(c));
  } catch (err) {
    if (TV.c !== c || TV.tab !== 'fees') return;
    render(b, html`<div class="pnl-bd"><p class="hint dn">FEE LEDGER UNAVAILABLE: ${String(err)}</p></div>`);
  }
}

/**
 * The Fees tab's CLAIM: one `claimCreatorFees` / `claim_creator_fees` for this
 * coin, then the ledger is re-read so the panel shows the drained balance.
 */
async function claimCreatorFeesHere(c: SimCoin): Promise<void> {
  const btn = $<HTMLButtonElement>('#fc-claim');
  if (btn) btn.disabled = true;
  try {
    const res = await api.claimCreatorFees(c.sym);
    const tokens = res.tokens[c.sym] ?? 0;
    if (res.native <= 0 && tokens <= 0) {
      toast('NOTHING TO CLAIM YET');
      return;
    }
    const parts = [
      res.native > 0 ? res.native.toFixed(6) + ' ' + (c.base || nativeUnit()) : '',
      tokens > 0 ? num(tokens) + ' ' + c.sym : '',
    ].filter(Boolean);
    toast('CLAIMED ' + parts.join(' + '), 'gold');
  } catch (err) {
    if (err instanceof SignerCancelledError || isRejection(err)) {
      toast('CLAIM CANCELLED');
    } else {
      toast(err instanceof Error ? describeWalletError(err).toUpperCase() : 'CLAIM FAILED', 'red');
    }
  } finally {
    if (btn) btn.disabled = false;
    if (TV.c === c && TV.tab === 'fees') void loadFees(c);
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
  const toCrates = f.totals.buyback * BUYBACK_SPLIT.crates + f.totals.rwa;
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
        <div class="lbl">TO CRATES</div>
        <div class="val gd">${usdOf(toCrates)}</div>
        <span class="hint">HALF THE $STONKZ BUYBACK + THE RWA FUND</span>
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
          ${row('PLATFORM', pctOf(f.totals.protocol), f.totals.protocol, (f.split.protocol * 100).toFixed(0) + '% OF EVERY TAX')}
          ${row('$STONKZ BUYBACK', pctOf(f.totals.buyback), f.totals.buyback, (f.split.buyback * 100).toFixed(0) + '% ' + DOT + ' HALF TO CRATES, HALF BURNED', 'gd')}
          ${row('RWA CRATE FUND', pctOf(f.totals.rwa), f.totals.rwa, (f.split.rwa * 100).toFixed(0) + '% ' + DOT + ' BUYS REAL-WORLD ASSETS FOR CRATES', 'up')}
          ${f.totals.referrals > 0 ? row('REFERRALS', pctOf(f.totals.referrals), f.totals.referrals, 'PAID FROM THE PLATFORM LEG ' + DOT + ' 15 / 10 / 5%', 'dm') : ''}
        </tbody>
      </table>
    </div>
    ${creatorPanelHTML(creatorPanel({ fees: f, viewer: WALLET.on ? WALLET.full : '', nat }), f.sym)}
    ${
      f.staking
        ? stakingSectionHTML({
            sym: f.sym,
            unit: u,
            pool: f.staking,
            viewer: WALLET.on ? stakeOf(f.sym) : null,
            nat,
            now: Date.now(),
          })
        : ''
    }
    <p class="hint">
      ${
        f.source === 'chain'
          ? 'SETTLED ON CHAIN ON EVERY FILL AND READ BACK FROM THE INDEXER. REFERRAL COMMISSIONS (15 / 10 / 5%) ARE PAID FROM THE PLATFORM LEG.'
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
        if ((e.target as Element | null)?.closest('.addrlink, a')) return;
        toggle();
      });
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle();
        }
      });
    });
    $('#tr-more')?.addEventListener('click', () => void loadOlderTrades(c));
  }
  if (TV.tab === 'holders') {
    $('#hold-more')?.addEventListener('click', () => {
      HD.shown = Number.MAX_SAFE_INTEGER;
      renderTab();
    });
    $('#hold-refresh')?.addEventListener('click', () => void refreshHolders(c));
    // First open in live mode with only the hydrate snapshot: the API source
    // and the count footer come from a fresh read.
    if (api.mode === 'live' && HD.source === null && !HD.refreshing && c.liveHolders != null) {
      void refreshHolders(c);
    }
  }
  if (TV.tab === 'comments') {
    if (api.mode === 'live') void loadLiveComments(c);
    $('#cmt-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      void postComment(c);
    });
    b.querySelectorAll<HTMLElement>('.cmt-reply').forEach((btn) => {
      btn.addEventListener('click', () => {
        commentReplyTo = btn.dataset['reply'] ?? null;
        renderTab();
        const input = $('#cmt-in') as HTMLInputElement | null;
        if (input) {
          input.focus();
          input.setSelectionRange(input.value.length, input.value.length);
        }
      });
    });
    if (commentReplyTo) {
      const input = $('#cmt-in') as HTMLInputElement | null;
      if (input && !input.value.startsWith('@')) commentReplyTo = null;
    }
  }
}

/** Human copy for a `POST /chat` refusal. */
function commentErrorText(err: unknown): string {
  const code = err instanceof SocialApiError ? err.code : '';
  switch (code) {
    case 'rate_limited':
      return 'SLOW DOWN ' + DOT + ' TOO MANY COMMENTS, TRY AGAIN IN A MOMENT';
    case 'too_long':
      return 'COMMENTS ARE ' + COMMENT_MAX_LEN + ' CHARACTERS MAX';
    case 'empty':
      return 'TYPE SOMETHING FIRST';
    case 'net_mismatch':
      return 'YOUR WALLET IS ON ANOTHER CHAIN ' + DOT + ' SWITCH TO COMMENT HERE';
    case 'volume_required':
      return 'TRADE $100 ON THE CURVE TO UNLOCK COMMENTS';
    case 'holder_required':
      return 'HOLD THIS COIN TO COMMENT';
    case 'unauthorized':
      return 'SIGN IN WITH YOUR WALLET TO COMMENT';
    default:
      return err instanceof Error ? err.message.toUpperCase() : String(err);
  }
}

async function postComment(c: SimCoin): Promise<void> {
  const input = $('#cmt-in') as HTMLInputElement | null;
  const v = input?.value.trim();
  if (!input || !v) return;
  if (v.length > COMMENT_MAX_LEN) {
    toast('COMMENTS ARE ' + COMMENT_MAX_LEN + ' CHARACTERS MAX', 'red');
    return;
  }

  if (api.mode !== 'live') {
    if (!c.comments) c.comments = [];
    c.comments.push({
      who: WALLET.full || WALLET.addr || myDisplayName(),
      t: 'now',
      at: Date.now(),
      text: v,
      mine: true,
    });
    c.reps = c.comments.length;
    paint(c);
    input.value = '';
    commentReplyTo = null;
    renderTab();
    return;
  }

  if (!WALLET.on) {
    toast('CONNECT A WALLET TO COMMENT');
    return;
  }
  if (crossChain(c)) {
    toast('SWITCH YOUR WALLET TO ' + NET_INFO[c.net ?? 'SOL'].short + ' TO COMMENT', 'red');
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
      toast('COMMENT FLAGGED BY MODERATION ' + DOT + ' NOT POSTED', 'red');
    } else if (res.message) {
      pushComment(c, commentFromWire(net, { ...res.message, wallet: sessionWallet(net) || WALLET.full }));
      paint(c);
    }
    input.value = '';
    commentReplyTo = null;
    renderTab();
    const l = $('#cmt-list');
    if (l) l.scrollTop = l.scrollHeight;
  } catch (err) {
    toast(commentErrorText(err), 'red');
    if (err instanceof SocialApiError && err.code !== 'rate_limited') {
      // The gate may have changed (e.g. the wallet's net); re-read it.
      void fetchChatAccess(net, room)
        .then((a) => {
          if (TV.c !== c) return;
          commentAccess = a;
          if (TV.tab === 'comments') renderTab();
        })
        .catch(() => undefined);
    }
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
  const net = c.net ?? 'SOL';
  if (isGraduated(c)) {
    // `poolAddress` lands with `LiquidityMigrated`, a second transaction on
    // EVM (authority-gated) — until then the honest link is the mint itself.
    render(
      n,
      c.poolAddress
        ? html`GRADUATED ${MID} LIQUIDITY MIGRATED TO ${NET_INFO[net].dex} AND ${NET_INFO[net].lpNote}.
            <a
              class="txlink"
              href="${attr(dexPoolUrl(net, c.poolAddress))}"
              target="_blank"
              rel="noopener"
              >OPEN ${NET_INFO[net].dex} POOL ↗</a
            >`
        : html`GRADUATED ${MID} THE CURVE IS CLOSED. LIQUIDITY IS MIGRATING TO ${NET_INFO[net].dex},
            WHERE ${NET_INFO[net].lpNote.replace(/ (WERE|IS) /, ' WILL BE ')}.
            ${
              c.mint && api.mode === 'live'
                ? html` <a
                    class="txlink"
                    href="${attr(explorerAddressUrl(net, c.mint))}"
                    target="_blank"
                    rel="noopener"
                    >VIEW TOKEN ON EXPLORER ↗</a
                  >`
                : ''
            }`,
    );
  } else if (api.mode === 'live' && c.graduationReady) {
    // The threshold is met but nobody has called the permissionless
    // `graduate` yet. Offer it to whoever is looking.
    render(
      n,
      html`${c.curveComplete ? 'CURVE SOLD OUT' : usd(GRAD) + ' MARKET CAP REACHED'} ${MID}
        READY TO GRADUATE. GRADUATION IS PERMISSIONLESS: ANY WALLET CAN TRIGGER IT, LIQUIDITY THEN
        MIGRATES TO ${NET_INFO[net].dex} AND ${NET_INFO[net].lpNote.replace(/ (WERE|IS) /, ' WILL BE ')}.
        <button type="button" class="custbtn" id="cv-graduate">GRADUATE NOW</button>`,
    );
    $('#cv-graduate')?.addEventListener('click', () => void graduateNow(c));
  } else {
    const gradBase =
      DETAIL && DETAIL.graduationBase !== undefined && detailKey === c.sym + ':' + (c.mint ?? '')
        ? html` (${fmtSig(DETAIL.graduationBase)} ${coinUnit(c)})`
        : '';
    render(
      n,
      html`AT ${usd(GRAD)} MARKET CAP${gradBase} THE CURVE FILLS, LIQUIDITY MIGRATES
        (${NET_INFO[net].dex}) AND THE LP LOCKS.
        <b class="am">${usd(Math.max(0, GRAD - c.mc))}</b> TO GO.`,
    );
  }
}

/**
 * "GRADUATE NOW": one signature on the permissionless `graduate`. The
 * indexer flips `graduatedAt` when the event lands; until then the button is
 * disabled so a double-click cannot queue two transactions.
 */
async function graduateNow(c: SimCoin): Promise<void> {
  const btn = $('#cv-graduate') as HTMLButtonElement | null;
  if (btn?.disabled) return;
  if (!WALLET.on) {
    void connectWallet(c.net ?? 'SOL');
    return;
  }
  if (crossChain(c)) {
    toast('SWITCH TO ' + NET_INFO[c.net ?? 'SOL'].short + ' TO GRADUATE', 'red');
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'GRADUATING…';
  }
  try {
    await api.graduate(c);
    toast('GRADUATION SENT ' + MID + ' THE CURVE CLOSES WHEN IT CONFIRMS', 'gold');
    if (btn) btn.textContent = 'GRADUATION SENT';
  } catch (err) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'GRADUATE NOW';
    }
    if (err instanceof SignerCancelledError || isRejection(err)) {
      toast('SIGNING CANCELLED', 'red');
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    const code = err instanceof LiveApiError ? err.code : '';
    if (code === 'already_graduated') toast('ALREADY GRADUATED ' + MID + ' REFRESHING', 'gold');
    else if (code === 'not_graduable') {
      toast('NOT GRADUABLE YET ' + MID + ' THE CHAIN DISAGREES WITH THE BOARD', 'red');
    } else if (code === 'router_upgrade_required') {
      toast('ORACLE GRADUATION NEEDS THE UPGRADED ROUTER ' + MID + ' ASK THE OPERATOR', 'red');
    } else if (err instanceof LiveApiError) {
      toast(('GRADUATE FAILED: ' + msg).toUpperCase(), 'red');
    } else toast(('GRADUATE FAILED: ' + describeWalletError(err)).toUpperCase(), 'red');
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
  const live = api.mode === 'live';
  const detail = live && DETAIL && detailKey === c.sym + ':' + (c.mint ?? '') ? DETAIL : null;
  const unit = coinUnit(c);
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
  // Volume and liquidity are real figures from the detail read in live mode
  // (24h fills; the base the curve actually holds) — never the sim's
  // cap-derived stand-ins on a live coin.
  // An API without the detail extras (older deploy) gets a dash, never a
  // zero or the simulation-era 14%-of-cap figure it still serialises.
  const v24 = detail?.vol24Usd;
  const liqUsd = detail && detail.liqBase !== undefined ? detail.liqUsd : undefined;
  set('#s-vol', live ? (v24 !== undefined ? usd(v24) : MID) : usd(vol24(c)));
  set('#s-liq', live ? (liqUsd !== undefined ? usd(liqUsd) : MID) : usd(liq(c)));
  const mcn = $('#s-mcn');
  if (mcn) {
    const t = detail && detail.mcBase !== undefined ? fmtSig(detail.mcBase) + ' ' + unit : '';
    if (mcn.textContent !== t) mcn.textContent = t;
  }
  const liqn = $('#s-liqn');
  if (liqn) {
    const t = detail && detail.liqBase !== undefined ? fmtSig(detail.liqBase) + ' ' + unit : '';
    if (liqn.textContent !== t) liqn.textContent = t;
  }
  const circWrap = $('#s-circ-wrap');
  if (circWrap && detail && detail.circulating !== undefined) {
    circWrap.hidden = false;
    set('#s-circ', num(detail.circulating));
  }
  set('#s-hold', num(c.hold));
  set('#s-age', ago(c.age));
  const st = $('#s-state');
  if (st) {
    const grad = isGraduated(c);
    st.textContent = grad ? 'BONDED' : c.curveComplete ? 'SOLD OUT' : 'ACTIVE';
    st.className = grad ? 'gd' : 'up';
  }
  syncCashback();
  const p = $('#cv-pct');
  const b = $('#cv-bar');
  if (p) p.textContent = fmtCurve(curve(c));
  if (b) {
    b.style.width = curve(c) + '%';
    b.className = isGraduated(c) ? 'done' : '';
  }
  updateCurveNote();
  // Relative comment times move on their own; the list is not rebuilt for it.
  if (TV.tab === 'comments') {
    const now = Date.now();
    for (const el of $$('#cmt-list [data-at]')) {
      const at = Number(el.dataset['at']);
      const t = relTime(at, now);
      if (el.textContent !== t) el.textContent = t;
    }
  }
  holdersFollowFills(c);
  retitle();
}

/* --------------------------------- open ----------------------------------- */

export function openToken(c: SimCoin): void {
  CH = freshChart('');
  DETAIL = null;
  detailKey = '';
  TR.hasMore = false;
  TR.loading = false;
  TR.nextBefore = undefined;
  HD.shown = 25;
  HD.loading = false;
  HD.refreshing = false;
  HD.source = null;
  HD.holderCount = null;
  HD.fillsAtRead = -1;
  window.clearTimeout(HD.timer);
  HD.timer = 0;
  commentReplyTo = null;
  commentAccess = null;
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
      // A 40-row first page that came back full may have older fills behind it.
      TR.hasMore = (c.trades?.length ?? 0) >= 40;
      HD.fillsAtRead = distinctFills(c);
      paint(c);
      drawTChart();
      if (TV.tab !== 'comments') renderTab();
    });
    refreshDetail(c);
  }
  c.lane = laneOf(c);
  TV.c = c;
  // Keep the address bar on the resolved mint so shares/back stay unambiguous.
  navigate({ view: 'token', sym: c.sym, ...(c.mint ? { mint: c.mint } : {}) }, { replace: true });
  TV.tab = 'trades';
  TV.side = 'BUY';
  TV.range = 120;
  TV.cross = null;
  TV.tf = defaultTimeframe(c.age);
  TV.axis = 'USD';
  const v = must('#tokenView');
  render(v, tokenHTML(c));
  showView('token');
  paintCoinArt($<HTMLCanvasElement>('.tk-bar canvas'), c.seed, c.image, 46);
  updateCurveNote();
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
    if (TV.side === 'BUY') amt.value = fmtInput(defaultBuyAmount(c));
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
    } else if (raw === 'max') {
      // The wallet's balance is in the wallet's unit; MAX only means
      // something when that is the coin's unit, and it keeps gas back.
      const sameUnit = !WALLET.on || nativeUnit() === coinUnit(c);
      const spendable = sameUnit ? Math.max(0, WALLET.sol - GAS_RESERVE[coinUnit(c)]) : 0;
      amt.value = fmtInput(spendable);
    } else {
      amt.value = fmtInput(Number(raw));
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
  for (const b of $$('[data-tf]')) {
    b.addEventListener('click', () => {
      const tf = b.dataset['tf'] ?? '';
      if (!isTimeframe(tf)) return;
      TV.tf = tf;
      for (const x of $$('[data-tf]')) x.classList.toggle('on', x === b);
      const lbl = $('#ch-tf');
      if (lbl) lbl.textContent = tf.toUpperCase();
      drawTChart();
    });
  }
  for (const b of $$('[data-ax]')) {
    b.addEventListener('click', () => {
      TV.axis = b.dataset['ax'] === 'NATIVE' ? 'NATIVE' : 'USD';
      for (const x of $$('[data-ax]')) x.classList.toggle('on', x === b);
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
  if (api.mode === 'live' && (!c.tradeable || curveClosed(c))) {
    toast(
      isGraduated(c)
        ? 'GRADUATED — TRADE ON ' + NET_INFO[c.net ?? 'SOL'].dex + '; THE CURVE IS CLOSED'
        : c.curveComplete
          ? 'CURVE SOLD OUT — AWAITING GRADUATION'
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
      (buy ? coinUnit(c) : c.sym) +
      ' OF $' +
      c.sym +
      '?\n' +
      settingsSummary(c.net ?? WALLET.net);
    if (!window.confirm(label)) {
      toast('ORDER CANCELLED', 'red');
      return;
    }
  }
  const hb = holdOf(c.sym);
  let realized: number | null = null;
  if (!buy && hb && hb.tok > 0) {
    const avg = hb.cost / hb.tok;
    const sold = Math.min(hb.tok, amount);
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
    go.disabled = api.mode === 'live' && (!c.tradeable || curveClosed(c));
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
      } else if (code === 'solana_tx_too_large') {
        toast('THAT JUPITER ROUTE WON\'T FIT ONE TRANSACTION RIGHT NOW — TRY AGAIN OR A SMALLER AMOUNT.', 'red');
      } else if (code === 'graduated_not_supported' || msg.includes('graduated_not_supported')) {
        toast('GRADUATED — TRADE ON THE DEX; STONKZ CURVE PREPARE IS CLOSED.', 'red');
      } else if (code === 'max_trade_usd_exceeded') {
        toast('OVER THE $25 PER-TRADE CAP ON ARC — TRY A SMALLER AMOUNT.', 'red');
      } else if (code === 'cap_exceeded') {
        toast('OVER YOUR TRADE CAP — RAISE IT IN SETTINGS OR TRADE LESS.', 'red');
      } else if (code === 'insufficient_native' || code === 'insufficient_balance') {
        toast('NOT ENOUGH ' + coinUnit(c) + ' FOR THIS ORDER PLUS GAS.', 'red');
      } else if (code === 'slippage_exceeded' || code === 'quote_expired') {
        toast('PRICE MOVED PAST YOUR SLIPPAGE — REQUOTE AND TRY AGAIN.', 'red');
      } else if (code === 'no_route') {
        toast('NO ROUTE FOR THAT PAIR RIGHT NOW — TRY THE NATIVE PAIR.', 'red');
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
  const tx = api.mode === 'live' && !isPracticeSession() ? lastTxLink() : null;
  toast(
    (buy ? 'Your buy order for ' : 'Your sell order for ') +
      amount.toFixed(2) +
      ' ' +
      (buy ? coinUnit(c) : c.sym) +
      ' of $' +
      c.sym +
      ' was successful' +
      simSuffix,
    undefined,
    tx ? { href: tx.url, label: 'VIEW TX' } : undefined,
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
      coinUnit(c).toLowerCase() +
      ' of $' +
      c.sym,
    mine: true,
    wallet: WALLET.full || WALLET.addr,
  });
  if (TV.tab === 'trades') renderTab();
  syncToken();
  renderQuote();
  paint(c);
  refreshDetail(c, 2500);
}

export function closeToken(): void {
  if (TV.c && api.mode === 'live') api.unwatchToken(TV.c.sym);
  clearInterval(TV.qTimer);
  TV.qTimer = 0;
  window.clearTimeout(detailTimer);
  window.clearTimeout(HD.timer);
  HD.timer = 0;
  commentUnsub?.();
  commentUnsub = null;
  commentsLoadedFor = null;
  CH = freshChart('');
  DETAIL = null;
  TV.c = null;
  clear(must('#tokenView'));
  setChatToken(null);
  window.scrollTo(0, 0);
}
