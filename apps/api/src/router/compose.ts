import { buyQuote, effFeeBps, sellQuote, type BuyFill, type SellFill } from '@stonkz/curve-sim';
import {
  effFee,
  nativeUnit,
  type NativeUnit,
  type Net,
  type Quote,
  type QuoteHop,
  type Venue,
} from '@stonkz/shared';
import type { TokenRow } from '../routes/serialise.js';
import type { AggregatorClient, AggregatorQuote } from './aggregator.js';
import { hasCurveState, liveCurveState } from './curve-state.js';
import { NoRouteError } from './errors.js';
import { applySlippageFloor, fromAtoms, toAtoms } from './units.js';

/** SPL mint Jupiter uses for native SOL; wrapping/unwrapping is its own job (`wrapAndUnwrapSol`). */
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
/** Sentinel this router's Uniswap client uses for native ETH — see `uniswap.ts`'s header caveat. */
export const NATIVE_ETH_MINT = '0x0000000000000000000000000000000000000000';

export function nativeAggregatorMint(net: Net): string {
  return net === 'SOL' ? WSOL_MINT : NATIVE_ETH_MINT;
}

/** Lamports (SOL) or wei (ETH) — the decimal count of the native unit itself. */
export function nativeDecimalsFor(net: Net): number {
  return net === 'SOL' ? 9 : 18;
}

/** Hop 1's venue, or `null` when the base mint already *is* the native token (plan step 86's fast path). */
export function aggregatorFor(net: Net, baseSymbol: string): Venue | null {
  const native = nativeUnit(net);
  const wrapped = net === 'SOL' ? 'WSOL' : 'WETH';
  const base = baseSymbol.toUpperCase();
  if (base === native || base === wrapped) return null;
  return net === 'SOL' ? 'JUPITER' : 'UNISWAP';
}

export interface ComposeQuoteInput {
  net: Net;
  side: 'buy' | 'sell';
  /**
   * Buy: the native amount the trader pays (plan step 82). Sell: the
   * launched-token amount the trader is selling.
   *
   * The plan's "amount is always native SOL or ETH" describes the round
   * trip's entry/exit point, not literally the request parameter on both
   * sides — a sell quote that instead took a *desired native output* would
   * need to invert `sellQuote`'s floor-division fee math exactly, which
   * `@stonkz/curve-sim` does not expose and which is easy to get subtly
   * wrong (an inverse a few atoms off either strands base in the curve or
   * quotes an amount the chain will not fill). Every reference bonding-curve
   * UI (and this repo's own `index.html`) takes a token quantity on the sell
   * side for the same reason. This is a deliberate, documented interpretation
   * of an ambiguous plan line — flagged in the phase report, not a bug.
   */
  amount: number;
  /**
   * Optional atom-precise override for the sell (or buy) input. When set,
   * `compose` uses this instead of `toAtoms(amount, …)` — needed so a max
   * sell that survived a float round-trip on the client cannot exceed the
   * wallet's on-chain ERC-20 balance (which reverts with `"balance"`).
   */
  amountAtoms?: bigint;
  row: TokenRow;
  usdPrice: number | null;
  now: number;
  /** Required when `aggregatorFor(net, row.baseSymbol)` is non-null; ignored otherwise. */
  aggregator: AggregatorClient | null;
  /**
   * Percent, e.g. `1` = 1%. `0` (the default) is what `/quote` shows — a
   * quote's own `minOut` is "no slippage tolerance applied yet"; `/trade/prepare`
   * passes the caller's `Settings.slip` to get the value that actually goes
   * on-chain.
   */
  slippagePct?: number;
}

export interface ComposedQuote extends Quote {
  /** `false` once real curve state (post `/launch/confirm`) drives the curve hop; `true` for the legacy mc/supply approximation. */
  indicative: boolean;
  nativeUsd: number | null;
}

