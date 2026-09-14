import { gradMcapBaseAtoms, mcapBase, mcapUsd1e6, splitFee as splitFeeAtoms } from '@stonkz/curve-sim';
import { splitFee, type Net } from '@stonkz/shared';
import type { FeeAccruedEvent } from '../events.js';

/**
 * Turning on-chain integers into the read tables' numbers.
 *
 * The programs speak atoms and 1e6-scaled USD; `chain_events` and every read
 * table speak whole units and plain USD. This file is the only place that
 * conversion happens, so the rounding story is in one place instead of spread
 * across two decoders.
 */

/** Launched-token decimals, per chain. Fixed by the programs, not configurable. */
export const TOKEN_DECIMALS: Record<Net, number> = {
  // `packages/curve-sim`'s TOKEN_DECIMALS, matching `create_token`'s mint init.
  SOL: 6,
  // `programs/evm/src/StonkzToken.sol`: `uint8 public constant decimals = 18`.
  RH: 18,
  BASE: 18,
};

/** Native gas-token decimals, per chain. */
export const NATIVE_DECIMALS: Record<Net, number> = { SOL: 9, RH: 18, BASE: 18 };

/** The canonical wrapped-native base mint per chain — see `router/base-mints.ts`. */
export const NATIVE_BASE_MINTS: Record<Net, readonly string[]> = {
  SOL: ['So11111111111111111111111111111111111111112'],
  RH: [
    '0x0000000000000000000000000000000000000000',
    // aeWETH — docs/robinhood-chain.md row 25.
    '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
    // Robinhood testnet WETH (46630).
    '0x7943e237c7f95da44e0301572d358911207852fa',
  ],
  BASE: [
    '0x0000000000000000000000000000000000000000',
    '0x4200000000000000000000000000000000000006',
  ],
};

export function isNativeBaseMint(net: Net, baseMint: string): boolean {
  const needle = net === 'SOL' ? baseMint : baseMint.toLowerCase();
  return NATIVE_BASE_MINTS[net].includes(needle);
}

/** Atoms to whole units. Lossy by construction — the read tables are `double`. */
export function toWhole(atoms: bigint, decimals: number): number {
  return Number(atoms) / 10 ** decimals;
}

/**
 * Recovers the base asset's decimals from a `TokenCreated` event alone.
 *
 * `gradMcapBase` is `$69,000 * 10^baseDecimals / basePrice1e6` (the programs'
 * `grad_mcap_base_atoms`), so the decimals are the only unknown in an equation
 * we have both other terms for. Searching the plausible range and requiring an
 * exact match is cheaper and more reliable than an extra `getAccountInfo` /
 * `decimals()` RPC round-trip per launch — and it cannot go stale.
 *
 * Returns `null` when nothing matches, which means the event did not come from
 * a curve this code understands. Callers dead-letter rather than guess.
 */
export function inferBaseDecimals(gradMcapBase: bigint, basePrice1e6: bigint): number | null {
  if (gradMcapBase <= 0n || basePrice1e6 <= 0n) return null;
  for (let decimals = 0; decimals <= 24; decimals++) {
    if (gradMcapBaseAtoms(basePrice1e6, decimals) === gradMcapBase) return decimals;
  }
  return null;
}

/** USD value of a base-asset amount, from the launch-time oracle snapshot. */
export function baseAtomsToUsd(atoms: bigint, basePrice1e6: bigint, baseDecimals: number): number {
  return Number(mcapUsd1e6(atoms, basePrice1e6, baseDecimals)) / 1e6;
}

/** USD market cap implied by the post-fill virtual reserves. */
export function marketCapUsd(
  virtualBase: bigint,
  virtualToken: bigint,
  supplyAtoms: bigint,
  basePrice1e6: bigint,
  baseDecimals: number,
): number {
  if (virtualToken <= 0n) return 0;
  const inBase = mcapBase(
    { virtualBase, virtualToken, realBase: 0n, realToken: 0n, k: virtualBase * virtualToken },
    supplyAtoms,
  );
  return Number(mcapUsd1e6(inBase, basePrice1e6, baseDecimals)) / 1e6;
}

