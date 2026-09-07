import {
  FEE_SPLIT,
  GRAD,
  MAJORS,
  STOCKS,
  SUPPLIES,
  type SupplyOption,
  curveMc,
  isTickerTaken,
  normalizeTicker,
  num,
  px,
  usd,
} from '@stonkz/shared';
import { api } from '../api/index.js';
import { navigate } from '../app/route.js';
import { drawLaunchChart } from '../canvas/chart.js';
import { pix } from '../canvas/pix.js';
import { toast } from '../fx/toast.js';
import { $, must } from '../lib/dom.js';
import { DOT, MID, fmtSupply } from '../lib/fmt.js';
import { type Html, attr, html, render } from '../lib/html.js';
import { tickers } from '../state/coins.js';
import { NATIVE_PRICE, WALLET, nativeUnit, netOf } from '../state/wallet.js';
import { addChat } from '../views/chat.js';
import { closeScrim, isOpen, openScrim, refreshScrim, wireBackdrop } from './scrim.js';

/**
 * The three-step launch stepper. `index.html:3725`
 */

interface Draft {
  step: number;
  seed: number;
  name: string;
  tick: string;
  desc: string;
  web: string;
  x: string;
  tg: string;
  base: string;
  tab: 'majors' | 'stocks';
  q: string;
  supply: number;
  fee: number;
  buy: number;
  cashback: boolean;
}

let NEW: Draft = newDefaults();

function newDefaults(): Draft {
  return {
    step: 0,
    seed: Math.floor(Math.random() * 1e6),
    name: 'Copium Reserve',
    tick: 'COPIUM',
    desc: 'bottled hope for the terminally long. one puff and the chart looks fine.',
    web: 'https://ston.kz/copium',
    x: '@copiumreserve',
    tg: 't.me/copiumreserve',
    base: nativeUnit(),
    tab: 'majors',
    q: '',
    supply: 1e9,
    fee: 2,
    buy: 0.5,
    cashback: false,
  };
}

function baseList(): ReadonlyArray<readonly [string, string]> {
  const net = WALLET.net === 'RH' ? 'RH' : 'SOL';
  const list = NEW.tab === 'majors' ? MAJORS[net] : STOCKS;
  const q = NEW.q.trim().toUpperCase();
  if (!q) return list;
  return list.filter((t) => t[0].toUpperCase().indexOf(q) > -1 || t[1].toUpperCase().indexOf(q) > -1);
}

/* --------------------------------- steps ---------------------------------- */

function ncStep1(): Html {
  return html`<div class="det">
      <div><canvas class="av" id="nc-av" width="128" height="128"></canvas
        ><button type="button" class="chip" id="nc-roll" style="width:64px;margin-top:5px;padding:2px 0;text-align:center">REROLL</button></div
      ><div class="rowf" style="align-content:start">
        <div class="nc-field"><span class="lbl">NAME</span><input class="fld" id="f-name" maxlength="28" value="${attr(NEW.name)}"></div
        ><div class="nc-field"><span class="lbl">TICKER</span><input class="fld" id="f-tick" maxlength="10" value="${attr(NEW.tick)}"></div
        ><div class="nc-field" style="grid-column:1/-1"><span class="lbl">DESCRIPTION</span
          ><textarea class="fld" id="f-desc" maxlength="140">${NEW.desc}</textarea></div>
      </div></div>
    <div class="nc-grid">
      <div class="nc-field"><span class="lbl">WEBSITE</span><input class="fld" id="f-web" maxlength="60" value="${attr(NEW.web)}"></div
      ><div class="nc-field"><span class="lbl">X ACCOUNT</span><input class="fld" id="f-x" maxlength="24" value="${attr(NEW.x)}"></div
      ><div class="nc-field"><span class="lbl">TELEGRAM</span><input class="fld" id="f-tg" maxlength="40" value="${attr(NEW.tg)}"></div>
    </div>
    <p class="hint">FIXED SUPPLY ${DOT} MINT AND FREEZE AUTHORITY REVOKED AT DEPLOY ${DOT} LP BURNS AUTOMATICALLY WHEN THE
      CURVE FILLS TO ${usd(GRAD)}.</p>`;
}

