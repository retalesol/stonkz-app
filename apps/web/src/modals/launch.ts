import {
  FEE_SPLIT,
  GRAD,
  MAJORS,
  STOCKS,
  RH_STOCKS,
  SUPPLIES,
  type SupplyOption,
  curveMc,
  isEvm,
  num,
  px,
  usd,
} from '@stonkz/shared';
import { NET_INFO, type Net } from '@stonkz/shared';
import { api } from '../api/index.js';
import { LaunchPendingError, LaunchedDevBuyError, type LaunchPhase } from '../api/launch-errors.js';
import { SocialApiError, uploadImage } from '../api/social.js';
import { navigate } from '../app/route.js';
import { activeWallet, isRejection } from '../wallet/index.js';
import { explorerTxUrl, isDeployed } from '../wallet/chain.js';
import { drawLaunchChart } from '../canvas/chart.js';
import { paintCoinArt } from '../canvas/pix.js';
import { toast } from '../fx/toast.js';
import { $, must } from '../lib/dom.js';
import { DOT, MID, fmtSupply } from '../lib/fmt.js';
import { type Html, attr, html, render } from '../lib/html.js';
import { SquareCropper, imageNaturalSize, isSquareAspect } from '../lib/crop.js';
import { NATIVE_PRICE, WALLET, nativeUnit, netOf } from '../state/wallet.js';
import { addChat } from '../views/chat.js';
import { closeScrim, isOpen, openScrim, refreshScrim, wireBackdrop } from './scrim.js';
import {
  LAUNCH_LIMITS,
  IMAGE_TYPES,
  type FieldCheck,
  checkDesc,
  checkImageFile,
  checkName,
  checkTelegram,
  checkTicker,
  checkWebsite,
  checkXHandle,
  devBuyPresets,
  fmtBuy,
  launchErrorCopy,
  parseDevBuy,
} from './launch-rules.js';

/**
 * The three-step launch stepper. `index.html:3725`
 *
 * One draft survives closing and reopening the dialog (and a failed launch):
 * it is only thrown away after a launch that reached the chain. Every
 * listener on `#createBody` is delegated and wired once in `initLaunch`, so a
 * re-render can never stack a second copy of a handler.
 */

interface Draft {
  /** The net this draft's base/dev-buy were picked for. */
  net: Net;
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
  /** What is actually in the dev-buy box, so a half-typed `0.` survives a re-render. */
  buyRaw: string;
  cashback: boolean;
  /** Pinata / IPFS gateway URL after upload (or local object URL in sim). */
  uri: string;
}

let NEW: Draft = newDefaults();
let cropper: SquareCropper | null = null;
let cropBusy = false;

/** A launch is in flight: the stepper is read-only and LAUNCH cannot fire twice. */
let launching = false;
let phase: LaunchPhase | null = null;
/** An image upload is in flight; bumping `uploadSeq` orphans a stale one. */
let uploading = false;
let uploadSeq = 0;
/** The inline error line (also toasted) and the field it points at. */
let errMsg = '';
let errField: string | null = null;

function newDefaults(): Draft {
  return {
    net: WALLET.net,
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
    buyRaw: '',
    cashback: false,
    uri: '',
  };
}

function resetDraft(): void {
  if (NEW.uri.startsWith('blob:')) URL.revokeObjectURL(NEW.uri);
  uploadSeq++;
  uploading = false;
  NEW = newDefaults();
  clearErr();
}

/**
 * The wallet moved to another net since this draft was started: the base
 * token list and the dev-buy unit belong to the old one, so reset those and
 * keep everything the user typed.
 */
function syncDraftNet(): void {
  if (NEW.net === WALLET.net) return;
  NEW.net = WALLET.net;
  NEW.base = nativeUnit();
  NEW.tab = 'majors';
  NEW.q = '';
  NEW.buy = 0;
  NEW.buyRaw = '';
  NEW.cashback = false;
  if (NEW.step > 1) NEW.step = 1;
}

function setErr(msg: string, field: string | null = null): void {
  errMsg = msg;
  errField = field;
}

function clearErr(): void {
  errMsg = '';
  errField = null;
}

function invalid(id: string): Html {
  return errField === id ? html` aria-invalid="true" aria-describedby="nc-err"` : html``;
}

function baseList(): ReadonlyArray<readonly [string, string]> {
  const net = WALLET.net;
  const stocks = NET_INFO[net].stocks;
  const list = NEW.tab === 'majors' || !stocks ? MAJORS[net] : stocks === 'rh' ? RH_STOCKS : STOCKS;
  const q = NEW.q.trim().toUpperCase();
  if (!q) return list;
  return list.filter(
    (t) => t[0].toUpperCase().indexOf(q) > -1 || t[1].toUpperCase().indexOf(q) > -1,
  );
}

/** Every base this net lists, whatever tab/filter is showing. */
function allBases(): ReadonlyArray<readonly [string, string]> {
  const net = WALLET.net;
  const stocks = NET_INFO[net].stocks;
  const extra = !stocks ? [] : stocks === 'rh' ? RH_STOCKS : STOCKS;
  return [...MAJORS[net], ...extra];
}

