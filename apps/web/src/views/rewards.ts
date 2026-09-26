import {
  ACH,
  CRATES,
  type Crate,
  type CrateTier,
  RANKS,
  RAR,
  crateBy,
  num,
  rankOf,
} from '@stonkz/shared';
import { api } from '../api/index.js';
import {
  SocialApiError,
  attachReferral,
  claimReferralFees,
  fetchReferrals,
  type LiveReferralSnapshot,
} from '../api/social.js';
import { back } from '../app/route.js';
import { showView } from '../app/view.js';
import { drawCrate } from '../canvas/crate.js';
import { burst } from '../fx/debris.js';
import { toast } from '../fx/toast.js';
import { $, $$, must, reflow } from '../lib/dom.js';
import { ARR, DOT, cdText } from '../lib/fmt.js';
import { type Html, attr, html, render } from '../lib/html.js';
import { reducedMotion } from '../lib/motion.js';
import {
  USER,
  achCount,
  cdPct,
  hasAch,
  inventoryOf,
  isReady,
  readyAt,
  readyCount,
} from '../state/user.js';
import { WALLET, nativeUnit } from '../state/wallet.js';
import { addChat } from './chat.js';

/**
 * The rewards page: rank strip, crates, achievements and the drop log.
 *
 * The two balances are Stonk Pointz and Stonk Optionz — `$STONKZ` is the token,
 * not a score, and the strip used to conflate them. Phase 3 makes both
 * server-side. `index.html:2242`
 */

let selCrate: CrateTier = 'GOLD';
let REFERRAL: LiveReferralSnapshot | null = null;

function referralHTML(): Html {
  if (api.mode !== 'live') {
    return html`<section class="pnl" style="grid-column:1/-1">
      <div class="pnl-hd">
        <h2>Referrals</h2>
        <span class="sub">LIVE MODE ONLY</span>
      </div>
      <div class="pnl-bd">
        <p class="hint">
          CONNECT IN LIVE TO SHARE A CODE ${DOT} EARN 15/10/5% OF REFERRAL FEES + 5% OF THEIR SP.
        </p>
      </div>
    </section>`;
  }
  const r = REFERRAL;
  if (!r) {
    return html`<section class="pnl" style="grid-column:1/-1">
      <div class="pnl-hd">
        <h2>Referrals</h2>
        <span class="sub">LOADING…</span>
      </div>
      <div class="pnl-bd"><p class="hint">LOADING YOUR CODE…</p></div>
    </section>`;
  }
  const pending = r.pendingNative;
  return html`<section class="pnl" style="grid-column:1/-1">
    <div class="pnl-hd">
      <h2>Referrals</h2>
      <span class="sub"
        >${r.directReferrals} DIRECT ${DOT} 15% / 10% / 5% FEE SHARE ${DOT} 5% SP KICKBACK</span
      >
    </div>
    <div class="pnl-bd" style="display:flex;flex-direction:column;gap:10px">
      <div>
        <span class="lbl">YOUR CODE</span>
        <div style="display:flex;gap:8px;align-items:center;margin-top:4px">
          <code id="refCode" style="font-size:18px;letter-spacing:.12em;font-weight:700"
            >${r.code}</code
          ><button type="button" class="send" id="refCopy">COPY</button>
        </div>
        <p class="hint">FRIENDS PASTE THIS ON FIRST JOIN ${DOT} YOU EARN WHEN THEY TRADE.</p>
      </div>
      <div style="display:flex;gap:16px;flex-wrap:wrap">
        <div>
          <span class="lbl">PENDING FEES</span>
          <div class="v">${pending.toFixed(4)} ${nativeUnit()}</div>
        </div>
        <div>
          <span class="lbl">LIFETIME</span>
          <div class="v">${r.lifetimeNative.toFixed(4)}</div>
        </div>
        <div>
          <span class="lbl">REFERRED BY</span>
          <div class="v">${r.referredBy ? r.referredBy.slice(0, 8) + '…' : '—'}</div>
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button type="button" class="openbtn" id="refClaim" ${pending > 0 ? '' : ' disabled'}>
          CLAIM AS OPTIONZ
        </button>
        <form id="refAttach" style="display:flex;gap:6px;align-items:center">
          <input
            class="fld"
            id="refAttachCode"
            maxlength="12"
            placeholder="ENTER A CODE"
            style="width:120px"
          /><button class="send" type="submit">APPLY</button>
        </form>
      </div>
      <p class="hint">
        15/10/5% OF REFERRED TRADERS&#8217; CURVE FEES (FROM THE PROTOCOL LEG) ${DOT} CLAIM ANYTIME
        AS OPTIONZ ${DOT} NOT A NATIVE WITHDRAW.
      </p>
    </div>
  </section>`;
}

