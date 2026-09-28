/**
 * The Stonkz curve, in TypeScript, for previews and quotes.
 *
 * This is a mirror, not a source of truth. The chain settles; this reproduces
 * what the chain will do so `/quote`, the Step-3 launch preview and the fill a
 * user actually gets are the same number. It is checked against
 * `programs/parity-vectors.json`, which is generated from the Rust program, by
 * `programs/solana/scripts/verify-parity.ts`.
 *
 * Everything is `bigint` in atoms. No floats anywhere — a float here would
 * reintroduce exactly the drift this file exists to prevent. Zero dependencies
 * so both `apps/api` and `apps/web` can import it directly.
 */

/* ------------------------------------------------------------------ constants */

export const BPS_DEN = 10_000n;
/** Platform revenue leg (the vault keeps its historical `protocol` name). */
export const FEE_PROTOCOL_BPS = 1_500n;
/** `$STONKZ` buyback leg: half to crates, half burned (vault keeps its historical `ops` name). */
export const FEE_OPS_BPS = 1_000n;
/** RWA crate-fund leg (vault keeps its historical `burn` name). */
export const FEE_BURN_BPS = 600n;

export const TOKENS_FOR_SALE_NUM = 4n;
export const TOKENS_FOR_SALE_DEN = 5n;
export const VIRTUAL_TOKEN_NUM = 16n;
export const VIRTUAL_TOKEN_DEN = 15n;
export const VIRTUAL_BASE_DEN = 15n;

/** $69,000 scaled 1e6. */
export const GRAD_MCAP_USD_1E6 = 69_000_000_000n;

export const TOKEN_DECIMALS = 6;
export const MIN_FEE_BPS = 100;
export const MAX_FEE_BPS = 500;

export const CB_WINDOW_SECS = 300n;
export const CB_START_FEE_BPS = 5_000n;

export const LOCK_DAYS = [0, 1, 7, 30, 90, 180, 365] as const;
/** FLEX is zero on purpose — see SPEC.md §2. */
export const LOCK_WEIGHT_BPS = [0n, 11_000n, 12_500n, 15_000n, 25_000n, 50_000n, 80_000n];

export const ACC_PRECISION = 1_000_000_000_000n;
/** `real_base` is a u64 on Solana and reaches 3x this by graduation. */
export const MAX_VIRTUAL_BASE = (2n ** 64n - 1n) / 4n;

/* -------------------------------------------------------------------- helpers */

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/* ------------------------------------------------------------------ fee split */

export interface FeeShares {
  protocol: bigint;
  stonkzOps: bigint;
  burn: bigint;
  creatorBucket: bigint;
}

/**
 * The 15 / 10 / 6 / 69 split (platform / buyback / RWA fund / creator bucket).
 * `creatorBucket` is the remainder rather than a
 * fourth floor, which is what makes the four shares reconstruct the fee
 * exactly for every input. At most 3 atoms of floor dust land in the bucket.
 */
export function splitFee(fee: bigint): FeeShares {
  const protocol = (fee * FEE_PROTOCOL_BPS) / BPS_DEN;
  const stonkzOps = (fee * FEE_OPS_BPS) / BPS_DEN;
  const burn = (fee * FEE_BURN_BPS) / BPS_DEN;
  return { protocol, stonkzOps, burn, creatorBucket: fee - protocol - stonkzOps - burn };
}

export interface BucketSplit {
  creator: bigint;
  stakers: bigint;
}

/**
 * How the 70% bucket divides between the creator and that coin's stakers.
 * Runs after `splitFee`, on the bucket alone — protocol and ops are already
 * in different vaults and cannot reach this.
 *
 * `eligibleStaked` counts only positions locked for at least a day; FLEX is
 * excluded, because it earns no weight and must not dilute the pool.
 * `circulating` is `tokensForSale - realTokenReserves`, read from the curve,
 * never the UI's old hard-coded 80%.
 */
export function splitCreatorBucket(
  bucket: bigint,
  eligibleStaked: bigint,
  circulating: bigint,
): BucketSplit {
  if (bucket === 0n || eligibleStaked === 0n || circulating === 0n) {
    return { creator: bucket, stakers: 0n };
  }
  const half = bucket / 2n;
  let stakers = (bucket * eligibleStaked) / (circulating * 2n);
  if (stakers > half) stakers = half;
  return { creator: bucket - stakers, stakers };
}