/**
 * `expiresAt` on the value this module returns is always just `input.now` —
 * "quoted at", not "expires at". `routes/quote.ts` runs this inside
 * `QuoteCache.wrap`, which stamps the real 8-second expiry and is what the
 * wire response actually reports; `routes/trade.ts` calls this directly
 * (no cache — a prepare must reflect the composed transaction's own
 * numbers) and sets its own short validity window on the response instead.
 */

function effFeePctForRow(row: TokenRow, now: number): number {
  return effFee(
    { tfee: row.feeBps / 100, cashback: row.cashback, cbStart: row.cbStartMs ?? undefined },
    now,
  );
}

function effFeeBpsForRow(row: TokenRow, now: number): number {
  const cbStartSecs = BigInt(Math.floor((row.cbStartMs ?? 0) / 1000));
  const nowSecs = BigInt(Math.floor(now / 1000));
  return effFeeBps(row.feeBps, row.cashback, cbStartSecs, nowSecs);
}

/**
 * `GET /tokens/:sym/quote` / `POST /trade/prepare`'s composition, shared by
 * both because a prepare that quoted differently from the quote the user just
 * looked at would be its own bug class.
 *
 * Picks one of three paths:
 * - Graduated: aggregator only, `DEX` venue, zero Stonkz fee (plan step 88).
 * - Real curve state present (`hasCurveState`): `@stonkz/curve-sim`'s
 *   `buyQuote`/`sellQuote` against the live reserves — the actual settlement
 *   math, not an approximation.
 * - No curve state (every row seeded by the Phase 1.C fixture read-path track,
 *   and any row from before this migration): the pre-existing mc/supply
 *   indicative approximation, preserved byte-for-byte so that track's tests
 *   and behaviour do not regress under a sibling agent's concurrent work.
 */
export async function composeQuote(input: ComposeQuoteInput): Promise<ComposedQuote> {
  const { net, row } = input;
  const native = nativeUnit(net);
  const graduated = row.graduatedAt !== null;
  const aggregatorVenue = aggregatorFor(net, row.baseSymbol);

  if (graduated) return composeGraduatedQuote(input, native, aggregatorVenue);
  if (!hasCurveState(row)) return composeIndicativeQuote(input, native, aggregatorVenue);
  return (await composeCurveQuote(input, native, aggregatorVenue)).quote;
}

async function requireAggregator(
  input: ComposeQuoteInput,
  venue: Venue,
): Promise<AggregatorClient> {
  if (!input.aggregator) {
    throw new Error(
      `composeQuote: aggregatorFor selected ${venue} but no aggregator client was provided`,
    );
  }
  return input.aggregator;
}

/* -------------------------------------------------------------------- real curve path */

/**
 * The atom-precision counterpart of `composeCurveQuote`, for
 * `routes/trade.ts` — building `buy(amount_base, min_out)` /
 * `sell(amount_token, min_out)` (or its RH calldata equivalent) needs the
 * curve instruction's exact `bigint` inputs and the raw aggregator quote
 * (Jupiter's `swap-instructions` / Uniswap's `swap` need the *quote object
 * itself*, not just its rounded-to-float output), neither of which
 * `ComposedQuote` — a wire-serialisable, human-unit type — can carry.
 * `composeCurveQuote` below is this plus the human-readable projection;
 * every number in `quote` is derived from the exact same atoms, so a
 * `/trade/prepare` can never compute a different fill than the `/quote` the
 * trader just looked at.
 */