async function refreshReferralPanel(): Promise<void> {
  if (api.mode !== 'live' || !WALLET.net) return;
  try {
    REFERRAL = await fetchReferrals(WALLET.net);
  } catch {
    REFERRAL = null;
  }
  const slot = $('#refPanel');
  if (slot) {
    render(slot, referralHTML());
    bindReferralControls();
  }
}

function bindReferralControls(): void {
  $('#refCopy')?.addEventListener('click', () => {
    const code = REFERRAL?.code;
    if (!code) return;
    void navigator.clipboard?.writeText(code).then(
      () => toast('COPIED ' + code, 'gold'),
      () => toast(code),
    );
  });
  $('#refClaim')?.addEventListener('click', () => {
    void (async () => {
      try {
        const res = await claimReferralFees(WALLET.net);
        if (res.optionz <= 0) {
          toast('NOTHING TO CLAIM');
          return;
        }
        USER.optionz = res.optionzTotal;
        toast('CLAIMED ' + res.optionz + ' OPTIONZ FROM REFERRALS', 'gold');
        await refreshReferralPanel();
        updateStrip();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'CLAIM FAILED');
      }
    })();
  });
  $('#refAttach')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = (($('#refAttachCode') as HTMLInputElement | null)?.value || '').trim();
    if (!code) return;
    void (async () => {
      try {
        await attachReferral(WALLET.net, code);
        toast('REFERRAL ATTACHED', 'gold');
        await refreshReferralPanel();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'ATTACH FAILED');
      }
    })();
  });
}

/* -------------------------------- strip ----------------------------------- */

function stripHTML(): Html {
  const r = rankOf(USER.xp);
  const spLv = USER.spLevel;
  const marks: Html[] = [];
  for (let i = 1; i < 4; i++)
    marks.push(html`<span class="mk" style="left:${attr(i * 25)}%"></span>`);
  const spSub =
    spLv && spLv.next !== null
      ? `SP LV ${spLv.level} ${DOT} ${num(spLv.toNext)} SP TO NEXT CRATE GRANT`
      : spLv
        ? `SP LV ${spLv.level} ${DOT} MAX`
        : `TRADE TO EARN SP ${DOT} SP UNLOCKS CRATES`;
  return html`<div class="rw-strip">
    <div class="rw-badge">
      <span class="lv">${r.i + 1}</span>
      <div>
        <h1 id="rw-name">${r.name}</h1>
        <div class="sub" id="rw-sub">
          RANK ${r.i + 1} OF ${RANKS.length} ${DOT} XP FROM EVERY TRADE
        </div>
      </div>
    </div>
    <div class="rw-prog">
      <div class="rw-track">
        <i id="rw-fill" style="width:${attr(r.pct.toFixed(1))}%"></i>${marks}
      </div>
      <div class="rw-legend">
        <span id="rw-cur">${num(USER.xp)} XP TOTAL</span
        ><span id="rw-next" class="am"
          >${r.next === null ? 'MAX RANK' : num(r.toNext) + ' XP TO ' + (RANKS[r.i + 1] as (typeof RANKS)[number])[0]}</span
        >
      </div>
    </div>
    <div class="rw-bal">
      <span class="lbl">SP</span>
      <div class="v" id="rw-sp">${num(USER.sp ?? 0)}</div>
      <span class="lbl">STONK OPTIONZ</span>
      <div class="v" id="rw-opt">${num(USER.optionz ?? 0)}</div>
      <span class="hint" id="rw-ready">${readyCount()} OPENABLE ${DOT} ${spSub}</span>
    </div>
  </div>`;
}

