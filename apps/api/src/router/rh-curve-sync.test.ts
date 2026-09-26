import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/client.js';
import {
  COINS_REAL_BASE_WORD,
  COINS_REAL_TOKEN_WORD,
  fetchRhCurveReserves,
  parseCoinsReserves,
  syncRhCurveReserves,
} from './rh-curve-sync.js';

function word(n: bigint): string {
  return n.toString(16).padStart(64, '0');
}

function fakeCoinsReturn(realBase: bigint, realToken: bigint): string {
  const words = Array.from({ length: COINS_REAL_TOKEN_WORD + 1 }, () => word(0n));
  words[0] = word(0x821742f0169c261aa4b7d6602b6c40b1615abc0en); // token
  words[COINS_REAL_BASE_WORD] = word(realBase);
  words[COINS_REAL_TOKEN_WORD] = word(realToken);
  return `0x${words.join('')}`;
}

describe('parseCoinsReserves', () => {
  it('reads realBase/realToken from the coins tuple word layout', () => {
    const parsed = parseCoinsReserves(
      fakeCoinsReturn(16_067_767n, 796_287_110_083_350_154_883_749_421n),
    );
    expect(parsed).toEqual({
      realBase: '16067767',
      realToken: '796287110083350154883749421',
    });
  });

  it('returns null for an empty coin', () => {
    expect(parseCoinsReserves(`0x${word(0n).repeat(16)}`)).toBeNull();
  });
});

describe('syncRhCurveReserves', () => {
  const baseRow = {
    net: 'RH' as const,
    sym: 'COPIUM',
    mint: '0x821742F0169c261aa4B7d6602B6c40B1615aBC0e',
    baseMint: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    baseSymbol: 'USDC',
    name: 'Copium',
    graduatedAt: null,
    tokenDecimals: 18,
    baseDecimals: 6,
    basePriceUsd1e6: '1000000',
    curveTokensForSale: '1',
    curveVirtualBase0: '1',
    curveVirtualToken0: '1',
    curveK: '1',
    curveRealBase: '0',
    curveRealToken: '800000000000000000000000000',
    curveGradMcapBase: '1',
  };

  it('updates the in-memory row and persists when chain reserves differ', async () => {
    const update = vi.fn(async () => undefined);
    const set = vi.fn(() => ({ where: update }));
    const dbMock = { update: vi.fn(() => ({ set })) };
    const db = dbMock as unknown as Db;
    const eth = {
      ethCall: vi.fn(async () => fakeCoinsReturn(16_067_767n, 100n)),
    };

    const next = await syncRhCurveReserves({
      db,
      eth,
      launchpad: '0x2588E500B1e5fCF18253F44b6f2607BF2B14161C',
      row: baseRow,
    });

    expect(next.curveRealBase).toBe('16067767');
    expect(next.curveRealToken).toBe('100');
    expect(eth.ethCall).toHaveBeenCalledOnce();
    expect(dbMock.update).toHaveBeenCalledOnce();
  });

  it('does not persist when reserves already match', async () => {
    const eth = {
      ethCall: vi.fn(async () => fakeCoinsReturn(0n, 800_000_000_000_000_000_000_000_000n)),
    };
    const dbMock = { update: vi.fn() };
    const db = dbMock as unknown as Db;
    const next = await syncRhCurveReserves({
      db,
      eth,
      launchpad: '0x2588E500B1e5fCF18253F44b6f2607BF2B14161C',
      row: { ...baseRow, curveRealBase: '0', curveRealToken: '800000000000000000000000000' },
    });
    expect(next.curveRealBase).toBe('0');
    expect(dbMock.update).not.toHaveBeenCalled();
  });
});

describe('fetchRhCurveReserves', () => {
  it('returns null when launchpad is unset', async () => {
    await expect(
      fetchRhCurveReserves(
        { ethCall: async () => '0x' },
        '0x0000000000000000000000000000000000000000',
        '0x11',
      ),
    ).resolves.toBeNull();
  });
});
