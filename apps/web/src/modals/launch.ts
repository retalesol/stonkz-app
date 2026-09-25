import {
  FEE_SPLIT,
  GRAD,
  MAJORS,
  STOCKS,
  RH_STOCKS,
  SUPPLIES,
  type SupplyOption,
  curveMc,
  normalizeTicker,
  num,
  px,
  usd,
} from '@stonkz/shared';
import { api } from '../api/index.js';
import { LiveApiError } from '../api/live.js';
import { SocialApiError, uploadImage } from '../api/social.js';
import { navigate } from '../app/route.js';
import { SignerCancelledError } from '../app/signer.js';
import { describeWalletError, isRejection } from '../wallet/index.js';
import { drawLaunchChart } from '../canvas/chart.js';
import { paintCoinArt } from '../canvas/pix.js';
import { toast } from '../fx/toast.js';
import { $, must } from '../lib/dom.js';
import { DOT, MID, fmtSupply } from '../lib/fmt.js';
import { type Html, attr, html, render } from '../lib/html.js';
import { SquareCropper, imageNaturalSize, isSquareAspect } from '../lib/crop.js';
import { NATIVE_PRICE, WALLET, nativeUnit, netOf } from '../state/wallet.js';
import { COINS } from '../state/coins.js';
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
  /** Pinata / IPFS gateway URL after upload (or local object URL in sim). */
  uri: string;
}

let NEW: Draft = newDefaults();
let cropper: SquareCropper | null = null;
let cropBusy = false;

function newDefaults(): Draft {
  return {
    step: 0,
    seed: Math.floor(Math.random() * 1e6),
    name: '',
    tick: '',
    desc: '',
    web: '',
    x: '',
    tg: '',
    base: nativeUnit(),
    tab: 'majors',
    q: '',
    supply: 1e9,
    fee: 2,
    buy: 0,
    cashback: false,
    uri: '',
  };
}

function baseList(): ReadonlyArray<readonly [string, string]> {
  const net = WALLET.net;
  const list =
    NEW.tab === 'majors' || net === 'BASE'
      ? MAJORS[net]
      : net === 'RH'
        ? RH_STOCKS
        : STOCKS;
  const q = NEW.q.trim().toUpperCase();
  if (!q) return list;
  return list.filter((t) => t[0].toUpperCase().indexOf(q) > -1 || t[1].toUpperCase().indexOf(q) > -1);
}

function paintLaunchAvatar(): void {
  const cv = $<HTMLCanvasElement>('#nc-av');
  if (!cv) return;
  cv.classList.toggle('has-img', !!NEW.uri);
  paintCoinArt(cv, NEW.seed, NEW.uri || null);
}

/* --------------------------------- steps ---------------------------------- */

function ncStep1(): Html {
  return html`<div class="det">
      <div class="nc-av-col"><canvas class="av${NEW.uri ? ' has-img' : ''}" id="nc-av" width="128" height="128"></canvas
        ><div class="nc-av-actions"
          ><button type="button" class="chip" id="nc-upload">UPLOAD</button
          >${NEW.uri ? html`<button type="button" class="chip" id="nc-clear">CLEAR</button>` : ''}</div
        ><input type="file" id="nc-file" accept="image/png,image/jpeg,image/webp,image/gif" hidden></div
      ><div class="rowf" style="align-content:start">
        <div class="nc-field"><span class="lbl">NAME</span
          ><input class="fld" id="f-name" maxlength="28" value="${attr(NEW.name)}" placeholder="Token name" autocomplete="off"></div
        ><div class="nc-field"><span class="lbl">TICKER</span
          ><input class="fld" id="f-tick" maxlength="10" value="${attr(NEW.tick)}" placeholder="TICKER" autocomplete="off"></div
        ><div class="nc-field" style="grid-column:1/-1"><span class="lbl">DESCRIPTION</span
          ><textarea class="fld" id="f-desc" maxlength="140" placeholder="Short description">${NEW.desc}</textarea></div>
      </div></div>
    <div class="nc-grid">
      <div class="nc-field"><span class="lbl">WEBSITE</span
        ><input class="fld" id="f-web" maxlength="60" value="${attr(NEW.web)}" placeholder="https://" autocomplete="off"></div
      ><div class="nc-field"><span class="lbl">X ACCOUNT</span
        ><input class="fld" id="f-x" maxlength="24" value="${attr(NEW.x)}" placeholder="@handle" autocomplete="off"></div
      ><div class="nc-field"><span class="lbl">TELEGRAM</span
        ><input class="fld" id="f-tg" maxlength="40" value="${attr(NEW.tg)}" placeholder="t.me/…" autocomplete="off"></div>
    </div>
    <p class="hint">DEFAULT ART IS MEMEMAN ON AMBER ${DOT} UPLOAD A SQUARE (OR CROP) TO REPLACE IT ON IPFS ${DOT}
      FIXED SUPPLY ${DOT} MINT AND FREEZE AUTHORITY REVOKED AT DEPLOY ${DOT} LP BURNS WHEN THE CURVE HITS ${usd(GRAD)}.</p>`;
}

