import { FEE_SPLIT, LOCKS, circ, effFee, feePie, inCashback, num, price } from '@stonkz/shared';
import { api } from '../api/index.js';
import { PIE_COLOURS, drawPie } from '../canvas/pie.js';
import { toast } from '../fx/toast.js';
import { $, must } from '../lib/dom.js';
import { DOT } from '../lib/fmt.js';
import { attr, html, render } from '../lib/html.js';
import { type SimCoin } from '../state/coins.js';
import { holdOf } from '../state/holdings.js';
import { ensureStake, poolFrac, stakedFrac, totalStaked, yourShare } from '../state/stake.js';
import { saveUser } from '../state/user.js';
import { nativeUnit } from '../state/wallet.js';
import { closeScrim, isOpen, openScrim, refreshScrim, wireBackdrop } from './scrim.js';

/**
 * Per-token staking.
 *
 * The donut is the one substantive change from the oracle: it used to show a
 * two-slice picture against the old 1%-to-protocol model. It now shows where a
 * curve fee actually goes — protocol 20, `$STONKZ` ops 10, and the creator's 70
 * bucket split with this coin's stakers by `poolFrac`. Stakers top out at 35%
 * of the fee. `index.html:3054`
 */

export const STK: { c: SimCoin | null; lock: number } = { c: null, lock: 0 };

let afterChange: () => void = () => undefined;

function earnText(c: SimCoin): string {
  const st = ensureStake(c.sym);
  return inCashback(c)
    ? num(st.rewTok || 0) + ' ' + c.sym
    : (st.rewSol || 0).toFixed(4) + ' ' + nativeUnit();
}