export interface CurveTradeComposition {
  quote: ComposedQuote;
  /** `amount_base` (buy) / `amount_token` (sell) — the curve instruction's own input. */
  curveAmountInAtoms: bigint;
  /**
   * Buy only (`null` on sell): the native SOL/ETH atoms the trader pays into
   * hop 1. Distinct from `curveAmountInAtoms`, which after an aggregator hop
   * is denominated in *base* (e.g. USDG). `StonkzRouter.buyViaAggregator`
   * takes this as `msg.value` — passing base atoms there underpays by orders
   * of magnitude on stable-paired coins.
   */
  nativeInAtoms: bigint | null;
  /** The curve instruction's own `min_out`, after `input.slippagePct`. */
  curveMinOutAtoms: bigint;
  /** `null` on the direct-pair fast path; otherwise hop 1's full aggregator response. */
  aggregatorQuote: AggregatorQuote | null;
  /**
   * Sell only (`null` on buy): `fill.netBase`, the curve's own expected
   * proceeds *before* any aggregator conversion. `router/evm-router.ts`'s
   * `StonkzRouter.sellViaAggregator` needs this exact number as
   * `AggregatorLeg.amountIn` — the aggregator leg was quoted off-chain
   * against this input, whether or not there is a further aggregator hop
   * (the direct-pair fast path still needs it, as the amount `UNWRAP_WETH`
   * is expected to deliver).
   */
  curveNetBaseOutAtoms: bigint | null;
  /**
   * Sell only (`null` on buy): the curve-only floor in *base* terms —
   * `applySlippageFloor(fill.netBase, slippagePct)` — independent of
   * `curveMinOutAtoms`, which (for a sell) is the *end-to-end* floor in
   * final-native terms and is what the Solana path's single curve
   * instruction already uses. `StonkzRouter.sellViaAggregator` takes these
   * as two separate parameters (`minBaseOut` vs `minEthOut`) precisely so a
   * bad fill on one leg cannot hide inside the other's tolerance — see that
   * contract's `buyViaAggregator` doc comment. Splitting `curveMinOutAtoms`
   * itself to mean this everywhere would change the number the
   * already-shipped, already-tested Solana sell instruction receives; scoped
   * to a new field instead of touching that path.
   */
  curveMinBaseOutAtoms: bigint | null;
}

export async function composeCurveTrade(input: ComposeQuoteInput): Promise<CurveTradeComposition> {
  const { net, row } = input;
  const native = nativeUnit(net);
  if (row.graduatedAt !== null) {
    throw new NoRouteError(
      row.sym,
      nativeUnit(net),
      new Error('token has graduated off the curve'),
    );
  }
  if (!hasCurveState(row)) {
    throw new NoRouteError(
      row.sym,
      nativeUnit(net),
      new Error('token has no on-chain curve state yet'),
    );
  }
  const aggregatorVenue = aggregatorFor(net, row.baseSymbol);
  return composeCurveQuote(input, native, aggregatorVenue);
}