/* --------------------------------- steps ---------------------------------- */

function artColumn(): Html {
  const label = uploading ? 'UPLOADING…' : NEW.uri ? 'REPLACE' : 'UPLOAD';
  return html`<canvas
      class="av${NEW.uri ? ' has-img' : ''}"
      id="nc-av"
      width="128"
      height="128"
      role="img"
      aria-label="${attr(NEW.uri ? 'Your coin art' : 'Default coin art')}"
    ></canvas>
    <div class="nc-av-actions">
      <button
        type="button"
        class="chip"
        id="nc-upload"
        aria-describedby="nc-art-hint"
        ${uploading || launching ? html`disabled aria-busy="true"` : html``}
      >
        ${label}</button
      >${
        NEW.uri && !uploading
          ? html`<button
              type="button"
              class="chip"
              id="nc-clear"
              ${launching ? html`disabled` : html``}
            >
              CLEAR
            </button>`
          : ''
      }
    </div>
    <input
      type="file"
      id="nc-file"
      accept="${attr(IMAGE_TYPES.join(','))}"
      hidden
      tabindex="-1"
      aria-hidden="true"
    />`;
}

function ncStep1(): Html {
  const evm = isEvm(WALLET.net);
  return html`<div class="det">
      <div class="nc-av-col" id="nc-art">${artColumn()}</div>
      <div class="rowf" style="align-content:start">
        <div class="nc-field">
          <label class="lbl" for="f-name">NAME</label
          ><input
            class="fld"
            id="f-name"
            maxlength="${LAUNCH_LIMITS.name}"
            value="${attr(NEW.name)}"
            placeholder="Token name"
            autocomplete="off"
            required
            ${invalid('f-name')}
          />
        </div>
        <div class="nc-field">
          <label class="lbl" for="f-tick">TICKER</label
          ><input
            class="fld"
            id="f-tick"
            maxlength="10"
            value="${attr(NEW.tick)}"
            placeholder="TICKER"
            autocomplete="off"
            autocapitalize="characters"
            spellcheck="false"
            required
            ${invalid('f-tick')}
          />
        </div>
        <div class="nc-field" style="grid-column:1/-1">
          <label class="lbl" for="f-desc">DESCRIPTION</label
          ><textarea
            class="fld"
            id="f-desc"
            maxlength="${LAUNCH_LIMITS.desc}"
            placeholder="Short description"
            ${invalid('f-desc')}
          >
${NEW.desc}</textarea>
        </div>
      </div>
    </div>
    <div class="nc-grid">
      <div class="nc-field">
        <label class="lbl" for="f-web">WEBSITE</label
        ><input
          class="fld"
          id="f-web"
          maxlength="${LAUNCH_LIMITS.web}"
          value="${attr(NEW.web)}"
          placeholder="https://"
          autocomplete="off"
          inputmode="url"
          autocapitalize="off"
          spellcheck="false"
          ${invalid('f-web')}
        />
      </div>
      <div class="nc-field">
        <label class="lbl" for="f-x">X ACCOUNT</label
        ><input
          class="fld"
          id="f-x"
          maxlength="40"
          value="${attr(NEW.x)}"
          placeholder="@handle"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          ${invalid('f-x')}
        />
      </div>
      <div class="nc-field">
        <label class="lbl" for="f-tg">TELEGRAM</label
        ><input
          class="fld"
          id="f-tg"
          maxlength="80"
          value="${attr(NEW.tg)}"
          placeholder="t.me/…"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          ${invalid('f-tg')}
        />
      </div>
    </div>
    <p class="hint" id="nc-art-hint">
      DEFAULT ART IS MEMEMAN ON AMBER ${DOT} UPLOAD A SQUARE PNG, JPEG, WEBP OR GIF UNDER 5 MB (OR
      CROP ONE) TO REPLACE IT ON IPFS ${DOT} FIXED SUPPLY
      ${evm ? '' : html`${DOT} MINT AND FREEZE AUTHORITY REVOKED AT DEPLOY`} ${DOT} LP BURNS WHEN
      THE CURVE HITS ${usd(GRAD)}.
    </p>`;
}

/** Bases `/base-tokens` says this env can pair; `null` until known (or when everything is fine). */
let liveBases: ReadonlySet<string> | null = null;
let liveBasesNet: Net | null = null;
function ensureLiveBases(): void {
  const net = WALLET.net;
  if (!api.availableBases || liveBasesNet === net) return;
  liveBasesNet = net;
  liveBases = null;
  void api
    .availableBases(net)
    .then((set) => {
      if (WALLET.net !== net) return;
      liveBases = set;
      if (NEW.step === 1 && isLaunchOpen() && $('#baseList')) renderNew();
    })
    .catch(() => {
      // Unknown is treated as "everything available"; the API still refuses
      // an unpinned base with `base_mint_not_allowed`, which has its own copy.
      liveBasesNet = null;
    });
}

function baseAvailable(sym: string): boolean {
  return liveBases === null || liveBases.has(sym.toUpperCase());
}

