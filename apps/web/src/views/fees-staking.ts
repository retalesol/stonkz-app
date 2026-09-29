import { num, type Stake, type StakePoolSummary } from '@stonkz/shared';
import { DOT } from '../lib/fmt.js';
import { type Html, html } from '../lib/html.js';
import { stakePanel, weightText } from '../modals/stake-view.js';

/**
 * The Fees tab's staking section: the coin's pool (total staked, stakers,
 * the pool's current cut of the creator bucket, lifetime staker earnings) and
 * the signed-in viewer's own position. Pure, so it renders the same in tests.
 */

export interface StakingSectionInput {
  sym: string;
  unit: string;
  pool: StakePoolSummary;
  /** The viewer's position; `null` when no wallet is signed in. */
  viewer: Stake | null;
  /** Formats a native amount (the tab's own `nat`). */
  nat: (v: number) => string;
  now: number;
}

export function stakingSectionHTML(input: StakingSectionInput): Html {
  const { sym, unit, pool, viewer, nat, now } = input;
  const pct = (v: number, d = 1): string => (v * 100).toFixed(d) + '%';
  const lifetime =
    pool.lifetimeNative > 0 || !(pool.lifetimeBase ?? 0)
      ? nat(pool.lifetimeNative)
      : (pool.lifetimeBase ?? 0).toFixed(6) + ' ' + (pool.baseSym || unit);
  const panel = viewer ? stakePanel({ sym, st: viewer, pool, unit, live: true, now }) : null;
  return html`<div class="stk-fees" id="fees-staking">
    <div class="lbl" style="margin:10px 0 6px">STAKING</div>
    <div class="quad" style="margin:0">
      <div>
        <div class="lbl">TOTAL STAKED</div>
        <div class="val am" id="fs-total">${num(pool.totalStaked)} ${sym}</div>
        <span class="hint" id="fs-frac">${pct(pool.stakedFrac)} OF CIRCULATING</span>
      </div>
      <div>
        <div class="lbl">STAKERS</div>
        <div class="val" id="fs-stakers">${num(pool.stakers)}</div>
        <span class="hint" id="fs-split"
          >${num(pool.eligibleStaked)} LOCKED ${DOT} ${num(pool.flexStaked)} FLEX (EARNS
          NOTHING)</span
        >
      </div>
      <div>
        <div class="lbl">POOL'S CUT NOW</div>
        <div class="val up" id="fs-share">${pct(pool.bucketShare)}</div>
        <span class="hint" id="fs-fee"
          >OF THE 69% CREATOR BUCKET ${DOT} ${pct(pool.feeShare, 2)} OF EVERY FEE ${DOT} UP TO
          HALF</span
        >
      </div>
      <div>
        <div class="lbl">STAKERS EARNED</div>
        <div class="val gd" id="fs-earned">${lifetime}</div>
        <span class="hint"
          >LIFETIME${pool.source === 'chain' ? ' ' + DOT + ' READ ON CHAIN' : ''}</span
        >
      </div>
    </div>
    <div class="fee-row" id="fs-you">
      ${
        !panel
          ? html`<span class="hint">CONNECT A WALLET TO SEE YOUR POSITION</span>`
          : !panel.has
            ? html`<span class="hint">YOU HAVE NOTHING STAKED IN ${sym}</span>`
            : html`<span class="hint"
                >YOUR POSITION ${DOT} ${num(panel.amount)} ${sym} ${DOT} ${panel.lockLabel} ${DOT}
                ${panel.unlockLabel} ${DOT} ${weightText(panel)} ${DOT} PENDING
                ${panel.rewardLabel}</span
              >`
      }
    </div>
  </div>`;
}
