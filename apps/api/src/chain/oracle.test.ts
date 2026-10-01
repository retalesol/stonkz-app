import { describe, expect, it, vi } from 'vitest';
import type { NativeUnit } from '@stonkz/shared';
import type { Alert } from '../observability/metrics.js';
import { MemoryRedis } from '../redis/memory.js';
import {
  CachedPriceOracle,
  MedianPriceOracle,
  PYTH_ETH_USD_FEED,
  PYTH_SOL_USD_FEED,
  PythHermesNativeOracle,
  medianOf,
  type HermesPriceReader,
} from './oracle.js';
import type { PriceOracle } from './types.js';

const NOW_MS = 1_790_000_000_000;
const NOW_S = NOW_MS / 1000;

function hermesWith(
  prices: Partial<Record<string, { usd: number; publishTime: number } | null>>,
): HermesPriceReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async latest(feedId) {
      calls.push(feedId);
      const p = prices[feedId];
      if (!p) return null;
      return { price1e6: BigInt(Math.round(p.usd * 1e6)), publishTime: p.publishTime };
    },
  };
}

describe('PythHermesNativeOracle', () => {
  it('prices ETH and SOL from their Pyth feeds while the publish time is fresh', async () => {
    const hermes = hermesWith({
      [PYTH_ETH_USD_FEED]: { usd: 4_123.45, publishTime: NOW_S - 5 },
      [PYTH_SOL_USD_FEED]: { usd: 212.5, publishTime: NOW_S - 60 },
    });
    const oracle = new PythHermesNativeOracle({ hermes, now: () => NOW_MS });
    await expect(oracle.nativeUsd('ETH')).resolves.toBeCloseTo(4_123.45, 6);
    await expect(oracle.nativeUsd('SOL')).resolves.toBeCloseTo(212.5, 6);
    expect(hermes.calls).toEqual([PYTH_ETH_USD_FEED, PYTH_SOL_USD_FEED]);
  });

  it('answers 1 for USDC without asking Hermes', async () => {
    const hermes = hermesWith({});
    const oracle = new PythHermesNativeOracle({ hermes, now: () => NOW_MS });
    await expect(oracle.nativeUsd('USDC')).resolves.toBe(1);
    expect(hermes.calls).toEqual([]);
  });

  it('refuses a stale publish time and a missing feed', async () => {
    const hermes = hermesWith({
      [PYTH_ETH_USD_FEED]: { usd: 4_000, publishTime: NOW_S - 61 },
    });
    const oracle = new PythHermesNativeOracle({ hermes, now: () => NOW_MS });
    await expect(oracle.nativeUsd('ETH')).rejects.toThrow(/stale/);
    await expect(oracle.nativeUsd('SOL')).rejects.toThrow(/no SOL\/USD/);
  });
});

function source(name: string, fn: (unit: NativeUnit) => Promise<number>) {
  const oracle: PriceOracle = { nativeUsd: vi.fn(fn) };
  return { name, oracle };
}