export function updateStrip(): void {
  if (must('#rewardsView').hidden) return;
  const r = rankOf(USER.xp);
  const set = (sel: string, v: string): void => {
    const e = $(sel);
    if (e) e.textContent = v;
  };
  set('#rw-name', r.name);
  set(
    '#rw-sub',
    'RANK ' + (r.i + 1) + ' OF ' + RANKS.length + ' ' + DOT + ' XP IS EARNED ON EVERY TRADE',
  );
  const f = $('#rw-fill');
  if (f) f.style.width = r.pct.toFixed(1) + '%';
  set('#rw-cur', num(USER.xp) + ' XP TOTAL');
  set(
    '#rw-next',
    r.next === null
      ? 'MAX RANK'
      : num(r.toNext) + ' XP TO ' + (RANKS[r.i + 1] as (typeof RANKS)[number])[0],
  );
  set('#rw-sp', num(USER.sp ?? 0));
  set('#rw-opt', num(USER.optionz ?? 0));
  const lv = $('.rw-badge .lv');
  if (lv) lv.textContent = String(r.i + 1);
  const spLv = USER.spLevel;
  const spSub =
    spLv && spLv.next !== null
      ? `SP LV ${spLv.level} ${DOT} ${num(spLv.toNext)} SP TO NEXT CRATE GRANT`
      : spLv
        ? `SP LV ${spLv.level} ${DOT} MAX`
        : `TRADE TO EARN SP ${DOT} SP UNLOCKS CRATES`;
  set('#rw-ready', `${readyCount()} OPENABLE ${DOT} ${spSub}`);
}

/* -------------------------------- crates ---------------------------------- */

function crateCardHTML(c: Crate): Html {
  const rdy = isReady(c.k);
  const inv = inventoryOf(c.k);
  const cdLeft = readyAt(c.k) - Date.now();
  const cdOk = cdLeft <= 0;
  const status = rdy ? 'READY' : !cdOk ? cdText(cdLeft) : inv <= 0 ? 'EARN VIA SP' : cdText(cdLeft);
  return html`<div
    class="crate${rdy ? '' : ' locked'}${selCrate === c.k ? ' sel' : ''}"
    data-k="${attr(c.k)}"
    role="button"
    tabindex="0"
  >
    ${rdy ? html`<i class="rdydot"></i>` : ''}<canvas
      width="72"
      height="72"
      aria-hidden="true"
    ></canvas
    ><span class="nm" style="color:${attr(c.col)}">${c.k}</span
    ><span class="cd${rdy ? ' rdy' : ''}" data-cd="${attr(c.k)}">${status}</span
    ><span class="hint" style="font-size:10px">×${inv}</span
    ><span class="cdt"
      ><i
        data-bar="${attr(c.k)}"
        style="width:${attr(cdPct(c))}%;background:${attr(rdy ? '#00d26a' : c.col)}"
      ></i
    ></span>
  </div>`;
}

