import { MAX_TICKER_LEN, MIN_TIP_ETH, MIN_TIP_SOL, MIN_TIP_USDC, SUPPLIES } from './constants.js';
import { NET_INFO, isEvmNet } from './nets.js';
import { DEFAULT_CURVE_PARAMS, feeBoundsPct, type CurveParams } from './params.js';
import type { EvmNet, NativeUnit, Net } from './types.js';
import { ALL_NETS } from './types.js';

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

/** Soft board hint only — tickers are reusable after a 5-minute cooldown. */
export function isTickerTaken(ticker: string, taken: Iterable<string>): boolean {
  const sym = normalizeTicker(ticker);
  if (!sym) return false;
  for (const t of taken) if (normalizeTicker(t) === sym) return true;
  return false;
}

/** True for every EVM net — Robinhood Chain, Coinbase Base, Arc. */
export function isEvm(net: Net): net is EvmNet {
  return isEvmNet(net);
}

/** Parse a net string; returns `null` when unknown. */
export function parseNet(raw: string | null | undefined): Net | null {
  return (ALL_NETS as readonly string[]).includes(raw ?? '') ? (raw as Net) : null;
}

/**
 * Infer product net from an address shape.
 * Solana base58 vs `0x` EVM — when both RH and BASE are possible for an
 * EVM address, the caller must pass the connected/session net.
 */
export function inferNetFromAddress(address: string, fallbackEvm: EvmNet = 'RH'): Net {
  const a = address.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) return fallbackEvm;
  return 'SOL';
}

/** The gas token the user pays on a given network. */
export function nativeUnit(net: Net): NativeUnit {
  return NET_INFO[net]?.unit ?? 'SOL';
}

/** Exhaustive list for loops that previously hard-coded `['SOL','RH']`. */
export function allNets(): readonly Net[] {
  return ALL_NETS;
}

/** Minimum wall tip: 0.001 SOL, 0.0001 ETH, 0.25 USDC. `index.html:3312` */
export function minTip(unit: NativeUnit): number {
  return unit === 'ETH' ? MIN_TIP_ETH : unit === 'USDC' ? MIN_TIP_USDC : MIN_TIP_SOL;
}

/** A tip clears the floor for its native unit. */
export function isValidTip(amount: number, unit: NativeUnit): boolean {
  return Number.isFinite(amount) && amount >= minTip(unit);
}

/** Only the four fixed supplies from the launch stepper, at or under the chain's `maxSupply`. */
export function isValidSupply(supply: number, p: CurveParams = DEFAULT_CURVE_PARAMS): boolean {
  return SUPPLIES.some(([v]) => v === supply) && supply <= p.maxSupply;
}

/** Creator-set curve fee must sit inside the chain's `[minFeeBps, maxFeeBps]` (1.0–5.0% by default). */
export function isValidCurveFee(pct: number, p: CurveParams = DEFAULT_CURVE_PARAMS): boolean {
  const { min, max } = feeBoundsPct(p);
  return Number.isFinite(pct) && pct >= min && pct <= max;
}