async function composeCurveQuote(
  input: ComposeQuoteInput,
  native: NativeUnit,
  aggregatorVenue: Venue | null,
): Promise<CurveTradeComposition> {
  const { net, side, amount, row, usdPrice, now } = input;
  const slippagePct = input.slippagePct ?? 0;
  const state = liveCurveState(row);
  const bps = effFeeBpsForRow(row, now);
  const nativeDecimals = nativeDecimalsFor(net);

  const hops: QuoteHop[] = [];
  let amountOut: number;
  let minOut: number;
  let impactPct: number;
  let curveAmountInAtoms: bigint;
  let curveMinOutAtoms: bigint;
  let aggregatorQuote: AggregatorQuote | null = null;
  let curveNetBaseOutAtoms: bigint | null = null;
  let curveMinBaseOutAtoms: bigint | null = null;
  let nativeInAtoms: bigint | null = null;

  if (side === 'buy') {
    let baseAtoms: bigint;
    let hop1ImpactPct = 0;
    const nativeAtoms = toAtoms(amount, nativeDecimals);
    nativeInAtoms = nativeAtoms;
    if (aggregatorVenue) {
      const client = await requireAggregator(input, aggregatorVenue);
      let agg: AggregatorQuote;
      try {
        agg = await client.quote({
          inMint: nativeAggregatorMint(net),
          outMint: row.baseMint,
          inAmountAtoms: nativeAtoms,
          slippagePct,
        });
      } catch (err) {
        if (err instanceof NoRouteError) throw new NoRouteError(native, row.baseSymbol, err);
        throw err;
      }
      aggregatorQuote = agg;
      baseAtoms = agg.outAmountAtoms;
      hop1ImpactPct = agg.priceImpactPct;
      hops.push({
        venue: aggregatorVenue,
        inSymbol: native,
        outSymbol: row.baseSymbol,
        inAmount: amount,
        outAmount: fromAtoms(baseAtoms, row.baseDecimals),
        impactPct: hop1ImpactPct,
        feeBps: 0,
        feeAmount: 0,
      });
    } else {
      // Direct-pair fast path (plan step 86): base already is the native
      // unit, so its atoms are native atoms by construction.
      baseAtoms = nativeAtoms;
    }

    const fill = buyQuote(state, bps, baseAtoms);
    if (!fill) throw new NoRouteError(row.baseSymbol, row.sym);

    const curveImpactPct = buyImpactPct(state.virtualBase, state.virtualToken, fill);
    hops.push({
      venue: 'CURVE',
      inSymbol: row.baseSymbol,
      outSymbol: row.sym,
      inAmount: fromAtoms(fill.grossBase, row.baseDecimals),
      outAmount: fromAtoms(fill.tokensOut, row.tokenDecimals),
      impactPct: curveImpactPct,
      feeBps: bps,
      feeAmount: fromAtoms(fill.fee, row.baseDecimals),
    });

    amountOut = fromAtoms(fill.tokensOut, row.tokenDecimals);
    curveAmountInAtoms = baseAtoms;
    curveMinOutAtoms = applySlippageFloor(fill.tokensOut, slippagePct);
    minOut = fromAtoms(curveMinOutAtoms, row.tokenDecimals);
    impactPct = hop1ImpactPct + curveImpactPct;
  } else {
    const tokenAtoms = input.amountAtoms ?? toAtoms(amount, row.tokenDecimals);
    const tokenInHuman = fromAtoms(tokenAtoms, row.tokenDecimals);
    const fill = sellQuote(state, bps, tokenAtoms);
    if (!fill) throw new NoRouteError(row.sym, row.baseSymbol);

    const curveImpactPct = sellImpactPct(state.virtualBase, state.virtualToken, tokenAtoms, fill);
    // Direct-pair fast path: base already is native, so its atoms are
    // native atoms without a conversion.
    let nativeAtoms = fill.netBase;
    let hop1ImpactPct = 0;

    if (aggregatorVenue) {
      const client = await requireAggregator(input, aggregatorVenue);
      let agg: AggregatorQuote;
      try {
        agg = await client.quote({
          inMint: row.baseMint,
          outMint: nativeAggregatorMint(net),
          inAmountAtoms: fill.netBase,
          slippagePct,
        });
      } catch (err) {
        if (err instanceof NoRouteError) throw new NoRouteError(row.baseSymbol, native, err);
        throw err;
      }
      aggregatorQuote = agg;
      nativeAtoms = agg.outAmountAtoms;
      hop1ImpactPct = agg.priceImpactPct;
    }

    // Chronological execution order on sells: curve first (token → base),
    // then aggregator (base → native). Buys stay native → base → token.
    hops.push({
      venue: 'CURVE',
      inSymbol: row.sym,
      outSymbol: row.baseSymbol,
      inAmount: tokenInHuman,
      outAmount: fromAtoms(fill.netBase, row.baseDecimals),
      impactPct: curveImpactPct,
      feeBps: bps,
      feeAmount: fromAtoms(fill.fee, row.baseDecimals),
    });
    if (aggregatorVenue) {
      hops.push({
        venue: aggregatorVenue,
        inSymbol: row.baseSymbol,
        outSymbol: native,
        inAmount: fromAtoms(fill.netBase, row.baseDecimals),
        outAmount: fromAtoms(nativeAtoms, nativeDecimals),
        impactPct: hop1ImpactPct,
        feeBps: 0,
        feeAmount: 0,
      });
    }

    amountOut = fromAtoms(nativeAtoms, nativeDecimals);
    curveAmountInAtoms = tokenAtoms;
    curveMinOutAtoms = applySlippageFloor(nativeAtoms, slippagePct);
    curveNetBaseOutAtoms = fill.netBase;
    curveMinBaseOutAtoms = applySlippageFloor(fill.netBase, slippagePct);
    minOut = fromAtoms(curveMinOutAtoms, nativeDecimals);
    impactPct = hop1ImpactPct + curveImpactPct;
  }

  const label = hops.map((h) => h.venue).join(' \u2192 ');
  const quote: ComposedQuote = {
    sym: row.sym,
    net,
    side,
    nativeUnit: native,
    amountIn:
      side === 'sell' && input.amountAtoms !== undefined
        ? fromAtoms(input.amountAtoms, row.tokenDecimals)
        : amount,
    amountOut,
    minOut,
    hops,
    routeLabel: label,
    effFeePct: bps / 100,
    impactPct,
    expiresAt: now,
    indicative: false,
    nativeUsd: usdPrice,
  };
  return {
    quote,
    curveAmountInAtoms,
    curveMinOutAtoms,
    aggregatorQuote,
    curveNetBaseOutAtoms,
    curveMinBaseOutAtoms,
    nativeInAtoms,
  };
}

