import {
  ACH,
  CRATES,
  type Crate,
  type CrateTier,
  RAR,
  RANKS,
  crateBy,
  num,
  rankOf,
} from '@stonkz/shared';
import { api } from '../api/index.js';
import { CLAIMS, LEVEL_LADDER } from '../api/live.js';
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
import { ARR, DOT, fmtUnits } from '../lib/fmt.js';
import { type Html, attr, html, render } from '../lib/html.js';
import { reducedMotion } from '../lib/motion.js';
import {
  USER,
  achCount,
  hasActiveItem,
  inventoryOf,
  isReady,
  readyAt,
  readyCount,
  rewardsHydrated,
  saveUser,
} from '../state/user.js';
import { WALLET, nativeUnit } from '../state/wallet.js';
import { initLevelModal } from '../modals/level.js';
import { addChat } from './chat.js';
import {
  type RewardsModel,
  achHTML,
  balancesBodyHTML,
  balancesHTML,
  cooldownPct,
  crateStatus,
  defaultLadder,
  dropLogHTML,
  itemsBodyHTML,
  itemsHTML,
  levelPanelBodyHTML,
  levelPanelHTML,
  nextRankText,
  rarityOf,
  spSubline,
  stripHTML,
  verdictText,
  verifyCrateProof,
} from './rewards-view.js';

/**
 * The rewards page.
 *
 * Top to bottom: rank strip → Stonk Pointz level ladder → crates → balances
 * (with the on-chain claim state) + items → referrals → achievements → drop
 * history with commit–reveal proofs. Live mode hydrates everything from
 * `GET /rewards` and keeps it moving over the `user:{net}:{wallet}` WS
 * channel (`api/live.ts`); sim mode keeps the local ledger.
 * `index.html:2242`
 */

let selCrate: CrateTier = 'GOLD';
let REFERRAL: LiveReferralSnapshot | null = null;
/** The wallet the pane was last rendered for; a switch re-selects the first openable tier. */
let lastWallet = '';

const RHODIUM_KEY = 'RHODIUM KEY · INSTANT CRATE';

/* ---------------------------------- model ---------------------------------- */

function model(now = Date.now()): RewardsModel {
  const live = api.mode === 'live';
  const connected = !!WALLET.on;
  const loading = live && connected && !rewardsHydrated();
  const inventory: Partial<Record<CrateTier, number>> = {};
  for (const c of CRATES) inventory[c.k] = inventoryOf(c.k);
  const ladder =
    live && LEVEL_LADDER
      ? LEVEL_LADDER.map((l) => ({
          level: l.level,
          sp: l.sp,
          grants: l.grants as Partial<Record<CrateTier, number>>,
          claimed: l.claimed,
          reached: l.reached,
        }))
      : defaultLadder(USER.sp ?? 0, USER.spLevel?.claimed ?? []);
  return {
    live,
    loading,
    connected,
    xp: USER.xp,
    sp: USER.sp ?? 0,
    stonkz: USER.stonkz,
    rwa: USER.rwa ?? [],
    rwaUsd: USER.rwaUsd,
    streak: USER.streak ?? 1,
    spLevel: USER.spLevel,
    ladder,
    items: USER.items ?? [],
    claims: live ? (CLAIMS ? { open: CLAIMS.open } : null) : { open: false },
    nextCommit: live ? (USER.nextCrateCommit ?? null) : null,
    log: USER.log,
    ach: USER.ach ?? {},
    readyAt: readyAt('BRONZE'),
    inventory,
    now,
  };
}

