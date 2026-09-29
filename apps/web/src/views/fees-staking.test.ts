import { describe, expect, it } from 'vitest';
import type { Stake, StakePoolSummary } from '@stonkz/shared';
import { stakingSectionHTML } from './fees-staking.js';

const NOW = Date.parse('2026-09-29T12:00:00.000Z');
const nat = (v: number): string => v.toFixed(4) + ' ETH';

const MEMEMAN_POOL: StakePoolSummary = {
  totalStaked: 6182,
  eligibleStaked: 0,
  flexStaked: 6182,
  totalWeight: 0,
  stakers: 1,
  circulating: 100_000,
  stakedFrac: 0.06182,
  bucketShare: 0,
  feeShare: 0,
  lifetimeNative: 0,
  lifetimeBase: 0,
  baseSym: 'WETH',
  source: 'chain',
};

function render(pool: StakePoolSummary, viewer: Stake | null): string {
  // Collapse whitespace the way the browser does, so wrapped template text still matches.
  return stakingSectionHTML({
    sym: 'MEMEMAN',
    unit: 'ETH',
    pool,
    viewer,
    nat,
    now: NOW,
  }).value.replace(/\s+/g, ' ');
}

describe('Fees tab staking section', () => {
  it('shows the pool totals, stakers and the bucket share', () => {
    const out = render(
      {
        ...MEMEMAN_POOL,
        eligibleStaked: 10_000,
        totalStaked: 16_182,
        stakedFrac: 0.16182,
        bucketShare: 0.05,
        feeShare: 0.0345,
        stakers: 2,
        lifetimeNative: 0.125,
        source: 'indexer',
      },
      null,
    );
    expect(out).toContain('16,182 MEMEMAN');
    expect(out).toContain('16.2% OF CIRCULATING');
    expect(out).toMatch(/id="fs-stakers">2</);
    expect(out).toContain('10,000 LOCKED');
    expect(out).toContain('6,182 FLEX (EARNS NOTHING)');
    expect(out).toContain('>5.0%<');
    expect(out).toContain('3.45% OF EVERY FEE');
    expect(out).toContain('0.1250 ETH');
    expect(out).toContain('CONNECT A WALLET TO SEE YOUR POSITION');
  });

  it("shows the signed-in viewer's FLEX position (the MEMEMAN case)", () => {
    const viewer: Stake = {
      amt: 6182,
      mult: 0,
      days: 0,
      until: NOW - 1,
      rewTok: 0,
      rewSol: 0,
      weight: 0,
      source: 'indexer',
    };
    const out = render(MEMEMAN_POOL, viewer);
    expect(out).toContain('6,182 MEMEMAN');
    expect(out).toContain('READ ON CHAIN');
    expect(out).toContain('YOUR POSITION');
    expect(out).toContain('FLEX IS PARKED, EARNS NO FEES');
    expect(out).toContain('>0.0%<');
  });

  it('says so when a signed-in viewer has nothing staked', () => {
    const out = render(MEMEMAN_POOL, { amt: 0, mult: 0, days: 0, until: 0, rewTok: 0, rewSol: 0 });
    expect(out).toContain('YOU HAVE NOTHING STAKED IN MEMEMAN');
  });

  it('reports lifetime earnings in the base asset when only the chain knows them', () => {
    const out = render({ ...MEMEMAN_POOL, lifetimeBase: 0.02 }, null);
    expect(out).toContain('0.020000 WETH');
  });
});