function ncStep2(): Html {
  const n = netOf();
  ensureLiveBases();
  const list = baseList();
  const greyed = list.filter((t) => !baseAvailable(t[0])).length;
  return html`<div>
      <div class="base-hd">
        <span class="lbl" style="margin:0" id="nc-base-lbl">BASE TOKEN</span
        ><span class="netbadge"
          ><i class="netdot" style="background:${attr(n.col)}"></i>${n.name}</span
        ><span class="base-tabs" role="group" aria-label="Base token list"
          ><button
            type="button"
            class="tab${NEW.tab === 'majors' ? ' on' : ''}"
            data-btab="majors"
            aria-pressed="${NEW.tab === 'majors' ? 'true' : 'false'}"
          >
            TOP 10</button
          >${
            !NET_INFO[WALLET.net].stocks
              ? ''
              : html`<button
                  type="button"
                  class="tab${NEW.tab === 'stocks' ? ' on' : ''}"
                  data-btab="stocks"
                  aria-pressed="${NEW.tab === 'stocks' ? 'true' : 'false'}"
                >
                  STOCK TOKENS
                </button>`
          }</span
        ><input
          class="base-search"
          id="f-bq"
          placeholder="FILTER"
          value="${attr(NEW.q)}"
          aria-label="Filter base tokens"
          autocomplete="off"
          spellcheck="false"
        />
      </div>
      <div class="base-list" id="baseList" role="radiogroup" aria-labelledby="nc-base-lbl">
        ${
          list.length
            ? list.map((t) => {
                const avail = baseAvailable(t[0]);
                const on = NEW.base === t[0];
                return html`<button
                  type="button"
                  role="radio"
                  aria-checked="${on ? 'true' : 'false'}"
                  class="base-opt${on ? ' on' : ''}${avail ? '' : ' off'}"
                  data-base="${attr(t[0])}"
                  ${avail ? html`` : html`disabled title="NOT AVAILABLE ON THIS NET YET"`}
                >
                  <span class="bs">${t[0]}</span><span class="bn">${t[1]}</span>
                </button>`;
              })
            : html`<div class="base-empty">NO MATCH ${DOT} CLEAR THE FILTER</div>`
        }
      </div>
      ${
        greyed > 0
          ? html`<p class="hint" style="margin-top:4px">
              ${greyed} GREYED OUT ${DOT} NO PINNED MINT OR PRICE FOR THEM ON ${n.name} YET.
            </p>`
          : ''
      }
      <p class="hint" style="margin-top:4px">
        PAIRS AGAINST ${NEW.tab === 'stocks' ? 'A TOKENIZED STOCK' : 'A MAJOR'} ON
        ${n.name}${
          !NET_INFO[WALLET.net].stocks
            ? '.'
            : html` ${DOT} STOCK LIST MIRRORS GECKOTERMINAL TOKENIZED STOCKS.`
        }
      </p>
    </div>
    <div>
      <span class="lbl" id="nc-sup-lbl">TOTAL SUPPLY</span>
      <div class="supply-row" role="radiogroup" aria-labelledby="nc-sup-lbl">
        ${SUPPLIES.map(
          (sp) =>
            html`<button
              type="button"
              role="radio"
              aria-checked="${NEW.supply === sp[0] ? 'true' : 'false'}"
              class="chipm${NEW.supply === sp[0] ? ' on' : ''}"
              data-sup="${attr(String(sp[0]))}"
            >
              ${sp[1]}
            </button>`,
        )}
      </div>
    </div>
    <div>
      <label class="lbl" for="f-fee">TRADING FEE</label>
      <div class="fee-row">
        <input
          type="range"
          id="f-fee"
          min="1"
          max="5"
          step="0.1"
          value="${attr(NEW.fee)}"
          aria-valuetext="${attr(Number(NEW.fee).toFixed(1) + ' percent')}"
          aria-describedby="nc-fee-hint"
        /><span class="fee-val" id="feeVal" aria-hidden="true">${Number(NEW.fee).toFixed(1)}%</span>
      </div>
      <p class="hint" id="nc-fee-hint">
        CHARGED ON EVERY BUY AND SELL ${DOT} ${(FEE_SPLIT.creatorBucket * 100).toFixed(0)}% TO YOU
        AS CREATOR FEES (STAKERS TAKE UP TO HALF OF THAT), ${(FEE_SPLIT.protocol * 100).toFixed(0)}%
        PLATFORM, ${(FEE_SPLIT.buyback * 100).toFixed(0)}% $STONKZ BUYBACK (HALF INTO CRATES, HALF
        BURNED), ${(FEE_SPLIT.rwa * 100).toFixed(0)}% RWA CRATE FUND (BUYS REAL-WORLD ASSETS FOR
        CRATES).
      </p>
    </div>`;
}