/* -------------------------------- referral --------------------------------- */

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
        <span class="sub">${WALLET.on ? 'LOADING…' : 'CONNECT A WALLET'}</span>
      </div>
      <div class="pnl-bd">
        <p class="hint">
          ${WALLET.on ? 'LOADING YOUR CODE…' : `CONNECT TO GET A CODE ${DOT} EARN 15/10/5% OF REFERRAL FEES + 5% OF THEIR SP.`}
        </p>
      </div>
    </section>`;
  }
  const pending = r.pendingNative;
  const unit = nativeUnit();
  const tiers = r.tiers ?? [];
  const requested = r.requestedNative ?? 0;
  const paid = r.paidNative ?? 0;
  const payouts = (r.payouts ?? []).slice(0, 5);
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
          <div class="v" id="refPending">${pending.toFixed(4)} ${unit}</div>
        </div>
        <div>
          <span class="lbl">LIFETIME</span>
          <div class="v">${r.lifetimeNative.toFixed(4)} ${unit}</div>
        </div>
        <div>
          <span class="lbl">AWAITING PAYOUT</span>
          <div class="v${requested > 0 ? ' am' : ''}" id="refRequested">
            ${requested.toFixed(4)} ${unit}
          </div>
        </div>
        <div>
          <span class="lbl">PAID OUT</span>
          <div class="v" id="refPaid">${paid.toFixed(4)} ${unit}</div>
        </div>
        <div>
          <span class="lbl">REFERRED BY</span>
          <div class="v">${r.referredBy ? r.referredBy.slice(0, 8) + '…' : '—'}</div>
        </div>
      </div>
      ${
        tiers.length
          ? html`<div class="scrolly">
              <table class="tbl" id="refTiers">
                <thead>
                  <tr>
                    <th>TIER</th>
                    <th class="r">RATE</th>
                    <th class="r">FILLS</th>
                    <th class="r">PENDING ${unit}</th>
                    <th class="r">LIFETIME ${unit}</th>
                  </tr>
                </thead>
                <tbody>
                  ${tiers.map(
                    (t) =>
                      html`<tr>
                        <td>
                          T${t.tier} ${DOT}
                          ${t.tier === 1 ? 'DIRECT' : t.tier === 2 ? 'THEIR REFERRALS' : 'THIRD DEGREE'}
                        </td>
                        <td class="r">${(t.rate * 100).toFixed(0)}%</td>
                        <td class="r">${num(t.fills)}</td>
                        <td class="r${t.pendingNative > 0 ? ' up' : ' dm'}">
                          ${t.pendingNative.toFixed(6)}
                        </td>
                        <td class="r dm">${t.lifetimeNative.toFixed(6)}</td>
                      </tr>`,
                  )}
                </tbody>
              </table>
            </div>`
          : ''
      }
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button type="button" class="openbtn" id="refClaim" ${pending > 0 ? '' : ' disabled'}>
          CLAIM AS $STONKZ
        </button>
        <button type="button" class="wiz-btn" id="refPayout" ${pending > 0 ? '' : ' disabled'}>
          REQUEST ${unit} PAYOUT
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
      ${
        payouts.length
          ? html`<div class="hint" id="refPayouts">
              ${payouts.map(
                (p) =>
                  html`<div>
                    ${new Date(p.requestedAt).toISOString().slice(0, 10)} ${DOT}
                    ${
                      p.mode === 'stonkz'
                        ? num(p.stonkz ?? 0) +
                          ' $STONKZ FOR ' +
                          p.amountNative.toFixed(6) +
                          ' ' +
                          unit
                        : p.amountNative.toFixed(6) +
                          ' ' +
                          unit +
                          ' ' +
                          DOT +
                          ' ' +
                          p.status.toUpperCase() +
                          (p.txSig ? ' ' + DOT + ' ' + p.txSig.slice(0, 10) + '…' : '')
                    }
                  </div>`,
              )}
            </div>`
          : ''
      }
      <p class="hint">
        15/10/5% OF REFERRED TRADERS&#8217; CURVE FEES, PAID OUT OF THE PLATFORM&#8217;S 15% LEG
        ${DOT} CLAIM AS $STONKZ REWARD CREDITS AT ONCE, OR REQUEST THE ${unit} ITSELF: THE
        COMMISSION SITS IN THE ON-CHAIN PROTOCOL VAULT AND IS SENT TO YOUR WALLET BY THE TREASURY
        SIGNER IN A BATCH, THEN SHOWS AS PAID OUT HERE.
      </p>
    </div>
  </section>`;
}