function ncStep2(): Html {
  const n = netOf();
  const list = baseList();
  return html`<div>
      <div class="base-hd"><span class="lbl" style="margin:0">BASE TOKEN</span
        ><span class="netbadge"><i class="netdot" style="background:${attr(n.col)}"></i>${n.name}</span
        ><span class="base-tabs"><button type="button" class="tab${NEW.tab === 'majors' ? ' on' : ''}" data-btab="majors">TOP 10</button
          ><button type="button" class="tab${NEW.tab === 'stocks' ? ' on' : ''}" data-btab="stocks">STOCK TOKENS</button></span
        ><input class="base-search" id="f-bq" placeholder="FILTER" value="${attr(NEW.q)}" aria-label="Filter base tokens"></div>
      <div class="base-list" id="baseList">${
        list.length
          ? list.map(
              (t) => html`<button type="button" class="base-opt${NEW.base === t[0] ? ' on' : ''}" data-base="${attr(t[0])}"
                ><span class="bs">${t[0]}</span><span class="bn">${t[1]}</span></button>`,
            )
          : html`<div class="base-empty">NO MATCH ${DOT} CLEAR THE FILTER</div>`
      }</div>
      <p class="hint" style="margin-top:4px">PAIRS AGAINST ${NEW.tab === 'stocks' ? 'A TOKENIZED STOCK' : 'A MAJOR'} ON
        ${n.name} ${DOT} STOCK LIST MIRRORS GECKOTERMINAL TOKENIZED STOCKS.</p></div>
    <div><span class="lbl">TOTAL SUPPLY</span><div class="supply-row">${SUPPLIES.map(
      (sp) => html`<button type="button" class="chipm${NEW.supply === sp[0] ? ' on' : ''}" data-sup="${attr(sp[0])}">${sp[1]}</button>`,
    )}</div></div>
    <div><span class="lbl">TRADING FEE</span><div class="fee-row"
      ><input type="range" id="f-fee" min="1" max="5" step="0.1" value="${attr(NEW.fee)}" aria-label="Trading fee"
      ><span class="fee-val" id="feeVal">${Number(NEW.fee).toFixed(1)}%</span></div>
      <p class="hint">CHARGED ON EVERY TRADE ${DOT} ${(FEE_SPLIT.protocol * 100).toFixed(0)}% TO THE PROTOCOL,
        ${(FEE_SPLIT.creatorBucket * 100).toFixed(0)}% TO YOU AS CREATOR FEES (SHARED WITH YOUR STAKERS) AND
        ${(FEE_SPLIT.stonkzOps * 100).toFixed(0)}% TO $STONKZ OPS.</p></div>`;
}

function ncStep3(): Html {
  return html`<div><canvas class="nc-chart" id="nc-chart"></canvas></div>
    <div class="fee-row"><span class="lbl" style="margin:0;flex:0 0 88px">DEV BUY (${NEW.base})</span
      ><input class="fld r" id="f-buy" style="max-width:120px" value="${attr(Number(NEW.buy).toFixed(2))}" inputmode="decimal"
      ><span class="amt-row" style="flex:1">${[0, 0.5, 1, 2, 5].map(
        (v) => html`<button type="button" class="qa" data-buy="${attr(v)}">${v ? v : 'NONE'}</button>`,
      )}</span></div>
    <div class="nc-stats" id="ncStats"></div>
    <button type="button" class="cb-opt${NEW.cashback ? ' on' : ''}${NEW.buy > 0 ? ' off' : ''}" id="cbOpt"
      ><span class="cb-box"></span><span><span class="cbt">CASHBACK LAUNCH ${DOT} NO DEV BUY</span
      ><span class="cbs">FOR THE FIRST 5 MINUTES THE TRADING FEE STARTS AT 50% AND DECAYS TO ${Number(NEW.fee).toFixed(1)}%.
        EVERY FEE IN THAT WINDOW IS SPENT BUYING ${NEW.tick || 'YOUR TOKEN'} ON THE CHART AND THE ALLOCATION GOES TO YOU.
        AFTER 5 MINUTES FEES ACCRUE IN ${nativeUnit()}.</span></span></button>
    <div class="nc-sum" id="ncSum"></div>
    <p class="hint">YOUR BUY IS THE FIRST TRADE ON THE CURVE. IT SETS THE OPENING PRICE FOR EVERYONE ELSE.</p>`;
}

/* -------------------------------- render ---------------------------------- */

