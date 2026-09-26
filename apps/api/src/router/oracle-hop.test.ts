import { describe, expect, it } from 'vitest';
import { FakePriceOracle } from '../chain/fake.js';
import { createBaseMintRegistry } from './base-mints.js';
import { NATIVE_ETH_MINT } from './compose.js';
import { convertByUsd, isOracleHopRaw, OracleHopClient } from './oracle-hop.js';

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
