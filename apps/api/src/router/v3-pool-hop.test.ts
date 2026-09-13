import { describe, expect, it } from 'vitest';
import { createBaseMintRegistry } from './base-mints.js';
import { NATIVE_ETH_MINT } from './compose.js';
import { NoRouteError } from './errors.js';
import { isV3PoolHopRaw, V3PoolHopClient, type EthCaller } from './v3-pool-hop.js';

const WETH = '0x7943e237c7F95DA44E0301572D358911207852Fa';
const USDG = '0x7E955252E15c84f5768B83c41a71F9eba181802F';
const FACTORY = '0xdf9e3D6ffaC4513dD7b053212bbECcbCD15ec932';
const QUOTER = '0x1111111111111111111111111111111111111111';
const POOL = '0x2222222222222222222222222222222222222222';

function encodeAddress(addr: string): string {
  return addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

describe('V3PoolHopClient', () => {
  it('quotes via eth_call when the pinned pool has liquidity', async () => {
    const calls: { to: string; data: string }[] = [];
    const eth: EthCaller = {
      async ethCall(to, data) {
        calls.push({ to, data });
        const sel = data.slice(0, 10).toLowerCase();
        if (sel === '0x1698ee82') {
          // getPool
          return `0x${encodeAddress(POOL)}`;
        }
        if (sel === '0x1a686502') {
          // liquidity
          return `0x${(10n ** 18n).toString(16).padStart(64, '0')}`;
        }
        if (sel === '0xb3c64859') {
          // quoteExactInputSingle → 25 USDG
          return `0x${(25n * 10n ** 6n).toString(16).padStart(64, '0')}`;
        }
        throw new Error(`unexpected call ${sel}`);
      },
    };

    const client = new V3PoolHopClient({
      eth,
      factory: FACTORY,
      quoter: QUOTER,
      wethMint: WETH,
      baseMints: createBaseMintRegistry({ RH: { WETH, USDG, ETH: NATIVE_ETH_MINT } }),
      feeTierOverrides: { USDG: 3000 },
    });

    const q = await client.quote({
      inMint: NATIVE_ETH_MINT,
      outMint: USDG,
      inAmountAtoms: 10n ** 16n,
      slippagePct: 0,
    });

    expect(q.outAmountAtoms).toBe(25_000_000n);
    expect(isV3PoolHopRaw(q.raw)).toBe(true);
    if (isV3PoolHopRaw(q.raw)) {
      expect(q.raw.fee).toBe(3000);
      expect(q.raw.pool.toLowerCase()).toBe(POOL.toLowerCase());
    }
    expect(calls.some((c) => c.to.toLowerCase() === QUOTER.toLowerCase())).toBe(true);
  });

  it('throws NoRouteError when no liquid pool exists across candidate fees', async () => {
    const eth: EthCaller = {
      async ethCall(_to, data) {
        const sel = data.slice(0, 10).toLowerCase();
        if (sel === '0x1698ee82') {
          // getPool → zero address
          return `0x${'00'.repeat(32)}`;
        }
        throw new Error(`unexpected ${sel}`);
      },
    };
    const client = new V3PoolHopClient({
      eth,
      factory: FACTORY,
      quoter: QUOTER,
      wethMint: WETH,
      baseMints: createBaseMintRegistry({ RH: { WETH, USDG, ETH: NATIVE_ETH_MINT } }),
      feeTierOverrides: {},
    });
    await expect(
      client.quote({
        inMint: NATIVE_ETH_MINT,
        outMint: USDG,
        inAmountAtoms: 1n,
        slippagePct: 0,
      }),
    ).rejects.toBeInstanceOf(NoRouteError);
  });
});
