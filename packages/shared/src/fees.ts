import { CB_MS, CB_START_FEE } from './constants.js';

/** The subset of a coin the fee math reads. */
export interface FeeCoin {
  /** Creator-set curve fee, percent. Defaults to 1 when absent. */
  tfee?: number | undefined;
  cashback?: boolean | undefined;
  /** Epoch ms the cashback window opened. */
  cbStart?: number | undefined;
}

/* -------------------------------------------------------------------------- */
/* Cashback window                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Milliseconds left in the cashback window, 0 when closed or absent.
 * `now` is injected so this stays pure. `index.html:1567`
 */
export function cbLeft(c: FeeCoin, now: number = Date.now()): number {
  return c.cashback ? Math.max(0, (c.cbStart ?? 0) + CB_MS - now) : 0;
}

/** Is the coin inside its 5-minute cashback window. `index.html:1568` */
export function inCashback(c: FeeCoin, now: number = Date.now()): boolean {
  return !!c.cashback && cbLeft(c, now) > 0;
}

/**
 * Effective curve fee in percent. Outside a cashback window this is the
 * creator's own fee; inside it decays linearly from `CB_START_FEE` (50%) down
 * to that fee across `CB_MS`. `index.html:1569`
 */
export function effFee(c: FeeCoin, now: number = Date.now()): number {
  const base = +(c.tfee || 1);
  if (!inCashback(c, now)) return base;
  return base + (CB_START_FEE - base) * (cbLeft(c, now) / CB_MS);
}

/* -------------------------------------------------------------------------- */
/* The 20 / 60 / 10 / 10 split — economics core                                */
/* -------------------------------------------------------------------------- */

/**
 * How every curve fee divides. These four ratios are load-bearing: changing
 * one changes protocol revenue, creator payouts and the `$STONKZ` flywheel at
 * once. Golden tests pin them, and both programs assert the same integer
 * split on every fill (`programs/curve.json` `feeSplitBps`).
 */
export const FEE_SPLIT = {
  /** Stonkz protocol revenue vault, native SOL/ETH/USDC. */
  protocol: 0.2,
  /** Per-token creator bucket. Shared with that token's stakers. */
  creatorBucket: 0.6,
  /**
   * Stonkz Game vault: swept into `$STONKZ` and distributed through the daily
   * game. The vault keeps its historical `ops` name on chain and on the wire.
   */
  stonkzOps: 0.1,
  /** Buyback-and-burn vault: swept into `$STONKZ` and burned. */
  burn: 0.1,
} as const;

export interface FeeSplit {
  protocol: number;
  creatorBucket: number;
  stonkzOps: number;
  burn: number;
}

/**
 * Split a curve fee four ways. Applies to cashback fills too — only the
 * creator bucket is swapped into the token during the window; the other three
 * legs always stay native.
 *
 * Settlement is on-chain. This is the preview/accounting mirror.
 */
export function splitFee(feeAmount: number): FeeSplit {
  return {
    protocol: feeAmount * FEE_SPLIT.protocol,
    creatorBucket: feeAmount * FEE_SPLIT.creatorBucket,
    stonkzOps: feeAmount * FEE_SPLIT.stonkzOps,
    burn: feeAmount * FEE_SPLIT.burn,
  };
}

export interface CreatorStakerSplit {
  creator: number;
  stakers: number;
}

/**
 * Divide the 60% creator bucket between the creator and that memecoin's
 * stakers. `poolFraction` is `poolFrac()` — capped at 0.5, so stakers can take
 * at most half the bucket (30% of the curve fee) and the creator never drops
 * below 30% of the curve fee.
 *
 * Protocol 20%, game 10% and burn 10% never enter this calculation.
 */
export function creatorVsStakers(creatorBucket: number, poolFraction: number): CreatorStakerSplit {
  const f = Math.min(0.5, Math.max(0, poolFraction));
  const stakers = creatorBucket * f;
  return { creator: creatorBucket - stakers, stakers };
}

/**
 * How the two `$STONKZ` vaults are swept. Both buy `$STONKZ`: the game vault
 * (`stonkzOps`) sends what it bought to the Stonkz Game pot, the burn vault
 * burns it. Kept as ratios so a future recipe (e.g. protocol-owned liquidity)
 * is a constant change, not a code change.
 */
export const OPS_SPLIT = {
  /** Market-buy `$STONKZ` and burn (the burn vault, 100%). */
  burnBuy: 1,
  /** Market-buy `$STONKZ` and hold for the LP. Not in the current recipe. */
  lpTokenBuy: 0,
  /** Stays native and seeds the other side of that LP. Not in the current recipe. */
  lpNative: 0,
} as const;

export interface OpsSplit {
  burnBuy: number;
  lpTokenBuy: number;
  lpNative: number;
}

/**
 * The Phase 7 sweep recipe applied to the accrued 10%, which is already in
 * native SOL or ETH. Until `$STONKZ` has a contract nothing executes — the
 * whole 10% just accrues in the ops vault.
 */
export function opsSplit(native10pct: number): OpsSplit {
  return {
    burnBuy: native10pct * OPS_SPLIT.burnBuy,
    lpTokenBuy: native10pct * OPS_SPLIT.lpTokenBuy,
    lpNative: native10pct * OPS_SPLIT.lpNative,
  };
}

export interface FeePie {
  protocol: number;
  stonkzOps: number;
  burn: number;
  creator: number;
  stakers: number;
}

/**
 * The whole pie in one call — what `drawPie` in the stake modal renders.
 * `protocol + stonkzOps + burn + creator + stakers === feeAmount`.
 */
export function feePie(feeAmount: number, poolFraction: number): FeePie {
  const { protocol, creatorBucket, stonkzOps, burn } = splitFee(feeAmount);
  const { creator, stakers } = creatorVsStakers(creatorBucket, poolFraction);
  return { protocol, stonkzOps, burn, creator, stakers };
}