export function renderStake(c: SimCoin): void {
  const st = ensureStake(c.sym);
  const cb = inCashback(c);
  const pie = feePie(1, poolFrac(c));
  const live = api.mode === 'live';
  must('#stk-title').textContent = 'Stake ' + c.sym;
  must('#stk-sub').textContent = live
    ? (cb ? 'CASHBACK WINDOW ' + DOT + ' REWARDS IN ' + c.sym : 'REWARDS IN ' + nativeUnit()) +
      ' ' +
      DOT +
      ' LIVE PREPARE'
    : (cb ? 'CASHBACK WINDOW ' + DOT + ' REWARDS IN ' + c.sym : 'REWARDS IN ' + nativeUnit()) +
      ' ' +
      DOT +
      ' SIMULATED';
  render(
    must('#stakeBody'),
    html`<div class="quad">
        <div>
          <div class="lbl">TOTAL STAKED</div>
          <div class="val am" id="sv-tot">${num(totalStaked(c))}</div>
          <span class="hint" id="sv-frac">${(stakedFrac(c) * 100).toFixed(1)}% OF CIRCULATING</span>
        </div>
        <div>
          <div class="lbl">YOUR STAKE</div>
          <div class="val gd" id="sv-you">${num(st.amt)}</div>
          <span class="hint" id="sv-mult"
            >${st.until > Date.now() ? st.mult + 'x ' + DOT + ' LOCKED' : 'NO LOCK ' + DOT + ' 1x'}</span
          >
        </div>
        <div>
          <div class="lbl">FEES TO POOL</div>
          <div class="val up" id="sv-pool">${(pie.stakers * 100).toFixed(1)}%</div>
          <span class="hint">OF EVERY CURVE FEE</span>
        </div>
        <div>
          <div class="lbl">YOUR EARNINGS</div>
          <div class="val up" id="sv-earn">${earnText(c)}</div>
          <span class="hint" id="sv-share">${(yourShare(c) * 100).toFixed(2)}% OF POOL</span>
        </div>
      </div>
      ${
        live
          ? html`<p class="hint" style="margin:0 0 10px">
              STAKE / UNSTAKE / CLAIM BUILD REAL TRANSACTIONS YOUR WALLET SIGNS ON THIS CLUSTER.
            </p>`
          : ''
      }
      <div class="stk-grid">
        <div>
          <canvas class="stk-pie" id="stkPie"></canvas>
          <div class="stk-legend">
            <div>
              <i style="background:${attr(PIE_COLOURS.stakers)}"></i>STAKING POOL<b id="lg-pool"
                >${(pie.stakers * 100).toFixed(1)}%</b
              >
            </div>
            <div>
              <i style="background:${attr(PIE_COLOURS.creator)}"></i>CREATOR<b id="lg-cre"
                >${(pie.creator * 100).toFixed(1)}%</b
              >
            </div>
            <div>
              <i style="background:${attr(PIE_COLOURS.protocol)}"></i>PROTOCOL<b
                >${(FEE_SPLIT.protocol * 100).toFixed(0)}%</b
              >
            </div>
            <div>
              <i style="background:${attr(PIE_COLOURS.stonkzOps)}"></i>STONKZ GAME<b
                >${(FEE_SPLIT.stonkzOps * 100).toFixed(0)}%</b
              >
            </div>
            <div>
              <i style="background:${attr(PIE_COLOURS.burn)}"></i>BURN<b
                >${(FEE_SPLIT.burn * 100).toFixed(0)}%</b
              >
            </div>
            <div>
              <i style="background:#2c3444"></i>TRADE FEE<b id="lg-fee">${effFee(c).toFixed(1)}%</b>
            </div>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;min-width:0">
          <div>
            <span class="lbl">AMOUNT (${c.sym})</span>
            <div class="fee-row">
              <input
                class="fld r"
                id="stk-amt"
                value=""
                placeholder="0"
                inputmode="decimal"
              /><button type="button" class="qa" id="stk-max" style="flex:0 0 54px">MAX</button>
            </div>
          </div>
          <div>
            <span class="lbl">LOCK ${DOT} WEIGHT MULTIPLIER</span>
            <div class="lock-row" id="lockRow">
              ${LOCKS.map(
                (l) =>
                  html`<button
                    type="button"
                    class="lock-opt${STK.lock === l[0] ? ' on' : ''}"
                    data-lock="${attr(l[0])}"
                  >
                    <span class="lm">${l[1]}x</span><span class="ld">${l[2]}</span>
                  </button>`,
              )}
            </div>
          </div>
          <div class="fee-row">
            <button type="button" class="big" id="stk-go" style="flex:1">STAKE</button
            ><button type="button" class="wiz-btn" id="stk-un" style="flex:0 0 108px">
              UNSTAKE
            </button>
          </div>
        </div>
      </div>
      <div class="stk-claim">
        <span class="lbl" style="margin:0">CLAIMABLE</span
        ><span class="v" id="sv-claim">${earnText(c)}</span><span class="grow"></span
        ><button type="button" class="claimbtn" id="stk-claim">CLAIM</button>
      </div>
      <p class="hint">
        STAKE WEIGHT = AMOUNT x LOCK MULTIPLIER. THE POOL TAKES HALF THE CREATOR BUCKET WHEN ALL
        CIRCULATING TOKENS ARE STAKED, SCALING DOWN FROM THERE ${DOT} THAT IS
        ${(FEE_SPLIT.creatorBucket * 50).toFixed(0)}% OF EVERY CURVE FEE AT
        MOST${cb ? '. DURING CASHBACK, REWARDS PAY IN ' + c.sym + '.' : '.'}
      </p>`,
  );
  drawPie($<HTMLCanvasElement>('#stkPie'), poolFrac(c));
  refreshScrim('#stakeScrim');

  must('#stk-max').addEventListener('click', () => {
    const h = holdOf(c.sym);
    must<HTMLInputElement>('#stk-amt').value = String(h ? Math.floor(h.tok) : 0);
  });
  const lockRow = must('#lockRow');
  lockRow.addEventListener('click', (e) => {
    const b = (e.target as Element | null)?.closest<HTMLElement>('[data-lock]');
    if (!b) return;
    STK.lock = Number(b.dataset['lock']);
    for (const x of Array.from(lockRow.children)) x.classList.toggle('on', x === b);
  });
  must('#stk-go').addEventListener('click', () => void doStake(c, 1));
  must('#stk-un').addEventListener('click', () => void doStake(c, -1));
  must('#stk-claim').addEventListener('click', () => void doClaim(c));
}