/**
 * Curve price impact, percent: how much worse the average fill price is than
 * the pre-trade mid price. `Number(bigint)` loses precision on the largest
 * curves (~1e31 atoms at full stake), but a ratio of two such conversions
 * keeps several significant digits — plenty for a display-only percentage
 * that is never used to size `minOut` (the fill's own exact atoms are).
 */
function buyImpactPct(
  virtualBaseBefore: bigint,
  virtualTokenBefore: bigint,
  fill: BuyFill,
): number {
  if (fill.tokensOut <= 0n || fill.grossBase <= 0n) return 0;
  const midTokensPerBase = Number(virtualTokenBefore) / Number(virtualBaseBefore);
  const avgTokensPerBase = Number(fill.tokensOut) / Number(fill.grossBase);
  if (midTokensPerBase <= 0) return 0;
  return Math.max(0, ((midTokensPerBase - avgTokensPerBase) / midTokensPerBase) * 100);
}

function sellImpactPct(
  virtualBaseBefore: bigint,
  virtualTokenBefore: bigint,
  tokenAtomsIn: bigint,
  fill: SellFill,
): number {
  if (tokenAtomsIn <= 0n || fill.grossBase <= 0n) return 0;
  const midBasePerToken = Number(virtualBaseBefore) / Number(virtualTokenBefore);
  const avgBasePerToken = Number(fill.grossBase) / Number(tokenAtomsIn);
  if (midBasePerToken <= 0) return 0;
  return Math.max(0, ((midBasePerToken - avgBasePerToken) / midBasePerToken) * 100);
}

/* -------------------------------------------------------------------- graduated path */