/* -------------------------------------------------------------------- cashback */

/**
 * Effective curve fee in bps at `nowSecs`.
 *
 * Whole seconds, because that is the granularity `Clock` gives the program.
 * A client mirroring this from a millisecond timer must floor to seconds first
 * or it will quote a fee the chain will not charge.
 */
export function effFeeBps(
  baseBps: number,
  cashback: boolean,
  cbStartSecs: bigint,
  nowSecs: bigint,
): number {
  if (!cashback) return baseBps;
  let remaining = cbStartSecs + CB_WINDOW_SECS - nowSecs;
  if (remaining <= 0n) return baseBps;
  if (remaining > CB_WINDOW_SECS) remaining = CB_WINDOW_SECS;
  const base = BigInt(baseBps);
  return Number(base + ((CB_START_FEE_BPS - base) * remaining) / CB_WINDOW_SECS);
}

/* ---------------------------------------------------------------------- curve */

export interface CurveParams {
  tokensForSale: bigint;
  lpReserve: bigint;
  virtualToken: bigint;
  virtualBase: bigint;
  k: bigint;
  gradMcapBase: bigint;
}

/** Base atoms worth $69,000 at `price1e6` USD per whole base token. */
export function gradMcapBaseAtoms(price1e6: bigint, baseDecimals: number): bigint {
  if (price1e6 <= 0n) throw new Error('price must be positive');
  return (GRAD_MCAP_USD_1E6 * 10n ** BigInt(baseDecimals)) / price1e6;
}

export interface DeriveCurveOptions {
  /**
   * The EVM launchpad keeps amounts in `uint256`, so the u64 ceiling on
   * `virtualBase` does not apply there. It matters for Arc: native USDC at
   * $1 with 18 decimals puts `virtualBase` at ~4.3e21, far past `u64::MAX/4`,
   * which is fine on chain and must not be refused by this mirror.
   */
  evm?: boolean;
}

/**
 * Derive a curve from its fixed supply and the base price read at launch.
 * Returns `null` for combinations Solana cannot represent (see
 * `MAX_VIRTUAL_BASE`) unless `opts.evm` is set; the EVM mirror accepts a
 * wider range.
 */
export function deriveCurve(
  supplyAtoms: bigint,
  price1e6: bigint,
  baseDecimals: number,
  opts: DeriveCurveOptions = {},
): CurveParams | null {
  if (supplyAtoms <= 0n) return null;
  const tokensForSale = (supplyAtoms * TOKENS_FOR_SALE_NUM) / TOKENS_FOR_SALE_DEN;
  const lpReserve = supplyAtoms - tokensForSale;
  const virtualToken = (supplyAtoms * VIRTUAL_TOKEN_NUM) / VIRTUAL_TOKEN_DEN;
  if (virtualToken <= tokensForSale) return null;

  const gradMcapBase = gradMcapBaseAtoms(price1e6, baseDecimals);
  // Ceil: graduation mcap is 15x this, so the residue must land above target.
  const virtualBase = ceilDiv(gradMcapBase, VIRTUAL_BASE_DEN);
  if (virtualBase === 0n) return null;
  if (!opts.evm && virtualBase > MAX_VIRTUAL_BASE) return null;

  return {
    tokensForSale,
    lpReserve,
    virtualToken,
    virtualBase,
    k: virtualBase * virtualToken,
    gradMcapBase,
  };
}

export interface CurveState {
  virtualBase: bigint;
  virtualToken: bigint;
  realBase: bigint;
  realToken: bigint;
  k: bigint;
}

export interface BuyFill {
  /** Base actually pulled. Less than requested when the order was capped. */
  grossBase: bigint;
  fee: bigint;
  netBase: bigint;
  tokensOut: bigint;
  curveComplete: boolean;
}

/**
 * Buy against the curve. An order larger than the remaining allocation is
 * **capped, not rejected**: the quote solves for the base needed to take the
 * rest of the curve and grosses it back up through the fee, so the trader is
 * never charged for tokens that do not exist.
 */
