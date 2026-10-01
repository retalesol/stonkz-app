import type { ApiEnv } from '../env.js';

/**
 * Whether the indicative static USD tables (`router/base-price.ts`
 * `RH_MAJOR_USD`, `router/stock-price.ts` `STOCK_STATIC_USD`,
 * `router/oracle-hop.ts` `RH_BASE_USD`) may answer at all.
 *
 * - `allow: false` — production. A base with no live source is
 *   *unavailable* (`BasePriceUnavailableError`, 503 + `retryAfter` at the
 *   route), never priced from a table that drifts from the market.
 * - `allow: true` — development, test and `STONKZ_STAGING`, where the
 *   tables mirror what `PushPriceSource` was seeded with on testnet; or the
 *   `ALLOW_STATIC_PRICES=1` escape hatch (`escapeHatch: true`), which logs
 *   every table answer at `error` so it cannot go unnoticed.
 */
export type StaticPricePolicy = { allow: true; escapeHatch: boolean } | { allow: false };

export const STATIC_PRICES_ALLOWED: StaticPricePolicy = { allow: true, escapeHatch: false };
export const STATIC_PRICES_REFUSED: StaticPricePolicy = { allow: false };

/** The policy for this process, from env. */
export function staticPricePolicy(
  env: Pick<ApiEnv, 'nodeEnv' | 'stonkzStaging' | 'allowStaticPrices'>,
): StaticPricePolicy {
  if (env.nodeEnv !== 'production' || env.stonkzStaging) return STATIC_PRICES_ALLOWED;
  return env.allowStaticPrices ? { allow: true, escapeHatch: true } : STATIC_PRICES_REFUSED;
}

/** Suggested `Retry-After` for a `base_price_unavailable` refusal, seconds. */
export const BASE_PRICE_RETRY_AFTER_SECONDS = 30;

/**
 * A base that *has* a price source, which did not answer (or, in production,
 * would only have answered from a static table). Distinct from `null`, "no
 * source for this symbol on this net at all", so `/launch/prepare` can say
 * 503 + retry instead of 422.
 */
export class BasePriceUnavailableError extends Error {
  readonly retryAfterSeconds = BASE_PRICE_RETRY_AFTER_SECONDS;
  constructor(
    readonly baseSymbol: string,
    readonly reason: 'static_refused' | 'source_failed',
    cause?: unknown,
  ) {
    super(
      reason === 'static_refused'
        ? `${baseSymbol} has no live USD price source; the static table is refused in production`
        : `the USD price source for ${baseSymbol} did not answer`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'BasePriceUnavailableError';
  }
}