async function composeGraduatedQuote(
  input: ComposeQuoteInput,
  native: NativeUnit,
  aggregatorVenue: Venue | null,
): Promise<ComposedQuote> {
  // Plan step 88: post-graduation, Stonkz charges nothing and the trade
  // routes into the official pool. This phase does not yet persist the
  // graduated pool's address (out of `2.A`'s column set), so — same as the
  // pre-existing behaviour this preserves — the DEX hop is reported at the
  // curve's own indicative price rather than a real aggregator quote into
  // that pool. Flagged as follow-up work in the phase report, not silently
  // assumed correct.
  const { side, amount, row, usdPrice, now } = input;
  const tokenPrice = row.mc / row.supply;
  const hops: QuoteHop[] = [];
  const baseAmount = amount;
  if (aggregatorVenue) {
    hops.push({
      venue: aggregatorVenue,
      inSymbol: side === 'buy' ? native : row.baseSymbol,
      outSymbol: side === 'buy' ? row.baseSymbol : native,
      inAmount: amount,
      outAmount: baseAmount,
      impactPct: 0,
      feeBps: 0,
      feeAmount: 0,
    });
  }
  const tokensOut = tokenPrice > 0 && usdPrice ? (baseAmount * usdPrice) / tokenPrice : 0;
  hops.push({
    venue: 'DEX',
    inSymbol: side === 'buy' ? row.baseSymbol : row.sym,
    outSymbol: side === 'buy' ? row.sym : row.baseSymbol,
    inAmount: baseAmount,
    outAmount: tokensOut,
    impactPct: 0,
    feeBps: 0,
    feeAmount: 0,
  });
  const label = hops.map((h) => h.venue).join(' \u2192 ');
  return {
    sym: row.sym,
    net: input.net,
    side,
    nativeUnit: native,
    amountIn: amount,
    amountOut: tokensOut,
    minOut: tokensOut,
    hops,
    routeLabel: label,
    effFeePct: 0,
    impactPct: 0,
    expiresAt: now,
    indicative: true,
    nativeUsd: usdPrice,
  };
}

/* -------------------------------------------------------------------- legacy indicative path */

/**
 * Byte-for-byte the pre-2.R placeholder from `routes/quote.ts`, kept for rows
 * with no curve state (`curveK === '0'`) — every row the Phase 1.C
 * fixture-driven read-path track seeds, plus any pre-migration row. Removing
 * this would either break that track's existing tests out from under a
 * concurrently-working sibling agent, or require every fixture in that track
 * to grow real curve columns, which is this phase's job to add support for,
 * not to demand of it.
 */
async function composeIndicativeQuote(
  input: ComposeQuoteInput,
  native: NativeUnit,
  aggregatorVenue: Venue | null,
): Promise<ComposedQuote> {
  const { net, side, amount, row, usdPrice, now } = input;
  const feePct = effFeePctForRow(row, now);
  const hops: QuoteHop[] = [];
  const baseAmount = amount;
  const feeAmount = baseAmount * (feePct / 100);
  const netOfFee = baseAmount - feeAmount;
  const tokenPrice = row.mc / row.supply;
  const tokensOut = tokenPrice > 0 && usdPrice ? (netOfFee * usdPrice) / tokenPrice : 0;

  if (side === 'buy') {
    if (aggregatorVenue) {
      hops.push({
        venue: aggregatorVenue,
        inSymbol: native,
        outSymbol: row.baseSymbol,
        inAmount: amount,
        outAmount: baseAmount,
        impactPct: 0,
        feeBps: 0,
        feeAmount: 0,
      });
    }
    hops.push({
      venue: 'CURVE',
      inSymbol: row.baseSymbol,
      outSymbol: row.sym,
      inAmount: baseAmount,
      outAmount: tokensOut,
      impactPct: 0,
      feeBps: Math.round(feePct * 100),
      feeAmount,
    });
  } else {
    hops.push({
      venue: 'CURVE',
      inSymbol: row.sym,
      outSymbol: row.baseSymbol,
      inAmount: baseAmount,
      outAmount: tokensOut,
      impactPct: 0,
      feeBps: Math.round(feePct * 100),
      feeAmount,
    });
    if (aggregatorVenue) {
      hops.push({
        venue: aggregatorVenue,
        inSymbol: row.baseSymbol,
        outSymbol: native,
        inAmount: amount,
        outAmount: baseAmount,
        impactPct: 0,
        feeBps: 0,
        feeAmount: 0,
      });
    }
  }

  const label = hops.map((h) => h.venue).join(' \u2192 ');
  return {
    sym: row.sym,
    net,
    side,
    nativeUnit: native,
    amountIn: amount,
    amountOut: tokensOut,
    minOut: tokensOut,
    hops,
    routeLabel: label,
    effFeePct: feePct,
    impactPct: 0,
    expiresAt: now,
    indicative: true,
    nativeUsd: usdPrice,
  };
}