function paneHTML(k: CrateTier): Html {
  const c = crateBy(k) as Crate;
  const rdy = isReady(k);
  const inv = inventoryOf(k);
  const left = readyAt(k) - Date.now();
  const cdOk = left <= 0;
  const rows = c.drops.map((d, i) => {
    const rar = RAR[i] as (typeof RAR)[number];
    const label =
      d[1] === 'S'
        ? num(d[2] as number) + ' \u2013 ' + num(d[3] as number) + ' OPTIONZ'
        : (d[2] as string);
    return html`<tr>
      <td><span class="rar ${rar[1]}">${rar[0]}</span></td>
      <td class="${d[1] === 'I' ? 'gd' : ''}">${label}</td>
      <td class="r" style="width:74px">
        <b>${d[0].toFixed(0)}%</b
        ><span class="pbar"
          ><i style="width:${attr(Math.max(3, d[0]))}%;background:${attr(c.col)}"></i
        ></span>
      </td>
    </tr>`;
  });
  const stateHint = rdy
    ? html`<span class="up">READY ${DOT} ${inv} IN INVENTORY</span>`
    : !cdOk
      ? `GLOBAL LOCK ${cdText(left)} ${DOT} OPENING ANY CRATE LOCKS ALL`
      : inv <= 0
        ? 'NO INVENTORY — TRADE TO EARN SP LEVELS'
        : 'UNLOCKS IN ' + cdText(left);
  const btnLabel = rdy
    ? 'OPEN ' + c.k + ' CRATE'
    : !cdOk
      ? 'LOCKED ' + DOT + ' ' + cdText(left)
      : 'NEED INVENTORY';
  return html`<div class="pnl-hd">
      <h2>${c.k} Crate</h2>
      <span class="sub"
        >GLOBAL CD ${c.cd >= 24 ? c.cd / 24 + 'D' : c.cd + 'H'} AFTER OPEN ${DOT} ×${inv}
        OWNED</span
      >
    </div>
    <div class="pnl-bd">
      <div style="display:flex;align-items:center;gap:10px">
        <canvas
          id="paneCrate"
          width="96"
          height="96"
          style="image-rendering:pixelated;width:58px;height:58px"
        ></canvas>
        <div>
          <div
            class="nm"
            style="color:${attr(c.col)};font-family:'IBM Plex Sans Condensed',sans-serif;font-weight:700;font-size:15px;letter-spacing:.08em"
          >
            ${c.k}
          </div>
          <div class="hint" id="paneState">${stateHint}</div>
        </div>
      </div>
      <div>
        <span class="lbl">DROP TABLE ${DOT} ODDS PER OPEN</span>
        <table class="drops">
          <thead>
            <tr>
              <th scope="col">RARITY</th>
              <th scope="col">REWARD</th>
              <th scope="col" class="r">CHANCE</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
      <div id="revealSlot"></div>
      <button class="openbtn" id="openBtn" ${rdy ? '' : ' disabled'}>${btnLabel}</button>
      <p class="hint">
        TRADE TO EARN XP/SP. SP LEVELS GRANT CRATES. OPENING ANY CRATE LOCKS ALL CRATES FOR THAT
        TIER&#8217;S
        COOLDOWN.${
          api.mode === 'live'
            ? ' OPTIONZ ARE LEDGER CREDITS &#8212; NOT A TRANSFERABLE TOKEN.'
            : ' SIMULATED &#8212; NO REAL TOKEN IS DISTRIBUTED.'
        }
      </p>
    </div>`;
}

function logHTML(): Html {
  return html`<div class="scrolly">
    <table class="tbl dlog">
      <thead>
        <tr>
          <th scope="col">TIME</th>
          <th scope="col">CRATE</th>
          <th scope="col">REWARD</th>
        </tr>
      </thead>
      <tbody>
        ${
          USER.log.length
            ? USER.log.map(
                (l) =>
                  html`<tr>
                    <td class="dm">${l.t}</td>
                    <td style="color:${attr(l.col)}">${l.k}</td>
                    <td class="gd">${l.r}</td>
                  </tr>`,
              )
            : html`<tr>
                <td colspan="3" class="dm">NO DROPS YET ${DOT} OPEN A CRATE</td>
              </tr>`
        }
      </tbody>
    </table>
  </div>`;
}

function achHTML(): Html {
  return html`<div class="ach-grid">
    ${ACH.map((a) => {
      const done = hasAch(a.k);
      return html`<div class="ach${done ? ' done' : ' locked'}">
        <div class="an">${a.n}</div>
        <div class="ad">${a.d}</div>
        <div class="ax">${done ? 'UNLOCKED' : '+' + a.xp + ' XP'}</div>
        <i class="mark"></i>
      </div>`;
    })}
  </div>`;
}

/** Repaint the achievement grid after an unlock, without rebuilding the page. */
export function refreshAch(): void {
  if (must('#rewardsView').hidden) return;
  render($('#achWrap'), achHTML());
  const sub = $('#achSub');
  if (sub) sub.textContent = achCount() + ' / ' + ACH.length + ' UNLOCKED';
}

/* --------------------------------- page ----------------------------------- */