/**
 * A `?ref=CODE` on the URL a friend shared is remembered until the wallet is
 * signed in, then applied once through `/referrals/attach`. The code is only
 * ever sent to our own API, and only for a wallet that has no referrer yet;
 * the server rejects self-referrals and cycles.
 */
const REF_KEY = 'stonkz.refcode';
try {
  const fromUrl = new URLSearchParams(location.search).get('ref')?.trim().toUpperCase();
  if (fromUrl && /^[A-Z0-9]{4,12}$/.test(fromUrl) && !localStorage.getItem(REF_KEY)) {
    localStorage.setItem(REF_KEY, fromUrl);
  }
} catch {
  /* no storage / no location: nothing to remember */
}

async function attachRememberedCode(): Promise<boolean> {
  let code: string | null = null;
  try {
    code = localStorage.getItem(REF_KEY);
  } catch {
    return false;
  }
  if (!code || !REFERRAL || REFERRAL.referredBy) return false;
  try {
    await attachReferral(WALLET.net, code);
    toast('REFERRAL CODE ' + code + ' APPLIED', 'gold');
    return true;
  } catch {
    // Unknown, self or already referred: forget it rather than retry forever.
    return false;
  } finally {
    try {
      localStorage.removeItem(REF_KEY);
    } catch {
      /* ignore */
    }
  }
}