function renderNew(): void {
  const i = NEW.step;
  must('#nc-count').textContent = 'STEP ' + (i + 1) + ' OF 3';
  const body = i === 0 ? ncStep1() : i === 1 ? ncStep2() : ncStep3();
  render(
    must('#createBody'),
    html`${body}<div class="wiz-foot"><span class="wiz-dots">${[0, 1, 2].map(
      (n) => html`<i class="wiz-dot${n === i ? ' on' : n < i ? ' done' : ''}"></i>`,
    )}</span><span class="grow"></span><button type="button" class="wiz-btn" id="nc-back"${i ? '' : ' disabled'}>BACK</button
      ><button type="button" class="wiz-btn go" id="nc-next">${i === 2 ? 'LAUNCH' : 'NEXT'}</button></div>`,
  );
  refreshScrim('#newScrim');

  if (i === 0) {
    pix($<HTMLCanvasElement>('#nc-av'), NEW.seed);
    must('#nc-roll').addEventListener('click', () => {
      NEW.seed = Math.floor(Math.random() * 1e6);
      pix($<HTMLCanvasElement>('#nc-av'), NEW.seed);
    });
    bind('f-name', 'name');
    bind('f-tick', 'tick');
    bind('f-desc', 'desc');
    bind('f-web', 'web');
    bind('f-x', 'x');
    bind('f-tg', 'tg');
  }
  if (i === 1) {
    must('#createBody').addEventListener('click', (e) => {
      const target = e.target as Element | null;
      const t = target?.closest<HTMLElement>('[data-btab]');
      const b = target?.closest<HTMLElement>('[data-base]');
      const sp = target?.closest<HTMLElement>('[data-sup]');
      if (t) {
        NEW.tab = t.dataset['btab'] as Draft['tab'];
        NEW.q = '';
        renderNew();
      } else if (b) {
        NEW.base = b.dataset['base'] as string;
        renderNew();
      } else if (sp) {
        NEW.supply = Number(sp.dataset['sup']);
        renderNew();
      }
    });
    const bq = must<HTMLInputElement>('#f-bq');
    bq.addEventListener('input', () => {
      NEW.q = bq.value;
      const keep = bq.selectionStart ?? bq.value.length;
      renderNew();
      const el = $<HTMLInputElement>('#f-bq');
      if (el) {
        el.focus();
        el.setSelectionRange(keep, keep);
      }
    });
    const fee = must<HTMLInputElement>('#f-fee');
    fee.addEventListener('input', () => {
      NEW.fee = Number(fee.value);
      const v = $('#feeVal');
      if (v) v.textContent = NEW.fee.toFixed(1) + '%';
    });
  }
  if (i === 2) {
    bind('f-buy', 'buy', true);
    must('#f-buy').addEventListener('input', previewBuy);
    must('#createBody').addEventListener('click', (e) => {
      const target = e.target as Element | null;
      const b = target?.closest<HTMLElement>('[data-buy]');
      if (b) {
        NEW.buy = Number(b.dataset['buy']);
        must<HTMLInputElement>('#f-buy').value = NEW.buy.toFixed(2);
        previewBuy();
        return;
      }
      if (target?.closest('#cbOpt')) {
        if ((parseFloat(must<HTMLInputElement>('#f-buy').value) || 0) > 0) {
          toast('SET THE DEV BUY TO 0 TO USE CASHBACK');
          return;
        }
        NEW.cashback = !NEW.cashback;
        previewBuy();
      }
    });
    previewBuy();
  }

  must('#nc-back').addEventListener('click', () => {
    if (NEW.step > 0) {
      NEW.step--;
      renderNew();
    }
  });
  must('#nc-next').addEventListener('click', () => {
    if (NEW.step === 0) {
      const sym = normalizeTicker(NEW.tick);
      if (!sym) {
        toast('PICK A TICKER FIRST');
        return;
      }
      if (isTickerTaken(sym, tickers())) {
        toast('TICKER ' + sym + ' ALREADY EXISTS ' + DOT + ' PICK ANOTHER');
        return;
      }
      NEW.tick = sym;
    }
    if (NEW.step < 2) {
      NEW.step++;
      renderNew();
    } else {
      void doLaunch();
    }
  });
}

function bind(id: string, key: keyof Draft, numeric = false): void {
  const el = $<HTMLInputElement>('#' + id);
  if (!el) return;
  el.addEventListener('input', () => {
    (NEW as unknown as Record<string, unknown>)[key] = numeric ? parseFloat(el.value) || 0 : el.value;
  });
}

