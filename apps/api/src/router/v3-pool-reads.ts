/**
 * Read-only Uniswap V3 pool reads over `eth_call`, for pricing and quoting
 * stock-token bases against WETH (`router/stock-price.ts`, the
 * `createAndBuyViaV3` plan in `router/evm-pyth.ts`).
 *
 * The same inputs `StockPriceSource` uses on-chain: the WETH/stock pool's
 * 30-minute TWAP (`observe([1800, 0])`) for price, and — for the dev buy's
 * swap floor — the deployed exact-input quoter (`RH_V3_QUOTER_ADDRESS`, the
 * signature `v3-pool-hop.ts` already calls) or, without one, `slot0`.
 */
import { decodeFunctionResult, encodeFunctionData, getAddress, type Address, type Hex } from 'viem';
import { ZERO_EVM_ADDRESS } from '../env.js';

export interface V3EthCaller {
  ethCall(to: string, data: string): Promise<string>;
}

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

export const V3_POOL_ABI = [
  {
    type: 'function',
    name: 'liquidity',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint128' }],
  },
  {
    type: 'function',
    name: 'slot0',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'observationIndex', type: 'uint16' },
      { name: 'observationCardinality', type: 'uint16' },
      { name: 'observationCardinalityNext', type: 'uint16' },
      { name: 'feeProtocol', type: 'uint8' },
      { name: 'unlocked', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'observe',
    stateMutability: 'view',
    inputs: [{ name: 'secondsAgos', type: 'uint32[]' }],
    outputs: [
      { name: 'tickCumulatives', type: 'int56[]' },
      { name: 'secondsPerLiquidityCumulativeX128s', type: 'uint160[]' },
    ],
  },
] as const;

/**
 * The flat `quoteExactInputSingle(tokenIn, tokenOut, fee, amountIn)` of our
 * testnet `V3ExactInputQuoter` (`programs/evm/src/testnet`): RH testnet 46630
 * has no canonical QuoterV2, so that is what is deployed there.
 */
