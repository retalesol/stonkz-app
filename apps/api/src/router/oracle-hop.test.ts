import { describe, expect, it } from 'vitest';
import { FakePriceOracle } from '../chain/fake.js';
import { createBaseMintRegistry } from './base-mints.js';
import { NATIVE_ETH_MINT } from './compose.js';
import { NoRouteError } from './errors.js';
import { convertByUsd, isOracleHopRaw, OracleHopClient } from './oracle-hop.js';
import { STATIC_PRICES_REFUSED } from './price-policy.js';

const WETH = '0x7943e237c7F95DA44E0301572D358911207852Fa';
const USDG = '0x7E955252E15c84f5768B83c41a71F9eba181802F';

describe('convertByUsd', () => {
  it('prices 0.01 ETH at $3000 into 30 USDG (6dp)', () => {
    const ethIn = 10n ** 16n; // 0.01 ETH
    const out = convertByUsd(ethIn, 18, 3_000_000_000n, 6, 1_000_000n);
    expect(out).toBe(30_000_000n);
  });

  it('prices 30 USDG back into 0.01 ETH at $3000', () => {
    const out = convertByUsd(30_000_000n, 6, 1_000_000n, 18, 3_000_000_000n);
    expect(out).toBe(10n ** 16n);
  });
});

describe('OracleHopClient', () => {
  const baseMints = createBaseMintRegistry({
    RH: { WETH, USDG, ETH: NATIVE_ETH_MINT },
  });
  const oracle = new FakePriceOracle({ ETH: 3000, SOL: 150, USDC: 1 });
  const client = new OracleHopClient({ oracle, baseMints, wethMint: WETH });

  it('quotes buy ETH → USDG', async () => {
    const q = await client.quote({
      inMint: NATIVE_ETH_MINT,
      outMint: USDG,
      inAmountAtoms: 10n ** 16n,
      slippagePct: 1,
    });
    expect(q.outAmountAtoms).toBe(30_000_000n);
    expect(isOracleHopRaw(q.raw)).toBe(true);
    if (isOracleHopRaw(q.raw)) {
      expect(q.raw.inSymbol).toBe('ETH');
      expect(q.raw.outSymbol).toBe('USDG');
    }
  });

  it('quotes sell USDG → ETH (WETH mint out)', async () => {
    const q = await client.quote({
      inMint: USDG,
      outMint: WETH,
      inAmountAtoms: 30_000_000n,
      slippagePct: 1,
    });
    expect(q.outAmountAtoms).toBe(10n ** 16n);
  });
});

describe('OracleHopClient static table policy', () => {
  const BTC = '0x00000000000000000000000000000000000b7c01';
  const baseMints = createBaseMintRegistry({
    RH: { WETH, USDG, ETH: NATIVE_ETH_MINT, BTC },
  });
  const oracle = new FakePriceOracle({ ETH: 3000, SOL: 150, USDC: 1 });
  const req = { inMint: NATIVE_ETH_MINT, outMint: BTC, inAmountAtoms: 10n ** 18n, slippagePct: 1 };

  it('prices an RH major from the table in dev/test', async () => {
    const client = new OracleHopClient({ oracle, baseMints, wethMint: WETH });
    const q = await client.quote(req);
    // 1 ETH at $3000 → BTC at the table's $95,000.
    expect(Number(q.outAmountAtoms) / 1e18).toBeCloseTo(3000 / 95_000, 9);
  });

  it('has no route for that major in production (no table dollar), while stables still quote', async () => {
    const client = new OracleHopClient({
      oracle,
      baseMints,
      wethMint: WETH,
      staticPrices: STATIC_PRICES_REFUSED,
    });
    await expect(client.quote(req)).rejects.toBeInstanceOf(NoRouteError);
    const usdg = await client.quote({ ...req, outMint: USDG, inAmountAtoms: 10n ** 16n });
    expect(usdg.outAmountAtoms).toBe(30_000_000n);
  });
});
