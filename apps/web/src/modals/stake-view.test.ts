import { describe, expect, it } from 'vitest';
import type { Stake, StakePoolSummary } from '@stonkz/shared';
import { rewardText, stakePanel, stakePanelHTML, weightText } from './stake-view.js';

/**
 * The stake dialog's position panel, rendered without a DOM. The first case
 * is the MEMEMAN report: 6,182 tokens staked FLEX on BASE, read on chain.
 */

const NOW = Date.parse('2026-09-29T12:00:00.000Z');
const DAY = 86_400_000;

function stake(over: Partial<Stake> = {}): Stake {
  return { amt: 0, mult: 0, days: 0, until: 0, rewTok: 0, rewSol: 0, ...over };
}

const POOL: StakePoolSummary = {
  totalStaked: 16_182,
  eligibleStaked: 10_000,
  flexStaked: 6_182,
  totalWeight: 15_000,
  stakers: 2,
  circulating: 100_000,
  stakedFrac: 0.16182,
  bucketShare: 0.05,
  feeShare: 0.0345,
  lifetimeNative: 0,
  source: 'indexer',
};

const panel = (st: Stake | null, live = true) =>
  stakePanel({ sym: 'MEMEMAN', st, pool: POOL, unit: 'ETH', live, now: NOW });

describe('stake dialog position panel', () => {
  it('shows a FLEX position as staked, unlocked, unstakeable and earning nothing', () => {
    const st = stake({
      amt: 6182,
      days: 0,
      until: NOW - 60_000,
      weight: 0,
      source: 'chain',
      baseSym: 'WETH',
      rewBase: 0,
    });
    const p = panel(st);
    expect(p).toMatchObject({
      has: true,
      amount: 6182,
      unstakeable: 6182,
      locked: false,
      lockLabel: 'FLEX',
      unlockLabel: 'UNLOCKED',
      mult: 0,
      earns: false,
      canClaim: false,
      source: 'chain',
    });
    const markup = stakePanelHTML(p, 'MEMEMAN').value.replace(/\s+/g, ' ');
    expect(markup).toContain('6,182 MEMEMAN');
    expect(markup).toContain('READ ON CHAIN');
    expect(markup).toContain('UNSTAKEABLE NOW: 6,182 MEMEMAN');
    expect(markup).toContain('id="stk-unall"');
    expect(markup).not.toContain('id="stk-claim"');
    expect(markup).toContain('FLEX IS PARKED, EARNS NO FEES');
  });

  it('holds a locked position: unlock time, no unstake, weight and pool share', () => {
    const st = stake({
      amt: 10_000,
      days: 30,
      until: NOW + 30 * DAY,
      weight: 15_000,
      source: 'chain',
    });
    const p = panel(st);
    expect(p).toMatchObject({
      locked: true,
      unstakeable: 0,
      lockLabel: '30D',
      mult: 1.5,
      earns: true,
      poolShare: 1,
    });
    expect(p.unlockLabel).toBe('UNLOCKS 2026-10-29 12:00 UTC (IN 30d 0h)');
    const markup = stakePanelHTML(p, 'MEMEMAN').value.replace(/\s+/g, ' ');
    expect(markup).toContain('UNSTAKEABLE NOW: 0');
    expect(markup).not.toContain('id="stk-unall"');
    expect(weightText(p)).toContain('1.5x');
    expect(weightText(p)).toContain('100.00% OF POOL');
  });

  it('offers CLAIM once rewards are pending, in the base asset', () => {
    const st = stake({
      amt: 1000,
      days: 7,
      until: NOW - 1,
      weight: 1250,
      rewBase: 0.0015,
      baseSym: 'WETH',
      rewTok: 12,
    });
    const p = panel(st);
    expect(p.canClaim).toBe(true);
    expect(p.rewardLabel).toBe('0.001500 WETH + 12 MEMEMAN');
    expect(stakePanelHTML(p, 'MEMEMAN').value.replace(/\s+/g, ' ')).toContain('id="stk-claim"');
  });

  it('renders "nothing staked" with no position and no actions', () => {
    for (const st of [null, stake()]) {
      const p = panel(st);
      expect(p.has).toBe(false);
      const markup = stakePanelHTML(p, 'MEMEMAN').value.replace(/\s+/g, ' ');
      expect(markup).toContain('NOTHING STAKED IN MEMEMAN YET');
      expect(markup).not.toContain('id="stk-unall"');
      expect(markup).not.toContain('id="stk-claim"');
    }
  });

  it('keeps the sandbox 1x FLEX outside live mode', () => {
    const p = panel(stake({ amt: 50, mult: 1, days: 0 }), false);
    expect(p.mult).toBe(1);
    expect(p.earns).toBe(true);
  });

  it('falls back to the native unit when only a native reward is known', () => {
    expect(rewardText(stake({ rewSol: 0.25 }), 'MEMEMAN', 'ETH')).toBe('0.2500 ETH');
    expect(rewardText(null, 'MEMEMAN', 'ETH')).toBe('0 ETH');
  });
});