/** Patch the live numbers without rebuilding the dialog. `index.html:3151` */
export function syncStake(): void {
  const c = STK.c;
  if (!c) return;
  const pie = feePie(1, poolFrac(c));
  const set = (id: string, v: string): void => {
    const e = $(id);
    if (e && e.textContent !== v) e.textContent = v;
  };
  const st = ensureStake(c.sym);
  set('#sv-tot', num(totalStaked(c)));
  set('#sv-frac', (stakedFrac(c) * 100).toFixed(1) + '% OF CIRCULATING');
  set('#sv-you', num(st.amt));
  set('#sv-pool', (pie.stakers * 100).toFixed(1) + '%');
  set('#sv-share', (yourShare(c) * 100).toFixed(2) + '% OF POOL');
  set('#lg-pool', (pie.stakers * 100).toFixed(1) + '%');
  set('#lg-cre', (pie.creator * 100).toFixed(1) + '%');
  set('#lg-fee', effFee(c).toFixed(1) + '%');
  const earn = earnText(c);
  set('#sv-earn', earn);
  set('#sv-claim', earn);
}

async function doStake(c: SimCoin, dir: 1 | -1): Promise<void> {
  const input = must<HTMLInputElement>('#stk-amt');
  const amt = Math.max(0, parseFloat(input.value) || 0);
  if (amt <= 0) {
    toast('ENTER AN AMOUNT FIRST');
    return;
  }
  const st = ensureStake(c.sym);
  if (dir > 0) {
    const h = holdOf(c.sym);
    if (!h || h.tok < amt) {
      toast('NOT ENOUGH ' + c.sym + ' ' + DOT + ' BUY SOME FIRST');
      return;
    }
    const L = LOCKS.find((l) => l[0] === STK.lock) ?? (LOCKS[0] as (typeof LOCKS)[number]);
    try {
      await api.stake({ sym: c.sym, amount: amt, days: L[0], mult: L[1] });
    } catch (err) {
      toast(err instanceof Error ? err.message.toUpperCase() : 'STAKE FAILED', 'red');
      return;
    }
    toast(
      'STAKED ' +
        num(amt) +
        ' ' +
        c.sym +
        (L[0] ? ' ' + DOT + ' ' + L[2] + ' LOCK ' + L[1] + 'x' : '') +
        (api.mode === 'live' ? '' : ' ' + DOT + ' SIMULATED'),
    );
    void circ(c);
  } else {
    if (st.until > Date.now()) {
      toast('LOCKED UNTIL ' + new Date(st.until).toLocaleDateString());
      return;
    }
    if (st.amt < amt) {
      toast('YOU ONLY HAVE ' + num(st.amt) + ' STAKED');
      return;
    }
    // The adapter unstakes the whole position; the oracle allowed partials, so
    // re-stake the remainder in the same beat rather than change the contract.
    const back = await api.unstake(c.sym);
    const keep = back - amt;
    if (keep > 0) await api.stake({ sym: c.sym, amount: keep, days: st.days, mult: st.mult });
    toast('UNSTAKED ' + num(amt) + ' ' + c.sym);
  }
  saveUser();
  input.value = '';
  renderStake(c);
  afterChange();
}

async function doClaim(c: SimCoin): Promise<void> {
  const res = await api.claimStake(c.sym);
  if (res.tokens <= 0 && res.native <= 0) {
    toast('NOTHING TO CLAIM YET');
    return;
  }
  const parts = [
    res.tokens > 0 ? num(res.tokens) + ' ' + c.sym : '',
    res.tokens > 0 && res.native > 0 ? ' + ' : '',
    res.native > 0 ? res.native.toFixed(4) + ' ' + nativeUnit() : '',
  ];
  toast('CLAIMED ' + parts.join(''));
  void price(c);
  renderStake(c);
  afterChange();
}

export function openStake(c: SimCoin, opener?: Element | null): void {
  STK.c = c;
  STK.lock = 0;
  const st = ensureStake(c.sym);
  if (st.until > Date.now()) STK.lock = st.days;
  renderStake(c);
  openScrim('#stakeScrim', opener);
  if (api.mode === 'live' && api.hydrateStake) {
    void api.hydrateStake(c.sym).then(() => {
      if (STK.c === c) renderStake(c);
    });
  }
}

export function closeStake(): void {
  closeScrim('#stakeScrim');
  STK.c = null;
}

export function isStakeOpen(): boolean {
  return isOpen('#stakeScrim');
}

export function initStake(onChange: () => void): void {
  afterChange = onChange;
  wireBackdrop('#stakeScrim', closeStake);
}
