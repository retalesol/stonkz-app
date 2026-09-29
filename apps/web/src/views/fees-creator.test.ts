import { describe, expect, it } from 'vitest';
import type { TokenFees } from '@stonkz/shared';
import { creatorPanel, creatorPanelHTML, isSameWallet } from './fees-creator.js';

const CREATOR = '0x1FA9D4Ad76D53FbF1274d10ACBA12463ae90Bdca';

function fees(over: Partial<NonNullable<TokenFees['creator']>> = {}): TokenFees {
  return {
    sym: 'MEMEMAN',
    net: 'BASE',
    unit: 'ETH',
    feeBps: 200,
    effFeeBps: 200,
    split: { protocol: 0.15, creatorBucket: 0.69, buyback: 0.1, rwa: 0.06 },
    totals: {
      gross: 0.0004,
      protocol: 0.00006,
      buyback: 0.00004,
      rwa: 0.000024,
      creatorBucket: 0.000276,
      creator: 0.000276,
      stakers: 0,
      referrals: 0,
    },
    source: 'chain',
    creator: {
      wallet: CREATOR,
      claimableBase: 0.000276,
      baseSym: 'WETH',
      claimableTokens: 0,
      claimedNative: 0,
      source: 'chain',
      ...over,
    },
  };
}

const nat = (v: number): string => v.toFixed(6) + ' ETH';

describe('creatorPanel', () => {
  it('shows the creator their claimable base in the curve asset, from the chain', () => {
    const p = creatorPanel({ fees: fees(), viewer: CREATOR.toLowerCase(), nat });
    expect(p?.isCreator).toBe(true);
    expect(p?.canClaim).toBe(true);
    expect(p?.amountLabel).toBe('0.000276 WETH');
    expect(p?.sourceLabel).toMatch(/PROGRAM/);
    expect(String(creatorPanelHTML(p, 'MEMEMAN'))).toContain('id="fc-claim"');
    expect(String(creatorPanelHTML(p, 'MEMEMAN'))).not.toContain('disabled');
  });

  it('adds the cashback token slice and disables the button when nothing is owed', () => {
    const both = creatorPanel({
      fees: fees({ claimableTokens: 1234.5 }),
      viewer: CREATOR,
      nat,
    });
    // `num` rounds whole tokens the way the rest of the terminal does.
    expect(both?.amountLabel).toBe('0.000276 WETH + 1,235 MEMEMAN');

    const none = creatorPanel({
      fees: fees({ claimableBase: 0, claimableTokens: 0, source: 'indexer' }),
      viewer: CREATOR,
      nat,
    });
    expect(none?.canClaim).toBe(false);
    expect(none?.amountLabel).toBe('NOTHING TO CLAIM YET');
    expect(none?.sourceLabel).toMatch(/INDEXER/);
    expect(String(creatorPanelHTML(none, 'MEMEMAN'))).toContain('disabled');
  });

  it('renders nothing for anyone but the creator, and nothing without a creator block', () => {
    const stranger = creatorPanel({
      fees: fees(),
      viewer: '0x00000000000000000000000000000000000000c1',
      nat,
    });
    expect(stranger?.isCreator).toBe(false);
    expect(String(creatorPanelHTML(stranger, 'MEMEMAN'))).toBe('');
    const signedOut = creatorPanel({ fees: fees(), viewer: '', nat });
    expect(signedOut?.isCreator).toBe(false);
    const f = fees();
    delete f.creator;
    expect(creatorPanel({ fees: f, viewer: CREATOR, nat })).toBeNull();
  });

  it('compares EVM wallets case-insensitively and Solana wallets exactly', () => {
    expect(isSameWallet('BASE', CREATOR, CREATOR.toLowerCase())).toBe(true);
    expect(isSameWallet('SOL', 'AbC', 'abc')).toBe(false);
    expect(isSameWallet('SOL', '', '')).toBe(false);
  });
});
