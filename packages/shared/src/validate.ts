import {
  MAX_CURVE_FEE_PCT,
  MAX_TICKER_LEN,
  MIN_CURVE_FEE_PCT,
  MIN_TIP_ETH,
  MIN_TIP_SOL,
  SUPPLIES,
} from './constants.js';
import type { NativeUnit, Net } from './types.js';

/**
 * Ticker normalisation as the launch stepper does it: uppercase, drop
 * everything outside `A-Z0-9`, then truncate to 10. `index.html:3859`
 */
export function normalizeTicker(input: string | null | undefined): string {
  return String(input ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, MAX_TICKER_LEN);
}

/** A ticker is valid once it normalises to a non-empty string. */
export function isValidTicker(input: string | null | undefined): boolean {
  return normalizeTicker(input).length > 0;
}

/** Uniqueness is per network — the same ticker may exist on SOL and RH. */
export function isTickerTaken(ticker: string, taken: Iterable<string>): boolean {
  const sym = normalizeTicker(ticker);
  if (!sym) return false;
  for (const t of taken) if (normalizeTicker(t) === sym) return true;
  return false;
}

/** The gas token the user pays on a given network. */
export function nativeUnit(net: Net): NativeUnit {
  return net === 'RH' ? 'ETH' : 'SOL';
}

/** Minimum wall tip: 0.001 SOL, 0.0001 ETH. `index.html:3312` */
export function minTip(unit: NativeUnit): number {
  return unit === 'ETH' ? MIN_TIP_ETH : MIN_TIP_SOL;
}

/** A tip clears the floor for its native unit. */
export function isValidTip(amount: number, unit: NativeUnit): boolean {
  return Number.isFinite(amount) && amount >= minTip(unit);
}

/** Only the four fixed supplies from the launch stepper are accepted. */
export function isValidSupply(supply: number): boolean {
  return SUPPLIES.some(([v]) => v === supply);
}

/** Creator-set curve fee must sit inside the 1.0–5.0% slider range. */
export function isValidCurveFee(pct: number): boolean {
  return Number.isFinite(pct) && pct >= MIN_CURVE_FEE_PCT && pct <= MAX_CURVE_FEE_PCT;
}