function ncStep3(): Html {
  const unit = nativeUnit();
  const n = netOf();
  const lock = launching ? html`disabled` : html``;
  const twoTx = isEvm(WALLET.net) && NEW.buy > 0;
  return html`<div><canvas class="nc-chart" id="nc-chart" aria-hidden="true"></canvas></div>
    <div class="fee-row nc-buy-row">
      <label class="lbl" for="f-buy" style="margin:0;flex:0 0 88px">DEV BUY (${unit})</label
      ><input
        class="fld r"
        id="f-buy"
        style="max-width:120px"
        value="${attr(NEW.buyRaw)}"
        placeholder="0"
        inputmode="decimal"
        autocomplete="off"
        ${lock}
        ${invalid('f-buy')}
      /><span class="amt-row" style="flex:1" role="group" aria-label="Dev buy presets"
        >${devBuyPresets(unit).map(
          (v) =>
            html`<button type="button" class="qa" data-buy="${attr(v)}" ${lock}>
              ${v ? fmtBuy(v) : 'NONE'}
            </button>`,
        )}</span
      >
    </div>
    <div class="nc-stats" id="ncStats"></div>
    <button
      type="button"
      class="cb-opt${NEW.cashback ? ' on' : ''}${NEW.buy > 0 ? ' off' : ''}"
      id="cbOpt"
      aria-pressed="${NEW.cashback && NEW.buy <= 0 ? 'true' : 'false'}"
      ${lock}
    >
      <span class="cb-box" aria-hidden="true"></span
      ><span
        ><span class="cbt">CASHBACK LAUNCH ${DOT} NO DEV BUY</span
        ><span class="cbs"
          >FOR THE FIRST 5 MINUTES THE TRADING FEE STARTS AT 50% AND DECAYS TO
          ${Number(NEW.fee).toFixed(1)}%. EVERY FEE IN THAT WINDOW IS SPENT BUYING
          ${NEW.tick || 'YOUR TOKEN'} ON THE CHART AND THE ALLOCATION GOES TO YOU. AFTER 5 MINUTES
          FEES ACCRUE IN ${unit}.</span
        ></span
      >
    </button>
    <div class="nc-sum" id="ncSum" aria-live="polite"></div>
    <p class="hint">
      YOUR BUY IS THE FIRST TRADE ON THE CURVE. IT SETS THE OPENING PRICE FOR EVERYONE ELSE.
      ${
        twoTx
          ? html`${DOT} ON ${n.name} THE DEV BUY IS A SECOND TRANSACTION RIGHT AFTER THE CREATE:
            EXPECT TWO WALLET PROMPTS.`
          : ''
      }
    </p>
    <p class="hint nc-where">
      LAUNCHING ON
      <span class="netbadge"
        ><i class="netdot" style="background:${attr(n.col)}"></i>${n.name}</span
      >
      FROM
      ${WALLET.addr}${
        api.mode === 'live' && WALLET.sol > 0
          ? html` ${DOT} BALANCE ${WALLET.sol.toFixed(4)} ${unit}`
          : ''
      }
    </p>`;
}

/* --------------------------- image upload / crop -------------------------- */

function closeCrop(): void {
  cropper?.destroy();
  cropper = null;
  cropBusy = false;
  closeScrim('#cropScrim');
}

/** Repaint only the art column, so an upload finishing never steals focus from a field. */
function renderArt(): void {
  const col = $('#nc-art');
  if (!col) return;
  render(col, artColumn());
  paintLaunchAvatar();
  refreshScrim('#newScrim');
}

function paintLaunchAvatar(): void {
  const cv = $<HTMLCanvasElement>('#nc-av');
  if (!cv) return;
  cv.classList.toggle('has-img', !!NEW.uri);
  // Painted before layout: pass the stylesheet's 64px (modal.css `.det
  // canvas.av`), or the 128px backing store becomes the display size.
  paintCoinArt(cv, NEW.seed, NEW.uri || null, 64);
}

function uploadErrorCopy(err: unknown): string {
  if (isRejection(err)) return 'SIGN-IN CANCELLED ' + DOT + ' IMAGE NOT UPLOADED';
  if (err instanceof SocialApiError) {
    if (err.code === 'rate_limited') return 'TOO MANY UPLOADS ' + DOT + ' WAIT A MINUTE AND RETRY';
    if (err.code === 'not_configured')
      return 'IMAGE UPLOADS ARE OFF ON THIS ENV ' + DOT + ' LAUNCH WITH THE DEFAULT ART';
    return ('IMAGE UPLOAD FAILED ' + DOT + ' ' + err.message).toUpperCase().slice(0, 140);
  }
  if (err instanceof TypeError) return 'IMAGE UPLOAD FAILED ' + DOT + ' CHECK YOUR CONNECTION';
  return 'IMAGE UPLOAD FAILED ' + DOT + ' TRY AGAIN';
}

