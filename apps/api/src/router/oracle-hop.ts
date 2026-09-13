import type { PriceOracle } from '../chain/types.js';
import type { AggregatorClient, AggregatorQuote, AggregatorQuoteRequest } from './aggregator.js';
import type { BaseMintRegistry } from './base-mints.js';
import { NATIVE_ETH_MINT } from './compose.js';
import { NoRouteError } from './errors.js';

/**
 * Raw payload stamped on oracle-priced hops so `/trade/prepare` can tell a
 * Trading-API quote (executable via Uniswap calldata / pinned v3 path) from an
 * indicative ETH↔base conversion. Oracle hops price the round-trip correctly
 * when the Trading API is unreachable (RH testnet 46630 is not in its chain
 * enum) or no pool has been indexed yet — they are not a substitute for an
 * on-chain pool when building `buyViaAggregator` legs.
 */
export const ORACLE_HOP_SOURCE = 'oracle' as const;

export interface OracleHopRaw {
  source: typeof ORACLE_HOP_SOURCE;
  inSymbol: string;
  outSymbol: string;
  inUsd1e6: string;
  outUsd1e6: string;
}

export function isOracleHopRaw(raw: unknown): raw is OracleHopRaw {
  return !!raw && typeof raw === 'object' && (raw as OracleHopRaw).source === ORACLE_HOP_SOURCE;
}

/** USD stables treated as $1.00 for the hop — same set `base-price.ts` uses. */
const USD_STABLES = new Set(['USDC', 'USDT', 'USDG']);

/** Whole-USD fallbacks for RH bases when the live oracle only knows native ETH. */
const RH_BASE_USD: Record<string, number> = {
  BTC: 95_000,
  SOL: 180,
  XRP: 0.6,
  DOGE: 0.15,
  ADA: 0.7,
  AVAX: 35,
  LINK: 15,
  LTC: 90,
  TSLA: 250,
  AMZN: 200,
  PLTR: 40,
  NFLX: 700,
  AMD: 160,
  AAPL: 220,
  NVDA: 120,
  MSFT: 420,
  GOOGL: 180,
  META: 550,
  COIN: 220,
  HOOD: 40,
  SPY: 560,
  QQQ: 480,
  MSTR: 350,
  CRCL: 100,
  GLD: 240,
  INTC: 25,
  KO: 65,
  GME: 25,
};

export interface OracleHopClientOptions {
  oracle: PriceOracle;
  baseMints: BaseMintRegistry;
  /** Chain-local WETH — treated as 1:1 with native ETH for this hop. */
  wethMint: string;
}

/**
 * Prices the native↔base aggregator hop from USD marks when Uniswap cannot.
 *
 * Buy:  ETH → base   (primary asset into the curve's quote asset)
 * Sell: base → ETH   (curve proceeds back to the primary asset)
 */
export class OracleHopClient implements AggregatorClient {
  readonly venue = 'UNISWAP' as const;
  private readonly oracle: PriceOracle;
  private readonly baseMints: BaseMintRegistry;
  private readonly wethMint: string;

  constructor(opts: OracleHopClientOptions) {
    this.oracle = opts.oracle;
    this.baseMints = opts.baseMints;
    this.wethMint = opts.wethMint.toLowerCase();
  }

  async quote(req: AggregatorQuoteRequest): Promise<AggregatorQuote> {
    const inSide = this.resolveSide(req.inMint);
    const outSide = this.resolveSide(req.outMint);
    if (!inSide || !outSide) throw new NoRouteError(req.inMint, req.outMint);

    // Exactly one side must be native/WETH — this client only bridges primary ↔ base.
    if (inSide.kind === outSide.kind) throw new NoRouteError(inSide.symbol, outSide.symbol);
    if (inSide.kind !== 'native' && outSide.kind !== 'native') {
      throw new NoRouteError(inSide.symbol, outSide.symbol);
    }

    const inUsd = await this.usd1e6(inSide);
    const outUsd = await this.usd1e6(outSide);
    if (inUsd <= 0n || outUsd <= 0n) throw new NoRouteError(inSide.symbol, outSide.symbol);

    const outAmountAtoms = convertByUsd(req.inAmountAtoms, inSide.decimals, inUsd, outSide.decimals, outUsd);
    if (outAmountAtoms <= 0n) throw new NoRouteError(inSide.symbol, outSide.symbol);

    const raw: OracleHopRaw = {
      source: ORACLE_HOP_SOURCE,
      inSymbol: inSide.symbol,
      outSymbol: outSide.symbol,
      inUsd1e6: inUsd.toString(),
      outUsd1e6: outUsd.toString(),
    };

    return {
      venue: 'UNISWAP',
      inMint: req.inMint,
      outMint: req.outMint,
      inAmountAtoms: req.inAmountAtoms,
      outAmountAtoms,
      priceImpactPct: 0,
      raw,
    };
  }

  private resolveSide(mint: string): { kind: 'native' | 'base'; symbol: string; decimals: number } | null {
    const lower = mint.toLowerCase();
    if (lower === NATIVE_ETH_MINT.toLowerCase() || lower === this.wethMint) {
      return { kind: 'native', symbol: 'ETH', decimals: 18 };
    }
    const symbol = this.baseMints.symbolFor('RH', mint);
    if (!symbol) return null;
    const decimals = USD_STABLES.has(symbol) ? 6 : 18;
    return { kind: 'base', symbol, decimals };
  }

  private async usd1e6(side: { kind: 'native' | 'base'; symbol: string }): Promise<bigint> {
    if (side.kind === 'native' || side.symbol === 'WETH' || side.symbol === 'ETH') {
      const usd = await this.oracle.nativeUsd('ETH');
      if (!Number.isFinite(usd) || usd <= 0) return 0n;
      return BigInt(Math.round(usd * 1e6));
    }
    if (USD_STABLES.has(side.symbol)) return 1_000_000n;
    const table = RH_BASE_USD[side.symbol];
    if (table === undefined) return 0n;
    return BigInt(Math.round(table * 1e6));
  }
}

/**
 * `outAtoms = inAtoms * inUsd / outUsd`, shifting by each side's decimals in
 * bigint so ETH's 18dp never round-trips through float.
 */
export function convertByUsd(
  inAtoms: bigint,
  inDecimals: number,
  inUsd1e6: bigint,
  outDecimals: number,
  outUsd1e6: bigint,
): bigint {
  if (inAtoms <= 0n || inUsd1e6 <= 0n || outUsd1e6 <= 0n) return 0n;
  return (inAtoms * inUsd1e6 * 10n ** BigInt(outDecimals)) / (outUsd1e6 * 10n ** BigInt(inDecimals));
}
