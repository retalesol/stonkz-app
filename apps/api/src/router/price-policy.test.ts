import { describe, expect, it } from 'vitest';
import { FakePriceOracle } from '../chain/fake.js';
import type { Logger } from '../observability/logger.js';
import { basePriceFor } from './base-price.js';
import {
  BasePriceUnavailableError,
  STATIC_PRICES_ALLOWED,
  STATIC_PRICES_REFUSED,
  staticPricePolicy,
} from './price-policy.js';

function spyLogger(): Logger & { errors: string[]; warns: string[] } {
  const errors: string[] = [];
  const warns: string[] = [];
  const l: Logger & { errors: string[]; warns: string[] } = {
    errors,
    warns,
    debug: () => {},
    info: () => {},
    warn: (msg) => {
      warns.push(msg);
    },
    error: (msg) => {
      errors.push(msg);
    },
    child: () => l,
  };
  return l;
}

describe('staticPricePolicy', () => {
  it('allows the tables outside production and on STONKZ_STAGING', () => {
    expect(
      staticPricePolicy({ nodeEnv: 'development', stonkzStaging: false, allowStaticPrices: false }),
    ).toEqual(STATIC_PRICES_ALLOWED);
    expect(
      staticPricePolicy({ nodeEnv: 'test', stonkzStaging: false, allowStaticPrices: false }),
    ).toEqual(STATIC_PRICES_ALLOWED);
    expect(
      staticPricePolicy({ nodeEnv: 'production', stonkzStaging: true, allowStaticPrices: false }),
    ).toEqual(STATIC_PRICES_ALLOWED);
  });

  it('refuses them in production unless ALLOW_STATIC_PRICES=1, which is flagged as the escape hatch', () => {
    expect(
      staticPricePolicy({ nodeEnv: 'production', stonkzStaging: false, allowStaticPrices: false }),
    ).toEqual(STATIC_PRICES_REFUSED);
    expect(
      staticPricePolicy({ nodeEnv: 'production', stonkzStaging: false, allowStaticPrices: true }),
    ).toEqual({ allow: true, escapeHatch: true });
  });
});

describe('basePriceFor under the production policy', () => {
  const oracle = new FakePriceOracle({ ETH: 4000, SOL: 200, USDC: 1 });

  it('still prices natives, wrapped natives and stables', async () => {
    const opts = { staticPrices: STATIC_PRICES_REFUSED };
    await expect(basePriceFor('RH', 'WETH', oracle, opts)).resolves.toEqual({
      price1e6: 4_000_000_000n,
      baseDecimals: 18,
    });
    await expect(basePriceFor('SOL', 'SOL', oracle, opts)).resolves.toEqual({
      price1e6: 200_000_000n,
      baseDecimals: 9,
    });
    await expect(basePriceFor('RH', 'USDG', oracle, opts)).resolves.toEqual({
      price1e6: 1_000_000n,
      baseDecimals: 6,
    });
  });

  it('refuses the RH major table and the stock table as `base_price_unavailable` (retryable)', async () => {
    const opts = { staticPrices: STATIC_PRICES_REFUSED };
    const btc = basePriceFor('RH', 'BTC', oracle, opts);
    await expect(btc).rejects.toBeInstanceOf(BasePriceUnavailableError);
    await expect(btc).rejects.toMatchObject({
      baseSymbol: 'BTC',
      reason: 'static_refused',
      retryAfterSeconds: 30,
    });
    await expect(basePriceFor('RH', 'TSLA', oracle, opts)).rejects.toMatchObject({
      reason: 'static_refused',
    });
    // A symbol with no source at all is still `null` (422 at the route), not a retry.
    await expect(basePriceFor('RH', 'PEPE', oracle, opts)).resolves.toBeNull();
    await expect(basePriceFor('BASE', 'TSLA', oracle, opts)).resolves.toBeNull();
  });

  it('keeps the tables in dev/test and, on the escape hatch, logs each table answer at error', async () => {
    await expect(basePriceFor('RH', 'BTC', oracle)).resolves.toMatchObject({
      price1e6: 95_000_000_000n,
    });
    const logger = spyLogger();
    await expect(
      basePriceFor('RH', 'BTC', oracle, {
        staticPrices: { allow: true, escapeHatch: true },
        logger,
      }),
    ).resolves.toMatchObject({ price1e6: 95_000_000_000n });
    await basePriceFor('RH', 'TSLA', oracle, {
      staticPrices: { allow: true, escapeHatch: true },
      logger,
    });
    expect(logger.errors).toHaveLength(2);
    expect(logger.errors[0]).toMatch(/ALLOW_STATIC_PRICES=1/);
  });

  it('turns a failed native oracle read into a retryable unavailability, whatever the policy', async () => {
    const broken = {
      nativeUsd: async () => {
        throw new Error('coinbase 503');
      },
    };
    await expect(basePriceFor('RH', 'ETH', broken)).rejects.toMatchObject({
      name: 'BasePriceUnavailableError',
      reason: 'source_failed',
    });
    const zero = new FakePriceOracle({ ETH: 0, SOL: 0, USDC: 1 });
    await expect(basePriceFor('SOL', 'WSOL', zero)).rejects.toMatchObject({
      reason: 'source_failed',
    });
  });
});