export function renderRewards(): void {
  const v = must('#rewardsView');
  render(
    v,
    html`<div style="display:flex;align-items:center;gap:10px">
        <button class="back" id="rw-back">${ARR} BACK</button
        ><span class="hint">REWARDS ${DOT} RANK PROGRESS AND STONKDROPS</span>
      </div>
      ${stripHTML()}
      <div class="rw-grid">
        <section class="pnl">
          <div class="pnl-hd">
            <h2>Stonkdrops</h2>
            <span class="sub">EARNED FROM SP LEVELS ${DOT} GLOBAL COOLDOWN ON EVERY OPEN</span>
          </div>
          <div class="crates" id="crateGrid">${CRATES.map(crateCardHTML)}</div>
        </section>
        <section class="pnl" id="cratePane">${paneHTML(selCrate)}</section>
        <section class="pnl" style="grid-column:1/-1">
          <div class="pnl-hd">
            <h2>Achievements</h2>
            <span class="sub" id="achSub">${achCount()} / ${ACH.length} UNLOCKED</span>
          </div>
          <div id="achWrap">${achHTML()}</div>
        </section>
        <section class="pnl" style="grid-column:1/-1">
          <div class="pnl-hd">
            <h2>Drop History</h2>
            <span class="sub">RECENT SERVER OPENS</span>
          </div>
          <div id="dropLog">${logHTML()}</div>
        </section>
        <div id="refPanel">${referralHTML()}</div>
      </div>`,
  );
  bindReferralControls();
  void refreshReferralPanel();
  paintCrates();
  must('#rw-back').addEventListener('click', () => back());
  const grid = must('#crateGrid');
  const pickCrate = (k: CrateTier): void => {
    // Second activate on an already-selected ready crate opens it.
    if (selCrate === k && isReady(k)) {
      void doOpen(k);
      return;
    }
    selectCrate(k);
  };
  grid.addEventListener('click', (e) => {
    const el = (e.target as Element | null)?.closest<HTMLElement>('[data-k]');
    if (el?.dataset['k']) pickCrate(el.dataset['k'] as CrateTier);
  });
  grid.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = (e.target as Element | null)?.closest<HTMLElement>('[data-k]');
    if (el?.dataset['k']) {
      e.preventDefault();
      pickCrate(el.dataset['k'] as CrateTier);
    }
  });
  wirePane();
}

function paintCrates(): void {
  for (const el of $$('#crateGrid .crate')) {
    drawCrate(
      $<HTMLCanvasElement>('canvas', el),
      (crateBy(el.dataset['k'] as CrateTier) as Crate).col,
    );
  }
  drawCrate($<HTMLCanvasElement>('#paneCrate'), (crateBy(selCrate) as Crate).col);
}

function wirePane(): void {
  $('#openBtn')?.addEventListener('click', () => void doOpen(selCrate));
}

function selectCrate(k: CrateTier): void {
  selCrate = k;
  for (const el of $$('#crateGrid .crate')) el.classList.toggle('sel', el.dataset['k'] === k);
  render(must('#cratePane'), paneHTML(k));
  drawCrate($<HTMLCanvasElement>('#paneCrate'), (crateBy(k) as Crate).col);
  wirePane();
}

function crateStatusLabel(k: CrateTier): string {
  if (isReady(k)) return 'READY';
  const left = readyAt(k) - Date.now();
  if (left > 0) return cdText(left);
  if (inventoryOf(k) <= 0) return 'EARN VIA SP';
  return cdText(left);
}

function notReadyReason(k: CrateTier): string {
  const left = readyAt(k) - Date.now();
  if (left > 0) return 'CRATES LOCKED ' + DOT + ' ' + cdText(left);
  if (inventoryOf(k) <= 0) return 'NO ' + k + ' INVENTORY ' + DOT + ' TRADE TO EARN SP';
  return 'CRATE NOT READY';
}