async function persistImageBlob(blob: Blob, filename: string): Promise<void> {
  const seq = ++uploadSeq;
  if (api.mode !== 'live') {
    if (NEW.uri.startsWith('blob:')) URL.revokeObjectURL(NEW.uri);
    NEW.uri = URL.createObjectURL(blob);
    toast('IMAGE READY ' + DOT + ' LIVE MODE UPLOADS TO IPFS');
    renderArt();
    return;
  }
  uploading = true;
  renderArt();
  try {
    const res = await uploadImage(WALLET.net, blob, filename);
    if (seq !== uploadSeq) return;
    if (!/^https?:\/\//i.test(res.url)) throw new Error('upload returned no gateway URL');
    if (NEW.uri.startsWith('blob:')) URL.revokeObjectURL(NEW.uri);
    NEW.uri = res.url;
    toast('COIN ART SAVED');
  } catch (err) {
    if (seq === uploadSeq) toast(uploadErrorCopy(err), 'red');
  } finally {
    if (seq === uploadSeq) {
      uploading = false;
      renderArt();
    }
  }
}

async function openCropForFile(file: File): Promise<void> {
  openScrim('#cropScrim');
  const canvas = must<HTMLCanvasElement>('#crop-canvas');
  cropper?.destroy();
  cropper = new SquareCropper(canvas, { size: 512, mimeType: 'image/png' });
  try {
    await cropper.loadFile(file);
  } catch (err) {
    closeCrop();
    throw err;
  }
  const zoom = must<HTMLInputElement>('#crop-zoom');
  zoom.value = '100';
  zoom.oninput = () => {
    if (!cropper) return;
    cropper.setRelativeZoom(Number(zoom.value) / 100);
  };
}

async function handleImageFile(file: File): Promise<void> {
  const problem = checkImageFile(file);
  if (problem) {
    toast(problem, 'red');
    return;
  }
  let size: { w: number; h: number };
  try {
    size = await imageNaturalSize(file);
  } catch {
    toast('COULD NOT READ THAT IMAGE ' + DOT + ' TRY ANOTHER FILE', 'red');
    return;
  }
  if (!(size.w > 0 && size.h > 0)) {
    toast('COULD NOT READ THAT IMAGE ' + DOT + ' TRY ANOTHER FILE', 'red');
    return;
  }
  if (isSquareAspect(size.w, size.h)) {
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
      } catch {
        toast('CROP FAILED ' + DOT + ' TRY ANOTHER IMAGE', 'red');
      } finally {
        cropBusy = false;
        btn.disabled = false;
      }
    })();
  });
  wireBackdrop('#cropScrim', closeCrop);
}

/* -------------------------------- render ---------------------------------- */

const PHASE_LABEL: Record<LaunchPhase, string> = {
  prepare: 'PREPARING…',
  sign: 'CONFIRM IN WALLET…',
  confirm: 'CONFIRMING ON CHAIN…',
  devbuy: 'DEV BUY…',
};

function goLabel(): string {
  if (NEW.step < 2) return 'NEXT';
  if (launching) return phase ? PHASE_LABEL[phase] : 'DEPLOYING…';
  return 'LAUNCH';
}

/** Update the button in place as the launch moves through its phases. */
function paintGo(): void {
  const go = $<HTMLButtonElement>('#nc-next');
  if (go) go.textContent = goLabel();
}

/**
 * Where focus was before a re-render, as something that survives it: an id,
 * or one of the delegated data attributes.
 */
function focusKey(): string | null {
  const a = document.activeElement;
  if (!(a instanceof HTMLElement) || !must('#createBody').contains(a)) return null;
  if (a.id) return '#' + a.id;
  for (const k of ['base', 'sup', 'btab', 'buy']) {
    const v = a.dataset[k];
    if (v !== undefined) return `[data-${k}="${CSS.escape(v)}"]`;
  }
  return null;
}

function renderNew(opts: { focus?: string } = {}): void {
  const keep = opts.focus ?? focusKey();
  const i = NEW.step;
  must('#nc-count').textContent = 'STEP ' + (i + 1) + ' OF 3';
  const body = i === 0 ? ncStep1() : i === 1 ? ncStep2() : ncStep3();
  render(
    must('#createBody'),
    html`${body}
      <p class="nc-err" id="nc-err" role="alert" ${errMsg ? html`` : html`hidden`}>${errMsg}</p>
      <div class="wiz-foot">
        <span class="wiz-dots" aria-hidden="true"
          >${[0, 1, 2].map(
            (n) => html`<i class="wiz-dot${n === i ? ' on' : n < i ? ' done' : ''}"></i>`,
          )}</span
        ><span class="grow"></span
        ><button
          type="button"
          class="wiz-btn"
          id="nc-back"
          ${i && !launching ? html`` : html`disabled`}
        >
          BACK</button
        ><button
          type="button"
          class="wiz-btn go"
          id="nc-next"
          ${launching ? html`disabled aria-busy="true"` : html``}
        >
          ${goLabel()}
        </button>
      </div>`,
  );
  refreshScrim('#newScrim');
  if (i === 0) paintLaunchAvatar();
  if (i === 2) previewBuy();
  if (keep) {
    const el = $<HTMLElement>(keep, must('#createBody'));
    if (el && !(el as HTMLButtonElement).disabled) el.focus();
  }
}

/** Validate step 1, normalising what is kept. Returns false and points at the field on failure. */
function commitStep0(): boolean {
  const checks: Array<[string, FieldCheck, (v: string) => void]> = [
    ['f-name', checkName(NEW.name), (v) => (NEW.name = v)],
    ['f-tick', checkTicker(NEW.tick), (v) => (NEW.tick = v)],
    ['f-desc', checkDesc(NEW.desc), (v) => (NEW.desc = v)],
    ['f-web', checkWebsite(NEW.web), (v) => (NEW.web = v)],
    ['f-x', checkXHandle(NEW.x), (v) => (NEW.x = v)],
    ['f-tg', checkTelegram(NEW.tg), (v) => (NEW.tg = v)],
  ];
  for (const [id, r, apply] of checks) {
    if (!r.ok) {
      setErr(r.error, id);
      return false;
    }
    apply(r.value);
  }
  return true;
}