async function refreshReferralPanel(): Promise<void> {
  if (api.mode !== 'live' || !WALLET.net || !WALLET.on) return;
  try {
    REFERRAL = await fetchReferrals(WALLET.net);
    if (await attachRememberedCode()) REFERRAL = await fetchReferrals(WALLET.net);
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
        const res = await claimReferralFees(WALLET.net, 'stonkz');
        if (res.stonkz <= 0) {
          toast('NOTHING TO CLAIM');
          return;
        }
        USER.stonkz = res.stonkzTotal;
        saveUser();
        toast('CLAIMED ' + num(res.stonkz) + ' $STONKZ FROM REFERRALS', 'gold');
        await refreshReferralPanel();
        updateStrip();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'CLAIM FAILED');
      }
    })();
  });
  $('#refPayout')?.addEventListener('click', () => {
    void (async () => {
      try {
        const res = await claimReferralFees(WALLET.net, 'native');
        if (res.claimedNative <= 0) {
          toast('NOTHING TO CLAIM');
          return;
        }
        toast(
          'PAYOUT OF ' +
            res.claimedNative.toFixed(6) +
            ' ' +
            nativeUnit() +
            ' REQUESTED ' +
            DOT +
            ' SENT BY THE TREASURY SIGNER IN THE NEXT BATCH',
          'gold',
        );
        await refreshReferralPanel();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'PAYOUT REQUEST FAILED');
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

/* ---------------------------------- strip ---------------------------------- */

/** Repaint the numbers that move without rebuilding the page (bus `rank`, crate opens, WS frames). */
export function updateStrip(): void {
  if (must('#rewardsView').hidden) return;
  const m = model();
  const r = rankOf(m.xp);
  const set = (sel: string, v: string): void => {
    const e = $(sel);
    if (e) e.textContent = v;
  };
  set('#rw-name', r.name);
  set('#rw-sub', 'RANK ' + (r.i + 1) + ' OF ' + RANKS.length + ' ' + DOT + ' XP FROM EVERY TRADE');
  const f = $('#rw-fill');
  if (f) f.style.width = r.pct.toFixed(1) + '%';
  set('#rw-cur', num(m.xp) + ' XP TOTAL');
  set('#rw-next', nextRankText(m.xp));
  const lv = $('.rw-badge .lv');
  if (lv) lv.textContent = String(r.i + 1);
  const streak = Math.max(1, m.streak || 1);
  set('#rw-streak', streak + ' DAY' + (streak === 1 ? '' : 'S'));

  // Level panel, balances and items re-render in place: they are cheap and
  // their structure (ladder markers, claim chips, USD line) moves with the data.
  const lp = $('#levelPanel');
  if (lp) render(lp, levelPanelBodyHTML(m));
  const bp = $('#balancesPanel');
  if (bp) render(bp, balancesBodyHTML(m));
  const ip = $('#itemsPanel');
  if (ip) render(ip, itemsBodyHTML(m));
  set('#rw-ready', spSubline(m));
}

/* --------------------------------- crates ---------------------------------- */

function crateCardHTML(c: Crate, now: number): Html {
  const st = crateStatus(c.k, inventoryOf(c.k), readyAt(c.k), now);
  return html`<div
    class="crate${st.ready ? '' : ' locked'}${selCrate === c.k ? ' sel' : ''}"
    data-k="${attr(c.k)}"
    role="button"
    tabindex="0"
    aria-label="${attr(c.k + ' crate, ' + st.inventory + ' owned, ' + st.label)}"
  >
    ${st.ready ? html`<i class="rdydot"></i>` : ''}<canvas
      width="72"
      height="72"
      aria-hidden="true"
    ></canvas
    ><span class="nm" style="color:${attr(c.col)}">${c.k}</span
    ><span class="cd${st.ready ? ' rdy' : ''}" data-cd="${attr(c.k)}">${st.label}</span
    ><span class="inv" data-inv="${attr(c.k)}">×${st.inventory}</span
    ><span class="cdt"
      ><i
        data-bar="${attr(c.k)}"
        style="width:${attr(cooldownPct(c.cd, readyAt(c.k), now))}%;background:${attr(st.ready ? '#00d26a' : c.col)}"
      ></i
    ></span>
  </div>`;
}

function paneHTML(k: CrateTier, now: number): Html {
  const c = crateBy(k) as Crate;
  const st = crateStatus(k, inventoryOf(k), readyAt(k), now);
  const keyable = st.left > 0 && st.inventory > 0 && hasActiveItem(RHODIUM_KEY, now);
  const rows = c.drops.map((d, i) => {
    const rar = RAR[i] as (typeof RAR)[number];
    const reward =
      d[1] === 'S'
        ? html`${num(d[2])} – ${num(d[3])} $STONKZ`
        : d[1] === 'R'
          ? html`${fmtUnits(d[3])} – ${fmtUnits(d[4])} ${d[2]}<span class="rwatag">RWA</span>`
          : html`${d[2]}`;
    return html`<tr>
      <td><span class="rar ${rar[1]}">${rar[0]}</span></td>
      <td class="${d[1] === 'I' ? 'gd' : d[1] === 'R' ? 'rw' : ''}">${reward}</td>
      <td class="r" style="width:74px">
        <b>${d[0].toFixed(0)}%</b
        ><span class="pbar"
          ><i style="width:${attr(Math.max(3, d[0]))}%;background:${attr(c.col)}"></i
        ></span>
      </td>
    </tr>`;
  });
  return html`<div class="pnl-hd">
      <h2>${c.k} Crate</h2>
      <span class="sub"
        >GLOBAL CD ${c.cd >= 24 ? c.cd / 24 + 'D' : c.cd + 'H'} AFTER OPEN ${DOT} ×${st.inventory}
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
          <div class="hint" id="paneState">
            ${st.ready ? html`<span class="up">${st.reason}</span>` : st.reason}
          </div>
        </div>
      </div>
      <div>
        <span class="lbl">DROP TABLE ${DOT} ODDS PER OPEN</span>
        <p class="hint">$STONKZ AND RWA ASSETS ${DOT} FUNDED BY FEES</p>
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
      <button class="openbtn" id="openBtn" ${st.ready ? '' : ' disabled'}>${st.button}</button>
      <button class="openbtn key" id="keyBtn" ${keyable ? '' : ' hidden'}>
        USE RHODIUM KEY ${DOT} OPEN NOW
      </button>
      <p class="hint">
        TRADE TO EARN XP/SP. SP LEVELS GRANT CRATES. OPENING ANY CRATE LOCKS ALL CRATES FOR THAT
        TIER&#8217;S
        COOLDOWN.${
          api.mode === 'live'
            ? ' HALF OF EVERY $STONKZ BUYBACK AND THE WHOLE RWA CRATE FUND STOCK THESE CRATES. EVERY ROLL IS COMMIT-REVEAL: SEE THE PROOF COLUMN IN DROP HISTORY.'
            : ' SIMULATED — NO REAL TOKEN OR ASSET IS DISTRIBUTED.'
        }
      </p>
    </div>`;
}

/* ------------------------------ achievements ------------------------------- */

/** Repaint the achievement grid after an unlock, without rebuilding the page. */
export function refreshAch(): void {
  if (must('#rewardsView').hidden) return;
  render($('#achWrap'), achHTML(USER.ach ?? {}));
  const sub = $('#achSub');
  if (sub) sub.textContent = achCount() + ' / ' + ACH.length + ' UNLOCKED';
}

/* ---------------------------------- page ----------------------------------- */

export function renderRewards(): void {
  const v = must('#rewardsView');
  const now = Date.now();
  if (WALLET.full && WALLET.full !== lastWallet) {
    lastWallet = WALLET.full;
    selCrate = CRATES.find((c) => isReady(c.k))?.k ?? selCrate;
  }
  const m = model(now);
  render(
    v,
    html`<div style="display:flex;align-items:center;gap:10px">
        <button class="back" id="rw-back">${ARR} BACK</button
        ><span class="hint">REWARDS ${DOT} RANK PROGRESS AND STONKDROPS</span>
      </div>
      ${stripHTML(m)} ${levelPanelHTML(m)}
      <div class="rw-grid">
        <section class="pnl">
          <div class="pnl-hd">
            <h2>Stonkdrops</h2>
            <span class="sub" id="crateSub">${crateSubline(m)}</span>
          </div>
          <div class="crates" id="crateGrid">${CRATES.map((c) => crateCardHTML(c, now))}</div>
        </section>
        <section class="pnl" id="cratePane">${paneHTML(selCrate, now)}</section>
        ${balancesHTML(m)} ${itemsHTML(m)}
        <div id="refPanel">${referralHTML()}</div>
        <section class="pnl" style="grid-column:1/-1">
          <div class="pnl-hd">
            <h2>Achievements</h2>
            <span class="sub" id="achSub">${achCount()} / ${ACH.length} UNLOCKED</span>
          </div>
          <div id="achWrap">${achHTML(m.ach, now)}</div>
        </section>
        <section class="pnl" style="grid-column:1/-1">
          <div class="pnl-hd">
            <h2>Drop History</h2>
            <span class="sub"
              >${m.live ? 'SERVER OPENS ' + DOT + ' COMMIT-REVEAL PROOFS' : 'RECENT OPENS'}</span
            >
          </div>
          <div id="dropLog">${dropLogHTML(m)}</div>
        </section>
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
  wireDropLog();
}

function crateSubline(m: RewardsModel): string {
  if (m.loading) return 'LOADING…';
  const owned = Object.values(m.inventory).reduce((a, b) => a + (b ?? 0), 0);
  return `${readyCount()} OPENABLE ${DOT} ${owned} OWNED ${DOT} GLOBAL COOLDOWN ON EVERY OPEN`;
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
  $('#keyBtn')?.addEventListener('click', () => void doOpen(selCrate, { useKey: true }));
}

function selectCrate(k: CrateTier): void {
  selCrate = k;
  for (const el of $$('#crateGrid .crate')) el.classList.toggle('sel', el.dataset['k'] === k);
  render(must('#cratePane'), paneHTML(k, Date.now()));
  drawCrate($<HTMLCanvasElement>('#paneCrate'), (crateBy(k) as Crate).col);
  wirePane();
}

let opening = false;

async function doOpen(k: CrateTier, opts: { useKey?: boolean } = {}): Promise<void> {
  if (opening) return; // Double-click guard: the server would 429 anyway, but do not double-animate.
  const now = Date.now();
  const st = crateStatus(k, inventoryOf(k), readyAt(k), now);
  const viaKey =
    !!opts.useKey && st.left > 0 && st.inventory > 0 && hasActiveItem(RHODIUM_KEY, now);
  if (!st.ready && !viaKey) {
    toast(st.reason);
    return;
  }
  opening = true;
  const btn = $('#openBtn') as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'ROLLING…';
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
    const res = await api.openCrate(k, viaKey ? { useKey: true } : undefined);
    const rarity = rarityOf(res.dropIndex);
    setTimeout(
      () => {
        opening = false;
        const slot = $('#revealSlot');
        if (slot) {
          render(
            slot,
            html`<div class="reveal in ${attr(rarity.toLowerCase())}">
              <span class="lbl">${rarity} DROP${res.keyUsed ? ' ' + DOT + ' KEY USED' : ''}</span>
              <div class="amt">${res.label}</div>
              <div class="from">
                FROM ${k} CRATE ${DOT} +${res.xp}
                XP${res.proof ? html` ${DOT} ROLL ${res.proof.rollValue.toFixed(2)}` : ''}
              </div>
              ${
                res.proof
                  ? html`<div class="from">
                      PROOF IN DROP HISTORY ${DOT} VERIFY IT IN YOUR BROWSER
                    </div>`
                  : ''
              }
            </div>`,
          );
        }
        render($('#dropLog'), dropLogHTML(model()));
        wireDropLog();
        updateCrates();
        updateStrip();
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
    opening = false;
    const code = err instanceof SocialApiError ? err.code : err instanceof Error ? err.message : '';
    if (code === 'no_inventory')
      toast('NO ' + k + ' INVENTORY ' + DOT + ' LEVEL UP TO EARN ONE', 'red');
    else if (code === 'cooling_down') toast('CRATES LOCKED ' + DOT + ' GLOBAL COOLDOWN', 'red');
    else if (code === 'no_key') toast('NO RHODIUM KEY HELD', 'red');
    else if (code === 'unauthorized' || code === 'auth_required')
      toast('CONNECT WALLET TO OPEN CRATES', 'red');
    else toast(err instanceof Error ? err.message.toUpperCase() : 'OPEN FAILED', 'red');
    // The server is the truth for inventory and cooldown after any refusal.
    void api.refreshRewards?.().then(() => {
      updateCrates();
      updateStrip();
    });
    updateCrates();
  }
}

function refreshPaneState(): void {
  const now = Date.now();
  const st = crateStatus(selCrate, inventoryOf(selCrate), readyAt(selCrate), now);
  const stEl = $('#paneState');
  const b = $('#openBtn') as HTMLButtonElement | null;
  const key = $('#keyBtn') as HTMLButtonElement | null;
  if (stEl) {
    if (st.ready) render(stEl, html`<span class="up">${st.reason}</span>`);
    else stEl.textContent = st.reason;
  }
  if (b && !opening) {
    b.disabled = !st.ready;
    b.textContent = st.button;
  }
  if (key) key.hidden = !(st.left > 0 && st.inventory > 0 && hasActiveItem(RHODIUM_KEY, now));
}

/** Tick the countdowns without rebuilding the grid. `index.html:2395` */
export function updateCrates(): void {
  if (must('#rewardsView').hidden) return;
  const now = Date.now();
  for (const c of CRATES) {
    const el = $('#crateGrid [data-k="' + c.k + '"]');
    if (!el) continue;
    const st = crateStatus(c.k, inventoryOf(c.k), readyAt(c.k), now);
    const cd = $('[data-cd="' + c.k + '"]', el);
    const bar = $('[data-bar="' + c.k + '"]', el);
    const inv = $('[data-inv="' + c.k + '"]', el);
    if (cd) {
      cd.textContent = st.label;
      cd.className = 'cd' + (st.ready ? ' rdy' : '');
    }
    if (inv) inv.textContent = '×' + st.inventory;
    if (bar) {
      bar.style.width = cooldownPct(c.cd, readyAt(c.k), now) + '%';
      bar.style.background = st.ready ? '#00d26a' : c.col;
    }
    el.classList.toggle('locked', !st.ready);
    const dot = $('.rdydot', el);
    if (st.ready && !dot) {
      const d = document.createElement('i');
      d.className = 'rdydot';
      el.insertBefore(d, el.firstChild);
    }
    if (!st.ready && dot) dot.remove();
  }
  refreshPaneState();
  const sub = $('#crateSub');
  if (sub) sub.textContent = crateSubline(model(now));
  const rc = $('#rw-ready');
  if (rc) rc.textContent = spSubline(model(now));
}

/* -------------------------------- drop log --------------------------------- */

function wireDropLog(): void {
  const log = $('#dropLog');
  if (!log) return;
  log.addEventListener('click', (e) => {
    const t = e.target as HTMLElement | null;
    if (!t) return;
    const toggle = t.closest<HTMLElement>('[data-proof]');
    if (toggle) {
      const i = toggle.dataset['proof'];
      const row = $('#proof-' + i);
      if (row) {
        row.hidden = !row.hidden;
        toggle.setAttribute('aria-expanded', String(!row.hidden));
      }
      return;
    }
    const verify = t.closest<HTMLElement>('[data-verify]');
    const copy = t.closest<HTMLElement>('[data-copy]');
    const row = t.closest<HTMLElement>('.proof-row');
    if (!row || (!verify && !copy)) return;
    const idx = Number(row.id.replace('proof-', ''));
    const entry = USER.log[idx];
    if (!entry?.proof) return;
    if (copy) {
      const text = JSON.stringify(
        { net: WALLET.net, wallet: WALLET.full, tier: entry.k, ...entry.proof },
        null,
        2,
      );
      void navigator.clipboard?.writeText(text).then(
        () => toast('PROOF COPIED', 'gold'),
        () => toast('COPY FAILED'),
      );
      return;
    }
    const verdict = row.querySelector<HTMLElement>('[data-verdict]');
    if (verdict) verdict.textContent = 'CHECKING…';
    void verifyCrateProof(entry.proof, { net: WALLET.net, wallet: WALLET.full, tier: entry.k })
      .then((v) => {
        if (verdict) {
          verdict.textContent = verdictText(v);
          verdict.className = 'hint ' + (v.ok ? 'up' : 'dn');
        }
      })
      .catch(() => {
        if (verdict) verdict.textContent = 'VERIFY FAILED ' + DOT + ' WEBCRYPTO UNAVAILABLE';
      });
  });
}

export function openRewards(): void {
  renderRewards();
  showView('rewards');
  window.scrollTo(0, 0);
  // A stale page is worse than a flash: re-read the ledger on every visit in live mode.
  if (api.mode === 'live' && WALLET.on) {
    void api.refreshRewards?.().then(() => {
      if (!must('#rewardsView').hidden) {
        updateStrip();
        updateCrates();
        refreshAch();
        render($('#dropLog'), dropLogHTML(model()));
        wireDropLog();
      }
    });
  }
}

// The level-up dialog's CTA lands here; wired at import so `state/user.ts` never has to know the view.
initLevelModal(openRewards);