export class FeeSplitMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeeSplitMismatchError';
  }
}

/**
 * Checks the chain's own fee legs against the 20/70/10 split **in integer
 * arithmetic**, using the same `splitFee` mirror the programs are held to by
 * `programs/parity-vectors.json`.
 *
 * This is a strictly stronger check than `events.ts`'s `assertFeeSplit`, which
 * compares `double`s with a 1e-9 tolerance: the programs floor the protocol
 * and ops legs and give the remainder to the creator bucket, so the exact
 * relationship is only expressible in integers. Verifying it here — at decode
 * time, on the raw atoms — is the point at which a program bug or a decoder
 * bug is actually detectable.
 */
export function assertOnChainFeeSplit(
  context: string,
  feeTotal: bigint,
  protocol: bigint,
  ops: bigint,
  creatorBucket: bigint,
): void {
  const expected = splitFeeAtoms(feeTotal);
  if (protocol !== expected.protocol || ops !== expected.stonkzOps || creatorBucket !== expected.creatorBucket) {
    throw new FeeSplitMismatchError(
      `${context}: on-chain legs (${protocol}/${creatorBucket}/${ops}) do not match the integer 20/70/10 split of ${feeTotal} (${expected.protocol}/${expected.creatorBucket}/${expected.stonkzOps})`,
    );
  }
}

/**
 * The native-unit fee legs for a `FeeAccrued` chain event.
 *
 * The legs are derived by re-splitting the converted total with the shared
 * `splitFee`, not by converting each on-chain leg independently. That is
 * deliberate: `events.ts::assertFeeSplit` requires the three `double` legs to
 * be exactly 20/70/10 of the `double` total within 1e-9, and independently
 * converting three floored integers cannot satisfy that. The chain's actual
 * integer legs are verified separately and exactly by
 * {@link assertOnChainFeeSplit}, so nothing is being taken on trust — the
 * float legs are a faithful rescaling of a total that was already checked.
 */
export function nativeFeeLegs(
  feeTotalNative: number,
  stakerShareAtoms: bigint,
  creatorBucketAtoms: bigint,
): Pick<FeeAccruedEvent, 'feeAmount' | 'protocol' | 'creatorBucket' | 'stonkzOps' | 'stakerShare'> {
  const legs = splitFee(feeTotalNative);
  // The staker peel is a fraction of the bucket on-chain; carry that same
  // fraction across so it stays inside the bucket after rescaling.
  const stakerFraction =
    creatorBucketAtoms > 0n ? Number(stakerShareAtoms) / Number(creatorBucketAtoms) : 0;
  return {
    feeAmount: feeTotalNative,
    protocol: legs.protocol,
    creatorBucket: legs.creatorBucket,
    stonkzOps: legs.stonkzOps,
    stakerShare: legs.creatorBucket * Math.min(0.5, Math.max(0, stakerFraction)),
  };
}

/**
 * Native notional for a fill.
 *
 * When the curve's base asset *is* the wrapped native token the base leg is
 * the native leg, exactly. Otherwise the trade reached the curve through an
 * aggregator hop the launchpad event knows nothing about, so the notional is
 * reconstructed from the USD value at the current native price — the same
 * quantity, one conversion removed. On Robinhood Chain an atomic trade also
 * emits `AtomicBuy`/`AtomicSell`, whose ETH leg is exact and takes precedence;
 * see `evm-source.ts`.
 */
export function nativeNotional(
  net: Net,
  baseMint: string,
  baseAtoms: bigint,
  baseDecimals: number,
  usdValue: number,
  nativeUsdPrice: number,
): number {
  if (isNativeBaseMint(net, baseMint)) return toWhole(baseAtoms, baseDecimals);
  if (nativeUsdPrice <= 0) return 0;
  return usdValue / nativeUsdPrice;
}