function commitStep1(): boolean {
  if (!allBases().some((t) => t[0] === NEW.base)) NEW.base = nativeUnit();
  if (!baseAvailable(NEW.base)) {
    setErr(`${NEW.base} ISN'T AVAILABLE ON ${netOf().name} YET ${DOT} PICK ANOTHER BASE TOKEN`);
    return false;
  }
  if (!SUPPLIES.some((s) => s[0] === NEW.supply)) {
    setErr('PICK A SUPPLY');
    return false;
  }
  if (!(NEW.fee >= 1 && NEW.fee <= 5)) {
    setErr('FEE MUST BE BETWEEN 1.0% AND 5.0%');
    return false;
  }
  return true;
}

function commitStep2(): boolean {
  const buy = parseDevBuy(NEW.buyRaw);
  if (buy === null) {
    setErr('DEV BUY MUST BE A NUMBER (OR EMPTY FOR NONE)', 'f-buy');
    return false;
  }
  NEW.buy = buy;
  if (buy > 0) NEW.cashback = false;
  if (api.mode === 'live' && buy > 0 && WALLET.sol > 0 && buy >= WALLET.sol) {
    setErr(
      `YOU HAVE ${WALLET.sol.toFixed(4)} ${nativeUnit()} ${DOT} LOWER THE DEV BUY TO LEAVE ROOM FOR GAS`,
      'f-buy',
    );
    return false;
  }
  return true;
}

function next(): void {
  if (launching) return;
  clearErr();
  if (NEW.step === 0 && !commitStep0()) {
    renderNew({ focus: errField ? '#' + errField : '#nc-next' });
    return;
  }
  if (NEW.step === 1 && !commitStep1()) {
    renderNew({ focus: '#nc-next' });
    return;
  }
  if (NEW.step < 2) {
    NEW.step++;
    renderNew({ focus: NEW.step === 2 ? '#f-buy' : '#f-bq' });
    return;
  }
  void doLaunch();
}

function back(): void {
  if (launching || NEW.step === 0) return;
  clearErr();
  NEW.step--;
  renderNew({ focus: '#nc-back' });
}

function onBodyClick(e: Event): void {
  const target = e.target as Element | null;
  if (!target) return;
  if (target.closest('#nc-next')) return next();
  if (target.closest('#nc-back')) return back();
  if (launching) return;
  if (target.closest('#nc-upload')) {
    if (!uploading) must<HTMLInputElement>('#nc-file').click();
    return;
  }
  if (target.closest('#nc-clear')) {
    uploadSeq++;
    if (NEW.uri.startsWith('blob:')) URL.revokeObjectURL(NEW.uri);
    NEW.uri = '';
    renderArt();
    $<HTMLElement>('#nc-upload')?.focus();
    return;
  }
  const t = target.closest<HTMLElement>('[data-btab]');
  const b = target.closest<HTMLElement>('[data-base]');
  const sp = target.closest<HTMLElement>('[data-sup]');
  const bb = target.closest<HTMLElement>('[data-buy]');
  if (t) {
    NEW.tab = t.dataset['btab'] === 'stocks' ? 'stocks' : 'majors';
    NEW.q = '';
    renderNew();
  } else if (b) {
    if ((b as HTMLButtonElement).disabled) return;
    NEW.base = b.dataset['base'] as string;
    clearErr();
    renderNew();
  } else if (sp) {
    const nextSup = Number(sp.dataset['sup']);
    if (Number.isFinite(nextSup) && nextSup > 0) {
      NEW.supply = nextSup;
      renderNew();
    }
  } else if (bb) {
    const v = Number(bb.dataset['buy']);
    NEW.buy = Number.isFinite(v) && v > 0 ? v : 0;
    NEW.buyRaw = fmtBuy(NEW.buy);
    if (NEW.buy > 0) NEW.cashback = false;
    clearErr();
    renderNew();
  } else if (target.closest('#cbOpt')) {
    if (NEW.buy > 0) {
      setErr('SET THE DEV BUY TO 0 TO USE CASHBACK', 'f-buy');
      renderNew({ focus: '#cbOpt' });
      return;
    }
    NEW.cashback = !NEW.cashback;
    const cb = $('#cbOpt');
    cb?.classList.toggle('on', NEW.cashback);
    cb?.setAttribute('aria-pressed', NEW.cashback ? 'true' : 'false');
    previewBuy();
  }
}

const TEXT_FIELDS: Record<string, 'name' | 'tick' | 'desc' | 'web' | 'x' | 'tg'> = {
  'f-name': 'name',
  'f-tick': 'tick',
  'f-desc': 'desc',
  'f-web': 'web',
  'f-x': 'x',
  'f-tg': 'tg',
};