describe('MedianPriceOracle', () => {
  it('answers the median when the sources agree within 2 %', async () => {
    const alerts: Alert[] = [];
    const oracle = new MedianPriceOracle(
      [source('coinbase', async () => 4_000), source('pyth', async () => 4_040)],
      { preferred: 'pyth', onAlert: (a) => alerts.push(a), now: () => NOW_MS },
    );
    await expect(oracle.nativeUsd('ETH')).resolves.toBe(4_020);
    expect(alerts).toEqual([]);
  });

  it('prefers Pyth and alerts once (edge-triggered) when they disagree by more than 2 %', async () => {
    const alerts: Alert[] = [];
    let coinbase = 4_000;
    const oracle = new MedianPriceOracle(
      [source('coinbase', async () => coinbase), source('pyth', async () => 4_200)],
      { preferred: 'pyth', onAlert: (a) => alerts.push(a), now: () => NOW_MS },
    );
    await expect(oracle.nativeUsd('ETH')).resolves.toBe(4_200);
    await expect(oracle.nativeUsd('ETH')).resolves.toBe(4_200);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      key: 'oracle-divergence:ETH',
      severity: 'warn',
      fields: { unit: 'ETH', coinbase: 4_000, pyth: 4_200, preferred: 'pyth' },
    });
    expect(alerts[0]!.fields['spreadBps']).toBeGreaterThan(200);

    // Back in agreement: one RESOLVED line, then the median again.
    coinbase = 4_190;
    await expect(oracle.nativeUsd('ETH')).resolves.toBe(4_195);
    expect(alerts).toHaveLength(2);
    expect(alerts[1]!.message).toMatch(/^RESOLVED/);
  });

  it('uses whichever source answers when the other fails or times out', async () => {
    vi.useFakeTimers();
    try {
      const hung = source('coinbase', () => new Promise<number>(() => {}));
      const failing = source('coinbase', async () => {
        throw new Error('HTTP 503');
      });
      const pyth = source('pyth', async () => 4_100);

      const a = new MedianPriceOracle([failing, pyth], { preferred: 'pyth', now: () => NOW_MS });
      await expect(a.nativeUsd('ETH')).resolves.toBe(4_100);

      const b = new MedianPriceOracle([hung, pyth], {
        preferred: 'pyth',
        timeoutMs: 1_000,
        now: () => NOW_MS,
      });
      const pending = b.nativeUsd('ETH');
      await vi.advanceTimersByTimeAsync(1_001);
      await expect(pending).resolves.toBe(4_100);
    } finally {
      vi.useRealTimers();
    }
  });

  it('serves the last good price for five minutes when every source is down, then fails', async () => {
    let clock = NOW_MS;
    let down = false;
    const flaky = (name: string) =>
      source(name, async () => {
        if (down) throw new Error(`${name} down`);
        return 4_000;
      });
    const oracle = new MedianPriceOracle([flaky('coinbase'), flaky('pyth')], {
      preferred: 'pyth',
      now: () => clock,
    });
    await expect(oracle.nativeUsd('ETH')).resolves.toBe(4_000);
    down = true;
    clock += 5 * 60_000;
    await expect(oracle.nativeUsd('ETH')).resolves.toBe(4_000);
    clock += 1;
    await expect(oracle.nativeUsd('ETH')).rejects.toThrow(
      /no native price for ETH.*coinbase down.*pyth down/,
    );
    // SOL was never priced: nothing to fall back to.
    await expect(oracle.nativeUsd('SOL')).rejects.toThrow(/no native price for SOL/);
  });

  it('ignores a non-positive answer as a failure', async () => {
    const oracle = new MedianPriceOracle(
      [source('coinbase', async () => 0), source('pyth', async () => 150)],
      { preferred: 'pyth', now: () => NOW_MS },
    );
    await expect(oracle.nativeUsd('SOL')).resolves.toBe(150);
  });

  it('refuses to be built without a source', () => {
    expect(() => new MedianPriceOracle([])).toThrow(/at least one source/);
  });
});

describe('medianOf', () => {
  it('takes the middle value, or the mean of the middle two', () => {
    expect(medianOf([3, 1, 2])).toBe(2);
    expect(medianOf([4, 1])).toBe(2.5);
    expect(medianOf([7])).toBe(7);
  });
});

describe('CachedPriceOracle', () => {
  it('serves Redis, then the inner source, then last-good for at most five minutes', async () => {
    let clock = NOW_MS;
    let down = false;
    const inner: PriceOracle = {
      nativeUsd: vi.fn(async () => {
        if (down) throw new Error('every source down');
        return 4_000;
      }),
    };
    const redis = new MemoryRedis(() => clock);
    const oracle = new CachedPriceOracle(inner, redis, 30, { now: () => clock });
    await expect(oracle.nativeUsd('ETH')).resolves.toBe(4_000);
    await expect(oracle.nativeUsd('ETH')).resolves.toBe(4_000);
    expect(inner.nativeUsd).toHaveBeenCalledTimes(1); // Redis hit

    down = true;
    clock += 31_000; // Redis entry expired; inner fails; last-good is 31 s old
    await expect(oracle.nativeUsd('ETH')).resolves.toBe(4_000);
    clock += 5 * 60_000; // …now past the cap
    await expect(oracle.nativeUsd('ETH')).rejects.toThrow(/every source down/);
  });
});