function ncStep2(): Html {
  const n = netOf();
  const list = baseList();
  return html`<div>
      <div class="base-hd"><span class="lbl" style="margin:0">BASE TOKEN</span
        ><span class="netbadge"><i class="netdot" style="background:${attr(n.col)}"></i>${n.name}</span
        ><span class="base-tabs"><button type="button" class="tab${NEW.tab === 'majors' ? ' on' : ''}" data-btab="majors">TOP 10</button>${
          WALLET.net === 'BASE'
            ? ''
            : html`<button type="button" class="tab${NEW.tab === 'stocks' ? ' on' : ''}" data-btab="stocks">STOCK TOKENS</button>`
        }</span
        ><input class="base-search" id="f-bq" placeholder="FILTER" value="${attr(NEW.q)}" aria-label="Filter base tokens"></div>
      <div class="base-list" id="baseList">${
        list.length
          ? list.map(
              (t) => html`<button type="button" class="base-opt${NEW.base === t[0] ? ' on' : ''}" data-base="${attr(t[0])}"
                ><span class="bs">${t[0]}</span><span class="bn">${t[1]}</span></button>`,
            )
          : html`<div class="base-empty">NO MATCH ${DOT} CLEAR THE FILTER</div>`
      }</div>
      <p class="hint" style="margin-top:4px">PAIRS AGAINST ${
        NEW.tab === 'stocks' ? 'A TOKENIZED STOCK' : 'A MAJOR'
      } ON ${n.name}${
        WALLET.net === 'BASE' ? '.' : html` ${DOT} STOCK LIST MIRRORS GECKOTERMINAL TOKENIZED STOCKS.`
      }</p></div>
    <div><span class="lbl">TOTAL SUPPLY</span><div class="supply-row">${SUPPLIES.map(
      (sp) => html`<button type="button" class="chipm${NEW.supply === sp[0] ? ' on' : ''}" data-sup="${attr(String(sp[0]))}">${sp[1]}</button>`,
    )}</div></div>
    <div><span class="lbl">TRADING FEE</span><div class="fee-row"
      ><input type="range" id="f-fee" min="1" max="5" step="0.1" value="${attr(NEW.fee)}" aria-label="Trading fee"
      ><span class="fee-val" id="feeVal">${Number(NEW.fee).toFixed(1)}%</span></div>
      <p class="hint">CHARGED ON EVERY TRADE ${DOT} ${(FEE_SPLIT.protocol * 100).toFixed(0)}% TO THE PROTOCOL,
        ${(FEE_SPLIT.creatorBucket * 100).toFixed(0)}% TO YOU AS CREATOR FEES (SHARED WITH YOUR STAKERS) AND
        ${(FEE_SPLIT.stonkzOps * 100).toFixed(0)}% TO $STONKZ OPS.</p></div>`;
}