function onBodyInput(e: Event): void {
  const el = e.target as HTMLInputElement | null;
  if (!el?.id) return;
  const key = TEXT_FIELDS[el.id];
  if (key) {
    if (key === 'tick') {
      // Show the ticker the way it will mint: upper-case, A-Z0-9 only.
      const clean = el.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (clean !== el.value) el.value = clean;
    }
    NEW[key] = el.value;
    if (errField === el.id) {
      clearErr();
      el.removeAttribute('aria-invalid');
      const box = $('#nc-err');
      if (box) box.hidden = true;
    }
    return;
  }
  if (el.id === 'f-bq') {
    NEW.q = el.value;
    const keep = el.selectionStart ?? el.value.length;
    renderNew({ focus: '#f-bq' });
    $<HTMLInputElement>('#f-bq')?.setSelectionRange(keep, keep);
    return;
  }
  if (el.id === 'f-fee') {
    NEW.fee = Number(el.value);
    const v = $('#feeVal');
    if (v) v.textContent = NEW.fee.toFixed(1) + '%';
    el.setAttribute('aria-valuetext', NEW.fee.toFixed(1) + ' percent');
    return;
  }
  if (el.id === 'f-buy') {
    NEW.buyRaw = el.value;
    const v = parseDevBuy(el.value);
    NEW.buy = v ?? 0;
    if (errField === 'f-buy') {
      clearErr();
      const box = $('#nc-err');
      if (box) box.hidden = true;
      el.removeAttribute('aria-invalid');
    }
    previewBuy();
  }
}

function onBodyChange(e: Event): void {
  const input = e.target as HTMLInputElement | null;
  if (input?.id !== 'nc-file') return;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  void handleImageFile(file).catch(() => {
    toast('IMAGE UPLOAD FAILED ' + DOT + ' TRY ANOTHER FILE', 'red');
  });
}

function onBodyKeydown(e: KeyboardEvent): void {
  // Enter in a single-line field advances, the way a form would submit.
  if (e.key !== 'Enter' || e.isComposing) return;
  const el = e.target as HTMLElement | null;
  if (!(el instanceof HTMLInputElement) || el.id === 'f-bq' || el.type === 'range') return;
  e.preventDefault();
  next();
}

