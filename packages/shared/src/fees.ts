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
/* The 69 / 15 / 10 / 6 split — economics core                                  */
/* -------------------------------------------------------------------------- */

/**
 * How every curve fee divides. These four ratios are load-bearing: changing
 * one changes creator payouts, platform revenue, the `$STONKZ` flywheel and the
 * crate fund at once. Golden tests pin them, and both programs assert the same
 * integer split on every fill (`programs/curve.json` `feeSplitBps`).
 *
 * On-chain names differ from these for history: the buyback vault is
 * `stonkz_ops` / `ops_vault` on chain and the RWA crate fund is the former
 * `burn` vault (`burn_vault`). The live vault accounts keep their seeds; only
 * what they fund changed. The database calls them `buyback` and `rwa`.
 */
export const FEE_SPLIT = {
  /** Per-token creator bucket. Shared with that token's stakers, up to half. */
  creatorBucket: 0.69,
  /** Platform revenue vault (on-chain "protocol"), native SOL/ETH/USDC. */
  protocol: 0.15,
  /**
   * `$STONKZ` buyback vault: swept into `$STONKZ` on the graduated DEX; half of
   * what it buys is loaded into crates as rewards, half is burned.
   */
  buyback: 0.1,
  /** RWA crate fund: native fees buy real-world assets that go into crates. */
  rwa: 0.06,
} as const;

export interface FeeSplit {
  protocol: number;
  creatorBucket: number;
  buyback: number;
  rwa: number;
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
    buyback: feeAmount * FEE_SPLIT.buyback,
    rwa: feeAmount * FEE_SPLIT.rwa,
  };
}

export interface CreatorStakerSplit {
  creator: number;
  stakers: number;
}

/**
 * Divide the 69% creator bucket between the creator and that memecoin's
 * stakers. `poolFraction` is `poolFrac()` — capped at 0.5, so stakers can take
 * at most half the bucket (34.5% of the curve fee) and the creator never drops
 * below 34.5% of the curve fee.
 *
 * Platform 15%, buyback 10% and the RWA fund 6% never enter this calculation.
 */
export function creatorVsStakers(creatorBucket: number, poolFraction: number): CreatorStakerSplit {
  const f = Math.min(0.5, Math.max(0, poolFraction));
  const stakers = creatorBucket * f;
  return { creator: creatorBucket - stakers, stakers };
}

/**
 * How the buyback vault is swept. All of it buys `$STONKZ` on the graduated
 * DEX; half of the bought tokens are loaded into crates as rewards, half are
 * burned. Kept as ratios so a future recipe is a constant change, not a code
 * change. The RWA fund is not split: all of it buys the crate catalog.
 */
export const BUYBACK_SPLIT = {
  /** `$STONKZ` bought and handed to the crate reward pool. */
  crates: 0.5,
  /** `$STONKZ` bought and burned. */
  burn: 0.5,
} as const;

export interface BuybackSplit {
  crates: number;
  burn: number;
}

/**
 * The sweep recipe applied to the accrued 10%, which is already in native
 * SOL, ETH or USDC. Until `$STONKZ` has a contract on the net nothing
 * executes — the whole 10% just accrues in the buyback vault.
 */
export function buybackSplit(native10pct: number): BuybackSplit {
  return {
    crates: native10pct * BUYBACK_SPLIT.crates,
    burn: native10pct * BUYBACK_SPLIT.burn,
  };
}

export interface FeePie {
  protocol: number;
  buyback: number;
  rwa: number;
  creator: number;
  stakers: number;
}

/**
 * The whole pie in one call — what `drawPie` in the stake modal renders.
 * `protocol + buyback + rwa + creator + stakers === feeAmount`.
 */
export function feePie(feeAmount: number, poolFraction: number): FeePie {
  const { protocol, creatorBucket, buyback, rwa } = splitFee(feeAmount);
  const { creator, stakers } = creatorVsStakers(creatorBucket, poolFraction);
  return { protocol, buyback, rwa, creator, stakers };
}
