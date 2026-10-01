import { nativeUnit, type CurveParams, type Net } from '@stonkz/shared';
import { MaxBuyExceededError } from './errors.js';
import { fromAtoms } from './units.js';

/**
 * `StonkzRouter.maxBuyNative()` — `0` is uncapped; otherwise the router
 * refuses any buy whose `msg.value` exceeds it. EVM-only: the Solana program
 * has no such field, and the shared defaults carry `'0'` for it.
 */
export function maxBuyNativeAtoms(p: CurveParams): bigint {
  try {
    const v = BigInt(p.maxBuyNative);
    return v > 0n ? v : 0n;
  } catch {
    return 0n;
  }
}

/** Whole native units of the cap for copy; `null` when uncapped. */
export function maxBuyNativeWhole(p: CurveParams, decimals = 18): number | null {
  const cap = maxBuyNativeAtoms(p);
  return cap > 0n ? fromAtoms(cap, decimals) : null;
}

/**
 * Throws {@link MaxBuyExceededError} (400) when `nativeAtoms` — the native
 * leg the wallet would send as `msg.value` — is over the cap. `net`'s unit is
 * only for the message.
 */
export function assertUnderMaxBuyNative(
  net: Net,
  p: CurveParams,
  nativeAtoms: bigint,
  decimals = 18,
): void {
  const cap = maxBuyNativeAtoms(p);
  if (cap === 0n || nativeAtoms <= cap) return;
  const unit = nativeUnit(net);
  throw new MaxBuyExceededError(
    net,
    trimZeros(fromAtoms(nativeAtoms, decimals)),
    trimZeros(fromAtoms(cap, decimals)),
    unit,
  );
}

function trimZeros(v: number): string {
  return Number.isFinite(v) ? String(Number(v.toFixed(8))) : String(v);
}