function previewBuy(): void {
  const stats = $('#ncStats');
  if (!stats) return;
  const buy = Math.max(0, NEW.buy || 0);
  const mc0 = curveMc(0);
  const mc1 = curveMc(buy);
  const sup = NEW.supply;
  const p0 = mc0 / sup;
  const p1 = mc1 / sup;
  const tok = buy > 0 ? (buy * NATIVE_PRICE.usd) / ((p0 + p1) / 2) : 0;
  const pctSup = Math.min(100, (tok / sup) * 100);
  const jump = (mc1 / mc0 - 1) * 100;
  render(
    stats,
    html`<div>
        <div class="lbl">YOU RECEIVE</div>
        <div class="v gd">${num(tok)}</div>
      </div>
      <div>
        <div class="lbl">OF SUPPLY</div>
        <div class="v">${pctSup.toFixed(2)}%</div>
      </div>
      <div>
        <div class="lbl">OPENING MCAP</div>
        <div class="v am">${usd(mc1)}</div>
      </div>
      <div>
        <div class="lbl">PRICE MOVE</div>
        <div class="v ${jump > 0 ? 'up' : 'dm'}">${jump > 0 ? '+' : ''}${jump.toFixed(0)}%</div>
      </div>`,
  );
  const cbEl = $('#cbOpt');
  if (cbEl) {
    if (buy > 0) NEW.cashback = false;
    cbEl.classList.toggle('off', buy > 0);
    cbEl.classList.toggle('on', NEW.cashback && buy <= 0);
    cbEl.setAttribute('aria-pressed', NEW.cashback && buy <= 0 ? 'true' : 'false');
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

/** Refuse before anything is prepared (and counted against the launch quota). */
function preflight(): string | null {
  if (!WALLET.on) return 'CONNECT A WALLET TO LAUNCH A COIN';
  if (api.mode !== 'live') return null;
  const name = netOf().name;
  if (!isDeployed(WALLET.net)) {
    return `LAUNCHES AREN'T LIVE ON ${name} IN THIS ENVIRONMENT YET ${DOT} SWITCH NETWORK`;
  }
  const w = activeWallet();
  if (!w) return 'YOUR WALLET DISCONNECTED ' + DOT + ' RECONNECT TO LAUNCH';
  if (w.net !== WALLET.net) {
    return `YOUR WALLET IS CONNECTED ON ${NET_INFO[w.net].name}, NOT ${name} ${DOT} RECONNECT ON ${name}`;
  }
  return null;
}

function stepErr(step: 0 | 1 | 2, focus: string): void {
  NEW.step = step;
  renderNew({ focus });
}

async function doLaunch(): Promise<void> {
  if (launching) return;
  clearErr();
  if (uploading) {
    setErr('WAIT FOR THE IMAGE UPLOAD TO FINISH');
    renderNew({ focus: '#nc-next' });
    return;
  }
  if (!commitStep0()) return stepErr(0, errField ? '#' + errField : '#nc-next');
  if (!commitStep1()) return stepErr(1, '#nc-next');
  if (!commitStep2()) return stepErr(2, errField ? '#' + errField : '#nc-next');
  syncDraftNet();
  const blocked = preflight();
  if (blocked) {
    setErr(blocked);
    renderNew({ focus: '#nc-next' });
    toast(blocked, 'red');
    return;
  }

  const net = WALLET.net;
  const netName = netOf().name;
  const sym = NEW.tick;
  const base = NEW.base;
  const buy = Math.max(0, NEW.buy || 0);
  const cashback = NEW.cashback && buy <= 0;

  launching = true;
  phase = null;
  renderNew({ focus: '#nc-next' });
  let c;
  try {
    c = await api.launch(
      {
        sym,
        name: NEW.name,
        desc: NEW.desc,
        supply: NEW.supply as SupplyOption,
        tfee: Number(NEW.fee),
        buy,
        base,
        cashback,
        ...(NEW.uri && !NEW.uri.startsWith('blob:') ? { uri: NEW.uri } : {}),
        ...(NEW.x ? { x: NEW.x } : {}),
        ...(NEW.web ? { web: NEW.web } : {}),
        ...(NEW.tg ? { tg: NEW.tg } : {}),
      },
      {
        onPhase: (p) => {
          phase = p;
          paintGo();
        },
      },
    );
  } catch (err) {
    launching = false;
    phase = null;
    if (err instanceof LaunchPendingError) {
      // Broadcast, not (yet) recorded. Never offer a relaunch from here.
      resetDraft();
      closeLaunch();
      toast(
        `${sym} WAS SENT ${DOT} STILL WAITING FOR IT TO CONFIRM ${DOT} DON'T RELAUNCH, IT SHOWS ON THE BOARD ONCE INDEXED`,
        undefined,
        { href: explorerTxUrl(err.net, err.signature), label: 'VIEW TX' },
      );
      return;
    }
    if (err instanceof LaunchedDevBuyError) {
      resetDraft();
      closeLaunch();
      toast(err.message.toUpperCase().slice(0, 160), 'red');
      navigate({ view: 'token', sym: err.sym, ...(err.mint ? { mint: err.mint } : {}) });
      return;
    }
    const f = launchErrorCopy(err, { unit: nativeUnit(), netName, base, buy });
    setErr(f.msg, f.step === 2 && /DEV BUY/.test(f.msg) ? 'f-buy' : null);
    if (f.step !== undefined) NEW.step = f.step;
    if (isLaunchOpen()) renderNew({ focus: errField ? '#' + errField : '#nc-next' });
    toast(f.msg, f.tone === 'red' ? 'red' : undefined);
    return;
  }

  launching = false;
  phase = null;
  resetDraft();
  closeLaunch();
  toast(
    cashback
      ? 'DEPLOYED ' + sym + '/' + base + ' ' + DOT + ' CASHBACK LIVE FOR 5 MINUTES'
      : 'DEPLOYED ' +
          sym +
          '/' +
          base +
          (buy > 0 ? ' ' + DOT + ' DEV BUY ' + fmtBuy(buy) + ' ' + NET_INFO[net].unit : '') +
          (api.mode === 'live' ? '' : ' ' + DOT + ' SIMULATED'),
    'gold',
  );
  addChat(
    'GLOBAL',
    {
      sys: true,
      who: '',
      text: 'NEW MINT ' + DOT + ' $' + sym + ' / ' + base + ' ' + DOT + ' DEPLOYED BY YOU',
    },
    true,
  );
  navigate({ view: 'token', sym: c.sym, ...(c.mint ? { mint: c.mint } : {}) });
}

/** Opening never wipes the draft: closing by accident (Escape, backdrop) loses nothing. */
export function openLaunch(opener?: Element | null): void {
  syncDraftNet();
  if (!launching) clearErr();
  renderNew();
  openScrim('#newScrim', opener);
  // After the focus trap's own first-control focus (the upload chip).
  requestAnimationFrame(() => {
    if (!isLaunchOpen()) return;
    const first =
      NEW.step === 0 ? '#f-name' : NEW.step === 1 ? '#nc-next' : launching ? '#nc-next' : '#f-buy';
    $<HTMLElement>(first)?.focus();
  });
}

export function closeLaunch(): void {
  closeCrop();
  closeScrim('#newScrim');
}

export function isLaunchOpen(): boolean {
  return isOpen('#newScrim');
}

/** True while a launch is between LAUNCH and its outcome. */
export function isLaunching(): boolean {
  return launching;
}

export function isCropOpen(): boolean {
  return isOpen('#cropScrim');
}

export function cancelCrop(): void {
  closeCrop();
}

export function initLaunch(onDismiss: () => void): void {
  wireBackdrop('#newScrim', onDismiss);
  const body = must('#createBody');
  body.addEventListener('click', onBodyClick);
  body.addEventListener('input', onBodyInput);
  body.addEventListener('change', onBodyChange);
  body.addEventListener('keydown', onBodyKeydown);
  wireCropOnce();
}