function previewBuy(): void {
  const buy = Math.max(0, parseFloat(must<HTMLInputElement>('#f-buy').value) || 0);
  NEW.buy = buy;
  const mc0 = curveMc(0);
  const mc1 = curveMc(buy);
  const sup = NEW.supply;
  const p0 = mc0 / sup;
  const p1 = mc1 / sup;
  const tok = buy > 0 ? (buy * NATIVE_PRICE.usd) / ((p0 + p1) / 2) : 0;
  const pctSup = Math.min(100, (tok / sup) * 100);
  const jump = (mc1 / mc0 - 1) * 100;
  render(
    must('#ncStats'),
    html`<div><div class="lbl">YOU RECEIVE</div><div class="v gd">${num(tok)}</div></div
      ><div><div class="lbl">OF SUPPLY</div><div class="v">${pctSup.toFixed(2)}%</div></div
      ><div><div class="lbl">OPENING MCAP</div><div class="v am">${usd(mc1)}</div></div
      ><div><div class="lbl">PRICE MOVE</div><div class="v ${jump > 0 ? 'up' : 'dm'}">${jump > 0 ? '+' : ''}${jump.toFixed(0)}%</div></div>`,
  );
  const cbEl = $('#cbOpt');
  if (cbEl) {
    if (buy > 0) NEW.cashback = false;
    cbEl.classList.toggle('off', buy > 0);
    cbEl.classList.toggle('on', NEW.cashback && buy <= 0);
  }
  render(
    must('#ncSum'),
    html`<b>${NEW.tick}</b> / ${NEW.base} ${DOT} SUPPLY <b>${fmtSupply(NEW.supply)}</b> ${DOT} FEE
      <b>${Number(NEW.fee).toFixed(1)}%</b> ${DOT}${
        NEW.cashback && buy <= 0
          ? html` <b>CASHBACK</b> ${MID} FEE OPENS AT 50% AND DECAYS FOR 5 MINUTES`
          : html` ENTRY <b>${px(p0)}</b> ${MID} AFTER YOUR BUY <b>${px(p1)}</b>`
      }`,
  );
  drawLaunchChart($<HTMLCanvasElement>('#nc-chart'), { buy, supply: sup, base: NEW.base });
}

/* -------------------------------- launch ---------------------------------- */

async function doLaunch(): Promise<void> {
  const sym = normalizeTicker(NEW.tick) || 'COIN';
  if (isTickerTaken(sym, tickers())) {
    toast('TICKER ' + sym + ' ALREADY EXISTS ' + DOT + ' PICK ANOTHER');
    NEW.step = 0;
    renderNew();
    return;
  }
  const buy = Math.max(0, NEW.buy || 0);
  let xh = (NEW.x || '@' + sym.toLowerCase()).trim();
  if (xh[0] !== '@') xh = '@' + xh.replace(/^@+/, '');
  const cashback = NEW.cashback && buy <= 0;
  const c = await api.launch({
    sym,
    name: NEW.name || 'Untitled Coin',
    desc: NEW.desc || 'no description. pure vibes.',
    supply: NEW.supply as SupplyOption,
    tfee: Number(NEW.fee),
    buy,
    base: NEW.base,
    cashback,
    x: xh,
    web: NEW.web,
    tg: NEW.tg,
  });
  closeLaunch();
  toast(
    cashback
      ? 'DEPLOYED ' + sym + '/' + NEW.base + ' ' + DOT + ' CASHBACK LIVE FOR 5 MINUTES'
      : 'DEPLOYED ' + sym + '/' + NEW.base + ' ' + DOT + ' DEV BUY ' + buy.toFixed(2) + ' ' + DOT + ' SIMULATED',
  );
  addChat('GLOBAL', { sys: true, who: '', text: 'NEW MINT ' + DOT + ' $' + sym + ' / ' + NEW.base + ' ' + DOT + ' DEPLOYED BY YOU' }, true);
  navigate({ view: 'token', sym: c.sym });
}

export function openLaunch(opener?: Element | null): void {
  NEW = newDefaults();
  renderNew();
  openScrim('#newScrim', opener);
}

export function closeLaunch(): void {
  closeScrim('#newScrim');
}

export function isLaunchOpen(): boolean {
  return isOpen('#newScrim');
}

export function initLaunch(): void {
  wireBackdrop('#newScrim', closeLaunch);
}
