import { describe, expect, it } from 'vitest';
import { NoRouteError } from './errors.js';
import type { AggregatorQuote, AggregatorQuoteRequest } from './aggregator.js';
import { OracleHopClient } from './oracle-hop.js';
import { ResilientUniswapClient } from './resilient-uniswap.js';
import type { UniswapClient, UniswapQuoteResponseRaw, UniswapSwapResponseRaw } from './uniswap.js';
import { FakePriceOracle } from '../chain/fake.js';
import { createBaseMintRegistry } from './base-mints.js';
import { NATIVE_ETH_MINT } from './compose.js';

const WETH = '0x7943e237c7F95DA44E0301572D358911207852Fa';
const USDG = '0x7E955252E15c84f5768B83c41a71F9eba181802F';

class FailingUniswap implements UniswapClient {
  readonly venue = 'UNISWAP' as const;
  async quote(req: AggregatorQuoteRequest): Promise<AggregatorQuote> {
    throw new NoRouteError(req.inMint, req.outMint, new Error('HTTP 400: chain unsupported'));
  }
  async swap(_q: UniswapQuoteResponseRaw): Promise<UniswapSwapResponseRaw> {
    throw new Error('unreachable');
  }
}

describe('ResilientUniswapClient', () => {
  it('falls back to the oracle hop when Trading API has no route', async () => {
    const baseMints = createBaseMintRegistry({ RH: { WETH, USDG, ETH: NATIVE_ETH_MINT } });
    const oracle = new OracleHopClient({
      oracle: new FakePriceOracle({ ETH: 3000, SOL: 150 }),
      baseMints,
      wethMint: WETH,
    });
    const client = new ResilientUniswapClient(new FailingUniswap(), oracle);
    const q = await client.quote({
      inMint: NATIVE_ETH_MINT,
      outMint: USDG,
      inAmountAtoms: 10n ** 16n,
      slippagePct: 0,
    });
    expect(q.outAmountAtoms).toBe(30_000_000n);
  });
});