async function doOpen(k: CrateTier): Promise<void> {
  if (!isReady(k)) {
    toast(notReadyReason(k));
    return;
  }
  const el = $('#crateGrid [data-k="' + k + '"]');
  if (el && !reducedMotion()) {
    el.classList.remove('shake');
    reflow(el);
    el.classList.add('shake');
    const r = el.getBoundingClientRect();
    burst(r.left + r.width / 2, r.top + 4, Math.max(8, r.height - 8), {
      n: 34,
      gold: true,
      spread: 1.35,
    });
  }
  try {
    const res = await api.openCrate(k);
    const rarity = ((RAR[res.dropIndex] ?? RAR[0]) as (typeof RAR)[number])[0];
    setTimeout(
      () => {
        const slot = $('#revealSlot');
        if (slot) {
          render(
            slot,
            html`<div class="reveal in">
              <span class="lbl">${rarity} DROP</span>
              <div class="amt">${res.label}</div>
              <div class="from">FROM ${k} CRATE ${DOT} +${res.xp} XP</div>
            </div>`,
          );
        }
        render($('#dropLog'), logHTML());
        updateCrates();
        updateStrip();
        if ($('#cratePane')) refreshPaneState();
        toast('STONKDROP ' + DOT + ' ' + res.label + ' FROM ' + k, 'gold');
        addChat(
          'GLOBAL',
          {
            sys: true,
            who: '',
            text: 'STONKDROP ' + DOT + ' YOU PULLED ' + res.label + ' FROM A ' + k + ' CRATE',
          },
          true,
        );
      },
      reducedMotion() ? 0 : 520,
    );
  } catch (err) {
    const code = err instanceof SocialApiError ? err.code : err instanceof Error ? err.message : '';
    if (code === 'no_inventory')
      toast('NO ' + k + ' INVENTORY ' + DOT + ' TRADE TO EARN SP', 'red');
    else if (code === 'cooling_down') toast('CRATES LOCKED ' + DOT + ' GLOBAL COOLDOWN', 'red');
    else if (code === 'unauthorized' || code === 'auth_required')
      toast('CONNECT WALLET TO OPEN CRATES', 'red');
    else toast(err instanceof Error ? err.message.toUpperCase() : 'OPEN FAILED', 'red');
    updateCrates();
    refreshPaneState();
  }
}

function refreshPaneState(): void {
  const c = crateBy(selCrate) as Crate;
  const rdy = isReady(selCrate);
  const inv = inventoryOf(selCrate);
  const left = readyAt(selCrate) - Date.now();
  const cdOk = left <= 0;
  const st = $('#paneState');
  const b = $('#openBtn') as HTMLButtonElement | null;
  if (st) {
    if (rdy) render(st, html`<span class="up">READY ${DOT} ${inv} IN INVENTORY</span>`);
    else if (!cdOk)
      st.textContent = 'GLOBAL LOCK ' + cdText(left) + ' ' + DOT + ' OPENING ANY CRATE LOCKS ALL';
    else if (inv <= 0) st.textContent = 'NO INVENTORY — TRADE TO EARN SP LEVELS';
    else st.textContent = 'UNLOCKS IN ' + cdText(left);
  }
  if (b) {
    b.disabled = !rdy;
    b.textContent = rdy
      ? 'OPEN ' + c.k + ' CRATE'
      : !cdOk
        ? 'LOCKED ' + DOT + ' ' + cdText(left)
        : 'NEED INVENTORY';
  }
}

/** Tick the countdowns without rebuilding the grid. `index.html:2395` */
export function updateCrates(): void {
  if (must('#rewardsView').hidden) return;
  for (const c of CRATES) {
    const el = $('#crateGrid [data-k="' + c.k + '"]');
    if (!el) continue;
    const rdy = isReady(c.k);
    const status = crateStatusLabel(c.k);
    const cd = $('[data-cd="' + c.k + '"]', el);
    const bar = $('[data-bar="' + c.k + '"]', el);
    if (cd) {
      cd.textContent = status;
      cd.className = 'cd' + (rdy ? ' rdy' : '');
    }
    if (bar) {
      bar.style.width = cdPct(c) + '%';
      bar.style.background = rdy ? '#00d26a' : c.col;
    }
    el.classList.toggle('locked', !rdy);
    const dot = $('.rdydot', el);
    if (rdy && !dot) {
      const d = document.createElement('i');
      d.className = 'rdydot';
      el.insertBefore(d, el.firstChild);
    }
    if (!rdy && dot) dot.remove();
  }
  refreshPaneState();
  const rc = $('#rw-ready');
  if (rc) {
    const spLv = USER.spLevel;
    const spSub = !spLv
      ? 'TRADE TO EARN SP'
      : spLv.next == null
        ? `SP LV ${spLv.level} ${DOT} MAX`
        : `TRADE TO EARN SP ${DOT} SP UNLOCKS CRATES`;
    rc.textContent = `${readyCount()} OPENABLE ${DOT} ${spSub}`;
  }
}

export function openRewards(): void {
  renderRewards();
  showView('rewards');
  window.scrollTo(0, 0);
}