export const V3_QUOTER_ABI = [
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

/**
 * Uniswap's canonical QuoterV2 — what mainnet uses (RH 4663
 * `0x33e8…A9E7`, Base 8453 `0x3d4e…B76a`, pinned in `src/config/*.sol`),
 * and Base Sepolia's `0xC529…5E27`. Same exact-input simulation, struct
 * argument, four outputs; only `amountOut` is read.
 */
export const V3_QUOTER_V2_ABI = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'fee', type: 'uint24' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96After', type: 'uint160' },
      { name: 'initializedTicksCrossed', type: 'uint32' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
] as const;

export type V3QuoterKind = 'v2' | 'flat';

/**
 * Which ABI each quoter address answered last. QuoterV2 is tried first (it is
 * the mainnet contract); a quoter that rejects the struct selector is the
 * flat testnet one. Remembered per address so RH testnet pays the extra
 * `eth_call` once, not per quote.
 */
const quoterKinds = new Map<string, V3QuoterKind>();

/** Tests only. */
export function resetV3QuoterKinds(): void {
  quoterKinds.clear();
}

export function v3QuoterKind(quoter: string): V3QuoterKind | undefined {
  return quoterKinds.get(quoter.toLowerCase());
}

function decodeAmountOut(kind: V3QuoterKind, raw: string): bigint {
  if (!raw || raw.length < 66) throw new Error('quoter returned no data');
  if (kind === 'v2') {
    const [amountOut] = decodeFunctionResult({
      abi: V3_QUOTER_V2_ABI,
      functionName: 'quoteExactInputSingle',
      data: raw as Hex,
    });
    return amountOut;
  }
  return decodeFunctionResult({
    abi: V3_QUOTER_ABI,
    functionName: 'quoteExactInputSingle',
    data: raw as Hex,
  });
}

function encodeQuote(
  kind: V3QuoterKind,
  tokenIn: Address,
  tokenOut: Address,
  fee: number,
  amountIn: bigint,
): Hex {
  return kind === 'v2'
    ? encodeFunctionData({
        abi: V3_QUOTER_V2_ABI,
        functionName: 'quoteExactInputSingle',
        args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
      })
    : encodeFunctionData({
        abi: V3_QUOTER_ABI,
        functionName: 'quoteExactInputSingle',
        args: [tokenIn, tokenOut, fee, amountIn],
      });
}

/** `StockPriceSource`'s TWAP window. */
export const STOCK_TWAP_SECONDS = 1800;

/** The fee tier every RH stock/WETH pool is seeded at (`0.3 %`). */
export const DEFAULT_STOCK_POOL_FEE = 3000;

function isZero(addr: string | null | undefined): boolean {
  return !addr || addr.toLowerCase() === ZERO_EVM_ADDRESS;
}

/** `factory.getPool(a, b, fee)`; `null` for no pool (or no factory). */
export async function v3GetPool(
  eth: V3EthCaller,
  factory: string,
  a: string,
  b: string,
  fee: number,
): Promise<Address | null> {
  if (isZero(factory)) return null;
  const raw = await eth.ethCall(
    factory,
    encodeFunctionData({
      abi: FACTORY_ABI,
      functionName: 'getPool',
      args: [a as Address, b as Address, fee],
    }),
  );
  if (!raw || raw.length < 66) return null;
  const pool = getAddress(`0x${raw.slice(-40)}`);
  return isZero(pool) ? null : pool;
}

export async function v3Liquidity(eth: V3EthCaller, pool: string): Promise<bigint> {
  const raw = await eth.ethCall(
    pool,
    encodeFunctionData({ abi: V3_POOL_ABI, functionName: 'liquidity' }),
  );
  if (!raw || raw.length < 66) return 0n;
  return decodeFunctionResult({ abi: V3_POOL_ABI, functionName: 'liquidity', data: raw as Hex });
}

export async function v3SqrtPriceX96(eth: V3EthCaller, pool: string): Promise<bigint | null> {
  const raw = await eth.ethCall(
    pool,
    encodeFunctionData({ abi: V3_POOL_ABI, functionName: 'slot0' }),
  );
  if (!raw || raw.length < 66) return null;
  const [sqrtPriceX96] = decodeFunctionResult({
    abi: V3_POOL_ABI,
    functionName: 'slot0',
    data: raw as Hex,
  });
  return sqrtPriceX96 > 0n ? sqrtPriceX96 : null;
}

/**
 * The arithmetic-mean tick over the last `seconds`, rounded toward negative
 * infinity exactly as Uniswap's `OracleLibrary.consult`. Throws when the pool
 * cannot answer (`OLD`: not enough observation history).
 */
export async function v3TwapTick(
  eth: V3EthCaller,
  pool: string,
  seconds = STOCK_TWAP_SECONDS,
): Promise<number> {
  const raw = await eth.ethCall(
    pool,
    encodeFunctionData({ abi: V3_POOL_ABI, functionName: 'observe', args: [[seconds, 0]] }),
  );
  if (!raw || raw.length < 66) throw new Error('observe returned no data');
  const [cumulatives] = decodeFunctionResult({
    abi: V3_POOL_ABI,
    functionName: 'observe',
    data: raw as Hex,
  });
  if (cumulatives.length < 2) throw new Error('observe returned too few cumulatives');
  return twapTickFromCumulatives(cumulatives[0]!, cumulatives[1]!, seconds);
}

export function twapTickFromCumulatives(older: bigint, newer: bigint, seconds: number): number {
  const delta = newer - older;
  const span = BigInt(seconds);
  let tick = delta / span;
  if (delta < 0n && delta % span !== 0n) tick -= 1n;
  return Number(tick);
}

/**
 * Whole `quote` per whole `base` implied by `tick` (token1-per-token0 is
 * `1.0001^tick` in atoms). Float math: this sizes a curve and a preview, and
 * every on-chain floor derived from it carries its own tolerance.
 */
export function tickToPrice(
  tick: number,
  base: string,
  quote: string,
  baseDecimals: number,
  quoteDecimals: number,
): number {
  const baseIsToken0 = base.toLowerCase() < quote.toLowerCase();
  const token1PerToken0 = Math.pow(1.0001, tick);
  const rawQuotePerBase = baseIsToken0 ? token1PerToken0 : 1 / token1PerToken0;
  return rawQuotePerBase * 10 ** (baseDecimals - quoteDecimals);
}

/**
 * `amountIn` of `tokenIn` → `tokenOut` at the pool's spot price, less the LP
 * fee, with no price impact. A ceiling on what a swap can deliver.
 */
export function spotAmountOut(
  sqrtPriceX96: bigint,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  fee: number,
): bigint {
  const q192 = 1n << 192n;
  const p = sqrtPriceX96 * sqrtPriceX96;
  const zeroForOne = tokenIn.toLowerCase() < tokenOut.toLowerCase();
  const gross = zeroForOne ? (amountIn * p) / q192 : (amountIn * q192) / p;
  return (gross * BigInt(1_000_000 - fee)) / 1_000_000n;
}

/**
 * Exact-input quote from either quoter ABI (see `V3_QUOTER_V2_ABI`). Throws
 * when neither answers — the callers then fall back to the `slot0` ceiling
 * or report no route, exactly as before.
 */
export async function v3QuoteExactInputSingle(
  eth: V3EthCaller,
  quoter: string,
  tokenIn: string,
  tokenOut: string,
  fee: number,
  amountIn: bigint,
): Promise<bigint> {
  const key = quoter.toLowerCase();
  const known = quoterKinds.get(key);
  const order: V3QuoterKind[] = known ? [known] : ['v2', 'flat'];
  let lastErr: unknown;
  for (const kind of order) {
    try {
      const raw = await eth.ethCall(
        quoter,
        encodeQuote(kind, tokenIn as Address, tokenOut as Address, fee, amountIn),
      );
      const out = decodeAmountOut(kind, raw);
      quoterKinds.set(key, kind);
      return out;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export type EthToTokenQuote =
  | {
      ok: true;
      pool: Address;
      /** What the swap should deliver (quoter), or the spot ceiling without one. */
      amountOut: bigint;
      /** Spot-price ceiling (no impact), when `slot0` answered. */
      spotOut: bigint | null;
      source: 'quoter' | 'slot0';
      /** Price impact vs spot, bps; `null` when either side is unknown. */
      impactBps: bigint | null;
    }
  | { ok: false; reason: 'no_pool' | 'no_liquidity' | 'no_quote' };

/**
 * WETH → `token` on the `fee` pool for `amountIn` wei. Pool missing or empty,
 * or neither the quoter nor `slot0` able to price it, is `{ ok: false }` — a
 * pool too thin to take the swap. A transport failure is thrown.
 */
export async function quoteWethToToken(args: {
  eth: V3EthCaller;
  factory: string;
  quoter: string | null;
  weth: string;
  token: string;
  fee: number;
  amountIn: bigint;
  /** Is this error a node-reported revert (i.e. an answer, not an outage)? */
  isRevert: (err: unknown) => boolean;
}): Promise<EthToTokenQuote> {
  const { eth, weth, token, fee, amountIn, isRevert } = args;
  const pool = await v3GetPool(eth, args.factory, weth, token, fee);
  if (!pool) return { ok: false, reason: 'no_pool' };
  const liquidity = await v3Liquidity(eth, pool);
  if (liquidity === 0n) return { ok: false, reason: 'no_liquidity' };

  let sqrtP: bigint | null = null;
  try {
    sqrtP = await v3SqrtPriceX96(eth, pool);
  } catch (err) {
    if (!isRevert(err)) throw err;
  }
  const spotOut = sqrtP ? spotAmountOut(sqrtP, weth, token, amountIn, fee) : null;

  if (!isZero(args.quoter)) {
    try {
      const quoted = await v3QuoteExactInputSingle(eth, args.quoter!, weth, token, fee, amountIn);
      if (quoted <= 0n) return { ok: false, reason: 'no_quote' };
      const impactBps =
        spotOut && spotOut > 0n
          ? quoted >= spotOut
            ? 0n
            : ((spotOut - quoted) * 10_000n) / spotOut
          : null;
      return { ok: true, pool, amountOut: quoted, spotOut, source: 'quoter', impactBps };
    } catch (err) {
      if (!isRevert(err)) throw err;
      // A reverting quoter on a live pool: price off slot0 below.
    }
  }
  if (spotOut === null || spotOut <= 0n) return { ok: false, reason: 'no_quote' };
  return { ok: true, pool, amountOut: spotOut, spotOut, source: 'slot0', impactBps: null };
}
