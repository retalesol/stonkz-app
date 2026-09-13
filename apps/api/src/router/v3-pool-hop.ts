/**
 * On-chain Uniswap V3 exact-input quotes for RH when the Trading API cannot
 * (testnet 46630 is absent from its chain enum). Requires a seeded pool and a
 * deployed `V3ExactInputQuoter` (`programs/evm/src/testnet/V3ExactInputQuoter.sol`).
 *
 * Stamped `raw.source === 'v3-pool'` so `/trade/prepare` treats the hop as
 * executable (unlike oracle-priced hops).
 */
import { encodeFunctionData, type Address } from 'viem';
import type { AggregatorClient, AggregatorQuote, AggregatorQuoteRequest } from './aggregator.js';
import type { BaseMintRegistry } from './base-mints.js';
import { NATIVE_ETH_MINT } from './compose.js';
import { NoRouteError } from './errors.js';
import { pinnedV3FeeTierFor } from './evm-router.js';

export const V3_POOL_HOP_SOURCE = 'v3-pool' as const;

export interface V3PoolHopRaw {
  source: typeof V3_POOL_HOP_SOURCE;
  pool: string;
  fee: number;
  quoter: string;
}

export function isV3PoolHopRaw(raw: unknown): raw is V3PoolHopRaw {
  return !!raw && typeof raw === 'object' && (raw as V3PoolHopRaw).source === V3_POOL_HOP_SOURCE;
}

const ZERO = '0x0000000000000000000000000000000000000000';

const FACTORY_ABI = [
  {
    type: 'function',
    name: 'getPool',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
      { name: 'fee', type: 'uint24' },
    ],
    outputs: [{ name: 'pool', type: 'address' }],
  },
] as const;

const POOL_ABI = [
  {
    type: 'function',
    name: 'liquidity',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint128' }],
  },
] as const;

const QUOTER_ABI = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOut', type: 'address' },
      { name: 'fee', type: 'uint24' },
      { name: 'amountIn', type: 'uint256' },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const;

export interface EthCaller {
  ethCall(to: string, data: string): Promise<string>;
}

export interface V3PoolHopClientOptions {
  eth: EthCaller;
  factory: string;
  quoter: string;
  wethMint: string;
  baseMints: BaseMintRegistry;
  feeTierOverrides: Record<string, number>;
}

export class V3PoolHopClient implements AggregatorClient {
  readonly venue = 'UNISWAP' as const;
  private readonly eth: EthCaller;
  private readonly factory: Address;
  private readonly quoter: Address;
  private readonly wethMint: string;
  private readonly baseMints: BaseMintRegistry;
  private readonly feeTiers: Record<string, number>;

  constructor(opts: V3PoolHopClientOptions) {
    this.eth = opts.eth;
    this.factory = opts.factory as Address;
    this.quoter = opts.quoter as Address;
    this.wethMint = opts.wethMint.toLowerCase();
    this.baseMints = opts.baseMints;
    this.feeTiers = opts.feeTierOverrides;
  }

  async quote(req: AggregatorQuoteRequest): Promise<AggregatorQuote> {
    if (!this.quoter || this.quoter.toLowerCase() === ZERO) {
      throw new NoRouteError(req.inMint, req.outMint, new Error('RH_V3_QUOTER_ADDRESS unset'));
    }
    if (!this.factory || this.factory.toLowerCase() === ZERO) {
      throw new NoRouteError(req.inMint, req.outMint, new Error('RH_V3_FACTORY_ADDRESS unset'));
    }

    const tokenIn = this.resolveErc20(req.inMint);
    const tokenOut = this.resolveErc20(req.outMint);
    if (!tokenIn || !tokenOut) throw new NoRouteError(req.inMint, req.outMint);

    const baseSide = this.baseSide(tokenIn, tokenOut);
    if (!baseSide) throw new NoRouteError(req.inMint, req.outMint);

    // Prefer the operator pin, then probe the standard Uniswap V3 tiers and
    // keep the cheapest (max amountOut) live pool. Fee 100 is omitted: RH
    // testnet factory enables tick spacing 0 for it and createPool reverts.
    const pinned = pinnedV3FeeTierFor(baseSide.mint, baseSide.symbol, this.feeTiers);
    const candidates = [...new Set([...(pinned !== null ? [pinned] : []), 500, 3000, 10_000])];

    let best: { fee: number; pool: string; amountOut: bigint } | null = null;
    for (const fee of candidates) {
      try {
        const pool = await this.getPool(tokenIn, tokenOut, fee);
        if (!pool || pool.toLowerCase() === ZERO) continue;
        const liq = await this.poolLiquidity(pool);
        if (liq === 0n) continue;
        const amountOut = await this.quoteExact(tokenIn, tokenOut, fee, req.inAmountAtoms);
        if (amountOut <= 0n) continue;
        if (!best || amountOut > best.amountOut) best = { fee, pool, amountOut };
      } catch {
        // Try the next fee tier.
      }
    }

    if (!best) {
      throw new NoRouteError(
        req.inMint,
        req.outMint,
        new Error(pinned === null ? `no liquid v3 pool for ${baseSide.symbol}` : `no v3 pool fee=${pinned}`),
      );
    }

    const raw: V3PoolHopRaw = {
      source: V3_POOL_HOP_SOURCE,
      pool: best.pool,
      fee: best.fee,
      quoter: this.quoter,
    };

    return {
      venue: 'UNISWAP',
      inMint: req.inMint,
      outMint: req.outMint,
      inAmountAtoms: req.inAmountAtoms,
      outAmountAtoms: best.amountOut,
      priceImpactPct: 0,
      raw,
    };
  }

  private resolveErc20(mint: string): Address | null {
    const lower = mint.toLowerCase();
    if (lower === NATIVE_ETH_MINT.toLowerCase()) return this.wethMint as Address;
    if (!lower.startsWith('0x') || lower.length !== 42) return null;
    return mint as Address;
  }

  private baseSide(
    tokenIn: Address,
    tokenOut: Address,
  ): { mint: string; symbol: string } | null {
    const inIsWeth = tokenIn.toLowerCase() === this.wethMint;
    const outIsWeth = tokenOut.toLowerCase() === this.wethMint;
    if (inIsWeth === outIsWeth) return null;
    const base = inIsWeth ? tokenOut : tokenIn;
    const symbol = this.baseMints.symbolFor('RH', base);
    if (!symbol) return null;
    return { mint: base, symbol };
  }

  private async getPool(a: Address, b: Address, fee: number): Promise<string> {
    const data = encodeFunctionData({
      abi: FACTORY_ABI,
      functionName: 'getPool',
      args: [a, b, fee],
    });
    const raw = await this.eth.ethCall(this.factory, data);
    return `0x${raw.slice(-40)}`;
  }

  private async poolLiquidity(pool: string): Promise<bigint> {
    const data = encodeFunctionData({ abi: POOL_ABI, functionName: 'liquidity' });
    const raw = await this.eth.ethCall(pool, data);
    return BigInt(raw);
  }

  private async quoteExact(tokenIn: Address, tokenOut: Address, fee: number, amountIn: bigint): Promise<bigint> {
    const data = encodeFunctionData({
      abi: QUOTER_ABI,
      functionName: 'quoteExactInputSingle',
      args: [tokenIn, tokenOut, fee, amountIn],
    });
    try {
      const raw = await this.eth.ethCall(this.quoter, data);
      return BigInt(raw);
    } catch (err) {
      throw new NoRouteError(tokenIn, tokenOut, err instanceof Error ? err : new Error(String(err)));
    }
  }
}