function ncStep3(): Html {
  const buyVal = NEW.buy > 0 ? Number(NEW.buy).toFixed(2) : '';
  return html`<div><canvas class="nc-chart" id="nc-chart"></canvas></div>
    <div class="fee-row"><span class="lbl" style="margin:0;flex:0 0 88px">DEV BUY (${NEW.base})</span
      ><input class="fld r" id="f-buy" style="max-width:120px" value="${attr(buyVal)}" placeholder="0" inputmode="decimal"
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

/* --------------------------- image upload / crop -------------------------- */

function closeCrop(): void {
  cropper?.destroy();
  cropper = null;
  cropBusy = false;
  closeScrim('#cropScrim');
}

async function persistImageBlob(blob: Blob, filename: string): Promise<void> {
  if (api.mode !== 'live') {
    if (NEW.uri.startsWith('blob:')) URL.revokeObjectURL(NEW.uri);
    NEW.uri = URL.createObjectURL(blob);
    toast('IMAGE READY ' + DOT + ' LIVE MODE UPLOADS TO IPFS');
    renderNew();
    return;
  }
  toast('UPLOADING TO IPFS…');
  const res = await uploadImage(WALLET.net, blob, filename);
  if (NEW.uri.startsWith('blob:')) URL.revokeObjectURL(NEW.uri);
  NEW.uri = res.url;
  toast('COIN ART SAVED');
  renderNew();
}

async function openCropForFile(file: File): Promise<void> {
  openScrim('#cropScrim');
  const canvas = must<HTMLCanvasElement>('#crop-canvas');
  cropper?.destroy();
  cropper = new SquareCropper(canvas, { size: 512, mimeType: 'image/png' });
  await cropper.loadFile(file);
  const zoom = must<HTMLInputElement>('#crop-zoom');
  zoom.value = '100';
  zoom.oninput = () => {
    if (!cropper) return;
    cropper.setRelativeZoom(Number(zoom.value) / 100);
  };
}

async function handleImageFile(file: File): Promise<void> {
  if (!file.type.startsWith('image/')) {
    toast('PICK A PNG, JPEG, WEBP OR GIF', 'red');
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    toast('IMAGE MUST BE UNDER 5 MB', 'red');
    return;
  }
  const { w, h } = await imageNaturalSize(file);
  if (!(w > 0 && h > 0)) {
    toast('COULD NOT READ IMAGE', 'red');
    return;
  }
  if (isSquareAspect(w, h)) {
    await persistImageBlob(file, file.name || 'token.png');
    return;
  }
  await openCropForFile(file);
}

function wireCropOnce(): void {
  must('#crop-x').addEventListener('click', closeCrop);
  must('#crop-cancel').addEventListener('click', closeCrop);
  must('#crop-apply').addEventListener('click', () => {
    if (!cropper || cropBusy) return;
    cropBusy = true;
    const btn = must<HTMLButtonElement>('#crop-apply');
    btn.disabled = true;
    void (async () => {
      try {
        const { blob } = await cropper!.export();
        closeCrop();
        await persistImageBlob(blob, 'token.png');
      } catch (err) {
        toast(err instanceof SocialApiError ? err.message : 'CROP FAILED', 'red');
      } finally {
        cropBusy = false;
        btn.disabled = false;
      }
    })();
  });
  wireBackdrop('#cropScrim', closeCrop);
}

function wireStep1Art(): void {
  paintLaunchAvatar();
  must('#nc-upload').addEventListener('click', () => must<HTMLInputElement>('#nc-file').click());
  const clearBtn = $('#nc-clear');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (NEW.uri.startsWith('blob:')) URL.revokeObjectURL(NEW.uri);
      NEW.uri = '';
      renderNew();
    });
  }
  must<HTMLInputElement>('#nc-file').addEventListener('change', () => {
    const input = must<HTMLInputElement>('#nc-file');
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    void handleImageFile(file).catch((err) => {
      toast(err instanceof SocialApiError ? err.message : 'IMAGE UPLOAD FAILED', 'red');
    });
  });
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
    wireStep1Art();
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
        const next = Number(sp.dataset['sup']);
        if (Number.isFinite(next) && next > 0) {
          NEW.supply = next;
          renderNew();
        }
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
      if (!NEW.name.trim()) {
        toast('PICK A NAME FIRST');
        return;
      }
      const sym = normalizeTicker(NEW.tick);
      if (!sym) {
        toast('PICK A TICKER FIRST');
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
  const name = NEW.name.trim();
  const sym = normalizeTicker(NEW.tick);
  if (!name || !sym) {
    toast(!name ? 'PICK A NAME FIRST' : 'PICK A TICKER FIRST');
    NEW.step = 0;
    renderNew();
    return;
  }
  const buy = Math.max(0, NEW.buy || 0);
  let xh = NEW.x.trim();
  if (xh && xh[0] !== '@') xh = '@' + xh.replace(/^@+/, '');
  const cashback = NEW.cashback && buy <= 0;

  const go = must<HTMLButtonElement>('#nc-next');
  const restoreLabel = go.textContent ?? 'LAUNCH';
  go.disabled = true;
  go.textContent = 'DEPLOYING\u2026';
  let c;
  try {
    c = await api.launch({
      sym,
      name,
      desc: NEW.desc.trim(),
      supply: NEW.supply as SupplyOption,
      tfee: Number(NEW.fee),
      buy,
      base: NEW.base,
      cashback,
      ...(NEW.uri && !NEW.uri.startsWith('blob:') ? { uri: NEW.uri } : {}),
      x: xh,
      web: NEW.web.trim(),
      tg: NEW.tg.trim(),
    });
  } catch (err) {
    go.disabled = false;
    go.textContent = restoreLabel;
    if (err instanceof SignerCancelledError) toast('LAUNCH CANCELLED');
    else if (isRejection(err)) toast('LAUNCH REJECTED IN WALLET');
    else if (err instanceof LiveApiError) {
      if (err.code === 'name_or_ticker_cooldown') {
        const retrySec = Math.max(1, Math.ceil((err.retryAfterMs ?? 300_000) / 1000));
        toast(`NAME OR TICKER ON COOLDOWN ${DOT} TRY AGAIN IN ${retrySec}S`, 'red');
      } else if (err.code === 'dev_buy_failed') {
        const msg = (err.message || err.code).toUpperCase();
        toast(msg.length > 140 ? msg.slice(0, 137) + '…' : msg, 'red');
        closeLaunch();
        const symGuess = normalizeTicker(NEW.tick) || NEW.tick.toUpperCase();
        const launched = COINS.find((x) => x.sym === symGuess && x.mine);
        if (launched) {
          navigate({
            view: 'token',
            sym: launched.sym,
            ...(launched.mint ? { mint: launched.mint } : {}),
          });
        }
      } else {
        const msg = (err.message || err.code).toUpperCase();
        toast(msg.length > 120 ? msg.slice(0, 117) + '…' : msg, 'red');
      }
    } else toast(describeWalletError(err), 'red');
    return;
  }

  closeLaunch();
  toast(
    cashback
      ? 'DEPLOYED ' + sym + '/' + NEW.base + ' ' + DOT + ' CASHBACK LIVE FOR 5 MINUTES'
      : 'DEPLOYED ' +
          sym +
          '/' +
          NEW.base +
          (buy > 0 ? ' ' + DOT + ' DEV BUY ' + buy.toFixed(2) : '') +
          (api.mode === 'live' ? '' : ' ' + DOT + ' SIMULATED'),
  );
  addChat('GLOBAL', { sys: true, who: '', text: 'NEW MINT ' + DOT + ' $' + sym + ' / ' + NEW.base + ' ' + DOT + ' DEPLOYED BY YOU' }, true);
  navigate({ view: 'token', sym: c.sym, ...(c.mint ? { mint: c.mint } : {}) });
}

export function openLaunch(opener?: Element | null): void {
  if (NEW.uri.startsWith('blob:')) URL.revokeObjectURL(NEW.uri);
  NEW = newDefaults();
  renderNew();
  openScrim('#newScrim', opener);
}

export function closeLaunch(): void {
  closeCrop();
  closeScrim('#newScrim');
}

export function isLaunchOpen(): boolean {
  return isOpen('#newScrim');
}

export function isCropOpen(): boolean {
  return isOpen('#cropScrim');
}

export function cancelCrop(): void {
  closeCrop();
}

export function initLaunch(onDismiss: () => void): void {
  wireBackdrop('#newScrim', onDismiss);
  wireCropOnce();
}
