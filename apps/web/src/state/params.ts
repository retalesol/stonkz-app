import {
  ALL_NETS,
  DEFAULT_CURVE_PARAMS,
  withDefaultParams,
  type CurveParams,
  type Net,
} from '@stonkz/shared';
import { emit } from '../lib/bus.js';
import { WALLET } from './wallet.js';

/**
 * The launchpad's live tunables per net — fee split, cashback window and
 * start fee, creator-fee bounds, graduation cap, supply cap, router buy cap.
 *
 * Starts at the contract defaults (which is also everything the practice /
 * sim mode ever uses) and is overwritten by `GET /platform/status`'s `params`
 * in live mode (`api/live.ts`). Every view reads through {@link paramsFor} /
 * {@link coinParams} and passes the record to the shared fee helpers, so a
 * change the admin makes on chain reaches previews, countdowns, the launch
 * slider and the how-it-works copy within a poll.
 */
export const PARAMS: Record<Net, CurveParams> = Object.fromEntries(
  ALL_NETS.map((n) => [n, { ...DEFAULT_CURVE_PARAMS }]),
) as Record<Net, CurveParams>;

/** Which nets have a chain-read record (vs the defaults). Display only. */
export const PARAMS_SOURCE: Record<Net, 'default' | 'chain'> = Object.fromEntries(
  ALL_NETS.map((n) => [n, 'default']),
) as Record<Net, 'default' | 'chain'>;

export function paramsFor(net: Net | null | undefined): CurveParams {
  return PARAMS[net ?? WALLET.net] ?? DEFAULT_CURVE_PARAMS;
}

/** The record for a coin: its own net, else the connected net. */
export function coinParams(c: { net?: Net | undefined } | null | undefined): CurveParams {
  return paramsFor(c?.net);
}

/** The connected net's record — what the launch stepper and footer read. */
export function currentParams(): CurveParams {
  return paramsFor(WALLET.net);
}

/**
 * Merge a `/platform/status` `params` map. Unknown nets and missing fields are
 * ignored; a change emits `params` so open views can repaint.
 */
export function applyPlatformParams(
  map: Partial<Record<string, Partial<CurveParams> & { source?: string }>> | null | undefined,
): boolean {
  if (!map) return false;
  let changed = false;
  for (const net of ALL_NETS) {
    const raw = map[net];
    if (!raw || typeof raw !== 'object') continue;
    const next = withDefaultParams(pick(raw));
    if (JSON.stringify(next) !== JSON.stringify(PARAMS[net])) {
      PARAMS[net] = next;
      changed = true;
    }
    const src = raw.source === 'chain' ? 'chain' : 'default';
    if (PARAMS_SOURCE[net] !== src) {
      PARAMS_SOURCE[net] = src;
      changed = true;
    }
  }
  if (changed) emit('params');
  return changed;
}

/** Only the shared fields, with the numeric ones checked, so a malformed payload cannot poison a view. */
function pick(raw: Partial<CurveParams>): Partial<CurveParams> {
  const out: Partial<CurveParams> = {};
  const num = (k: keyof CurveParams): void => {
    const v = raw[k];
    if (typeof v === 'number' && Number.isFinite(v)) (out as Record<string, unknown>)[k] = v;
  };
  num('feeProtocolBps');
  num('feeOpsBps');
  num('feeBurnBps');
  num('minFeeBps');
  num('maxFeeBps');
  num('cbStartFeeBps');
  num('cbWindowSecs');
  num('gradUsd');
  num('maxSupply');
  if (typeof raw.maxBuyNative === 'string' && /^[0-9]+$/.test(raw.maxBuyNative)) {
    out.maxBuyNative = raw.maxBuyNative;
  }
  return out;
}

/** Reset to the defaults (tests, and the sim adapter's `ready()`). */
export function resetParams(): void {
  for (const net of ALL_NETS) {
    PARAMS[net] = { ...DEFAULT_CURVE_PARAMS };
    PARAMS_SOURCE[net] = 'default';
  }
}