export function buyQuote(st: CurveState, feeBps: number, amountBase: bigint): BuyFill | null {
  if (amountBase <= 0n || st.realToken === 0n) return null;
  const bps = BigInt(feeBps);
  if (bps >= BPS_DEN) return null;

  const fee = (amountBase * bps) / BPS_DEN;
  const net = amountBase - fee;
  if (net === 0n) return null;

  const newVt = ceilDiv(st.k, st.virtualBase + net);
  const tokensOut = st.virtualToken - newVt;

  if (tokensOut <= st.realToken) {
    return {
      grossBase: amountBase,
      fee,
      netBase: net,
      tokensOut,
      curveComplete: tokensOut === st.realToken,
    };
  }

  const capped = st.realToken;
  const vtAfter = st.virtualToken - capped;
  if (vtAfter === 0n) return null;
  const neededVb = ceilDiv(st.k, vtAfter);
  const netNeeded = neededVb - st.virtualBase;
  if (netNeeded <= 0n) return null;
  const gross = ceilDiv(netNeeded * BPS_DEN, BPS_DEN - bps);

  return {
    grossBase: gross,
    fee: gross - netNeeded,
    netBase: netNeeded,
    tokensOut: capped,
    curveComplete: true,
  };
}

export interface SellFill {
  /** Base leaving the pool, before the fee is peeled off it. */
  grossBase: bigint;
  fee: bigint;
  /** What the trader receives. */
  netBase: bigint;
}

export function sellQuote(st: CurveState, feeBps: number, amountToken: bigint): SellFill | null {
  if (amountToken <= 0n) return null;
  const bps = BigInt(feeBps);
  if (bps >= BPS_DEN) return null;

  const newVb = ceilDiv(st.k, st.virtualToken + amountToken);
  let gross = st.virtualBase - newVb;
  if (gross > st.realBase) gross = st.realBase;
  if (gross <= 0n) return null;

  const fee = (gross * bps) / BPS_DEN;
  return { grossBase: gross, fee, netBase: gross - fee };
}

/** The zero-fee cashback swap: the creator bucket, converted to the token. */
export function zeroFeeBuy(st: CurveState, amountBase: bigint): bigint | null {
  if (amountBase <= 0n || st.realToken === 0n) return null;
  const newVt = ceilDiv(st.k, st.virtualBase + amountBase);
  const out = st.virtualToken - newVt;
  if (out <= 0n || out > st.realToken) return null;
  return out;
}

/* ------------------------------------------------------------------ valuation */

export function mcapBase(st: CurveState, supplyAtoms: bigint): bigint {
  return (st.virtualBase * supplyAtoms) / st.virtualToken;
}

export function mcapUsd1e6(mcap: bigint, price1e6: bigint, baseDecimals: number): bigint {
  return (mcap * price1e6) / 10n ** BigInt(baseDecimals);
}

/** Tokens sold out of the allocation — the circulating supply staking measures against. */
export function circulating(tokensForSale: bigint, realToken: bigint): bigint {
  return tokensForSale > realToken ? tokensForSale - realToken : 0n;
}

export function stakeWeight(amount: bigint, lockDays: number): bigint | null {
  const i = LOCK_DAYS.indexOf(lockDays as (typeof LOCK_DAYS)[number]);
  if (i < 0) return null;
  return (amount * LOCK_WEIGHT_BPS[i]) / BPS_DEN;
}

/** Apply a fill to a state, returning the next state. Pure. */
export function applyBuy(st: CurveState, f: BuyFill): CurveState {
  return {
    virtualBase: st.virtualBase + f.netBase,
    virtualToken: st.virtualToken - f.tokensOut,
    realBase: st.realBase + f.netBase,
    realToken: st.realToken - f.tokensOut,
    k: st.k,
  };
}

export function applySell(st: CurveState, f: SellFill, amountToken: bigint): CurveState {
  return {
    virtualBase: st.virtualBase - f.grossBase,
    virtualToken: st.virtualToken + amountToken,
    realBase: st.realBase - f.grossBase,
    realToken: st.realToken + amountToken,
    k: st.k,
  };
}

/** A fresh state from derived parameters. */
export function freshState(p: CurveParams): CurveState {
  return {
    virtualBase: p.virtualBase,
    virtualToken: p.virtualToken,
    realBase: 0n,
    realToken: p.tokensForSale,
    k: p.k,
  };
}
