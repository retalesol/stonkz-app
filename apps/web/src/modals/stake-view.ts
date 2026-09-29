import {
  chainLockMult,
  num,
  unstakeableAmount,
  type Stake,
  type StakePoolSummary,
} from '@stonkz/shared';
import { DOT, cdText } from '../lib/fmt.js';
import { type Html, html } from '../lib/html.js';

/**
 * The stake dialog's "your position" panel, as a pure function of the
 * position, the pool and the clock — so it can be tested without a DOM and
 * so the dialog and the Fees tab describe a position in the same words.
 *
 * Live positions follow the programs: FLEX (0 days) is parked with **zero**
 * weight and earns nothing; a lock's weight is `amount x` its multiplier; an
 * unstake is refused while `until` is in the future, and any amount up to the
 * whole position is allowed after it.
 */

export interface StakePanelInput {
  sym: string;
  st: Stake | null;
  pool: StakePoolSummary | null;
  /** The chain's native unit, for positions that only know `rewSol`. */
  unit: string;
  /** Live (chain) semantics: FLEX earns nothing. Sim keeps the sandbox's 1x FLEX. */
  live: boolean;
  now: number;
}

export interface StakePanel {
  has: boolean;
  amount: number;
  /** What an unstake may take right now: 0 while locked, the whole position after. */
  unstakeable: number;
  locked: boolean;
  /** `FLEX` or `30D`, …. */
  lockLabel: string;
  /** `UNLOCKED` or `UNLOCKS 2026-10-06 12:00 UTC (IN 7d 0h)`. */
  unlockLabel: string;
  mult: number;
  weight: number;
  /** Share of the pool's weight, 0..1. */
  poolShare: number;
  /** Earns a share of the creator bucket at all. */
  earns: boolean;
  rewardLabel: string;
  canClaim: boolean;
  source: 'chain' | 'indexer' | 'local';
}

function lockName(days: number): string {
  if (days <= 0) return 'FLEX';
  return days === 365 ? '1Y' : days + 'D';
}

function utc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

export function rewardText(st: Stake | null, sym: string, unit: string): string {
  if (!st) return '0 ' + unit;
  const parts: string[] = [];
  if ((st.rewBase ?? 0) > 0) parts.push((st.rewBase ?? 0).toFixed(6) + ' ' + (st.baseSym || unit));
  else if (st.rewSol > 0) parts.push(st.rewSol.toFixed(4) + ' ' + unit);
  if (st.rewTok > 0) parts.push(num(st.rewTok) + ' ' + sym);
  return parts.length ? parts.join(' + ') : '0 ' + (st.baseSym || unit);
}

export function stakePanel(input: StakePanelInput): StakePanel {
  const { st, pool, live, now, sym, unit } = input;
  const amount = st && st.amt > 0 ? st.amt : 0;
  const days = st?.days ?? 0;
  const mult = live
    ? st && st.weight !== undefined && amount > 0
      ? st.weight / amount
      : chainLockMult(days)
    : st?.mult || 1;
  const weight = live ? (st?.weight ?? amount * chainLockMult(days)) : amount * mult;
  const locked = amount > 0 && (st?.until ?? 0) > now;
  const canClaim = !!st && ((st.rewBase ?? 0) > 0 || st.rewTok > 0 || st.rewSol > 0);
  return {
    has: amount > 0 || canClaim,
    amount,
    unstakeable: unstakeableAmount(st, now),
    locked,
    lockLabel: lockName(days),
    unlockLabel:
      locked && st
        ? 'UNLOCKS ' + utc(st.until) + ' (IN ' + cdText(st.until - now) + ')'
        : 'UNLOCKED',
    mult,
    weight,
    poolShare:
      pool && pool.totalWeight > 0 && weight > 0 ? Math.min(1, weight / pool.totalWeight) : 0,
    earns: weight > 0,
    rewardLabel: rewardText(st, sym, unit),
    canClaim,
    source: st?.source ?? 'local',
  };
}

/** One line describing the weight, shared with the Fees tab. */
export function weightText(p: StakePanel): string {
  if (!p.earns) return '0x ' + DOT + ' FLEX IS PARKED, EARNS NO FEES';
  return (
    +p.mult.toFixed(2) +
    'x ' +
    DOT +
    ' ' +
    num(p.weight) +
    ' WEIGHT ' +
    DOT +
    ' ' +
    (p.poolShare * 100).toFixed(2) +
    '% OF POOL'
  );
}

export function stakePanelHTML(p: StakePanel, sym: string): Html {
  if (!p.has) {
    return html`<div class="stk-claim" id="stk-pos">
      <span class="lbl" style="margin:0">YOUR POSITION</span>
      <span class="hint" id="stk-pos-none">NOTHING STAKED IN ${sym} YET</span>
    </div>`;
  }
  return html`<div class="stk-claim" id="stk-pos" style="display:block">
    <div class="lbl" style="margin:0 0 4px">YOUR POSITION</div>
    <div class="quad" style="margin:0 0 8px">
      <div>
        <div class="lbl">STAKED</div>
        <div class="val gd" id="stk-pos-amt">${num(p.amount)} ${sym}</div>
        <span class="hint" id="stk-pos-src"
          >${p.source === 'chain' ? 'READ ON CHAIN' : p.source === 'indexer' ? 'FROM THE INDEXER' : 'LOCAL'}</span
        >
      </div>
      <div>
        <div class="lbl">LOCK</div>
        <div class="val am" id="stk-pos-lock">${p.lockLabel}</div>
        <span class="hint" id="stk-pos-until">${p.unlockLabel}</span>
      </div>
      <div>
        <div class="lbl">WEIGHT</div>
        <div class="val${p.earns ? ' up' : ' dn'}" id="stk-pos-mult">${+p.mult.toFixed(2)}x</div>
        <span class="hint" id="stk-pos-weight">${weightText(p)}</span>
      </div>
      <div>
        <div class="lbl">PENDING REWARDS</div>
        <div class="val up" id="stk-pos-rew">${p.rewardLabel}</div>
        <span class="hint">${p.canClaim ? 'CLAIMABLE NOW' : 'NOTHING TO CLAIM YET'}</span>
      </div>
    </div>
    <div class="fee-row">
      <span class="hint" id="stk-pos-unst" style="flex:1"
        >${p.unstakeable > 0 ? 'UNSTAKEABLE NOW: ' + num(p.unstakeable) + ' ' + sym : 'UNSTAKEABLE NOW: 0 ' + DOT + ' LOCKED'}</span
      >${p.unstakeable > 0 ? html`<button type="button" class="wiz-btn" id="stk-unall" style="flex:0 0 140px">UNSTAKE ALL</button>` : ''}${p.canClaim ? html`<button type="button" class="claimbtn" id="stk-claim">CLAIM</button>` : ''}
    </div>
  </div>`;
}
