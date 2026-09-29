import { describe, expect, it, vi } from 'vitest';
import {
  DEFILLAMA_CACHE_MS,
  DefiLlamaClient,
  RWA_DEFILLAMA_COINS,
  firstUsdPrice,
  rwaUsdValue,
  rwaUsdValues,
  type UsdPriceSource,
} from './defillama.js';

/** DefiLlama's coins API behind a fake `fetch`. */

const NOW_MS = 1_790_000_000_000;
const NOW_S = NOW_MS / 1000;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function coin(price: number, over: Record<string, unknown> = {}) {
  return { price, symbol: 'X', timestamp: NOW_S - 60, confidence: 0.99, ...over };
}

describe('DefiLlamaClient', () => {
  it('asks /prices/current/{coins}?searchWidth=4h in one request', async () => {
    const urls: string[] = [];
    let now = NOW_MS;
    const client = new DefiLlamaClient({
      baseUrl: 'https://coins.example/',
      now: () => now,
      fetchImpl: async (url) => {
        urls.push(url);
        return jsonResponse({
          coins: {
            'coingecko:tesla-xstock': coin(358.4),
            'coingecko:pax-gold': coin(4153),
          },
        });
      },
    });
    const prices = await client.prices(['coingecko:tesla-xstock', 'coingecko:pax-gold']);
    expect(urls).toEqual([
      'https://coins.example/prices/current/coingecko:tesla-xstock,coingecko:pax-gold?searchWidth=4h',
    ]);
    expect(prices).toEqual(
      new Map([
        ['coingecko:tesla-xstock', 358.4],
        ['coingecko:pax-gold', 4153],
      ]),
    );

    // Cached 30 s (a coin with no price too), then asked again.
    now += DEFILLAMA_CACHE_MS - 1;
    await client.prices(['coingecko:tesla-xstock', 'coingecko:pax-gold']);
    expect(urls).toHaveLength(1);
    now += 1;
    await client.prices(['coingecko:tesla-xstock']);
    expect(urls).toHaveLength(2);
  });

  it('ignores a price with confidence < 0.9 or older than 4 h', async () => {
    const client = new DefiLlamaClient({
      now: () => NOW_MS,
      fetchImpl: async () =>
        jsonResponse({
          coins: {
            'coingecko:a': coin(1, { confidence: 0.89 }),
            'coingecko:b': coin(2, { timestamp: NOW_S - 4 * 3600 - 1 }),
            'coingecko:c': coin(3, { timestamp: NOW_S - 4 * 3600 }),
            'coingecko:d': coin(-1),
          },
        }),
    });
    const prices = await client.prices([
      'coingecko:a',
      'coingecko:b',
      'coingecko:c',
      'coingecko:d',
    ]);
    expect([...prices.keys()]).toEqual(['coingecko:c']);
  });

  it('gives up after 3 s and does not cache the failure', async () => {
    vi.useFakeTimers();
    try {
      let hang = true;
      const fetchImpl = vi.fn(async () =>
        hang
          ? new Promise<Response>(() => {})
          : jsonResponse({ coins: { 'coingecko:a': coin(5) } }),
      );
      const client = new DefiLlamaClient({ now: () => NOW_MS, fetchImpl });
      const pending = client.prices(['coingecko:a']);
      await vi.advanceTimersByTimeAsync(3_001);
      await expect(pending).resolves.toEqual(new Map());
      hang = false;
      await expect(client.prices(['coingecko:a'])).resolves.toEqual(new Map([['coingecko:a', 5]]));
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers nothing on an HTTP error, and never sends a malformed coin id', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 502));
    const client = new DefiLlamaClient({ now: () => NOW_MS, fetchImpl });
    await expect(client.prices(['coingecko:a'])).resolves.toEqual(new Map());
    await expect(client.prices(['no-colon', 'a:b/../c'])).resolves.toEqual(new Map());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

function fixed(prices: Record<string, number>): UsdPriceSource & { calls: number } {
  const src = {
    calls: 0,
    prices: async (coins: readonly string[]) => {
      src.calls++;
      return new Map(coins.filter((c) => c in prices).map((c) => [c, prices[c]!] as const));
    },
  };
  return src;
}

describe('firstUsdPrice', () => {
  it('takes the first coin, in order, that priced', async () => {
    const src = fixed({ 'coingecko:b': 2, 'coingecko:c': 3 });
    await expect(firstUsdPrice(src, ['coingecko:a', 'coingecko:b', 'coingecko:c'])).resolves.toBe(
      2,
    );
    await expect(firstUsdPrice(src, ['coingecko:a'])).resolves.toBeNull();
    await expect(firstUsdPrice(src, [])).resolves.toBeNull();
  });
});

describe('RWA crate valuations', () => {
  const src = fixed({ 'coingecko:pax-gold': 4153, 'coingecko:tesla-xstock': 358.4 });

  it('maps PAXG to pax-gold and the stock RWAs to their xStocks', () => {
    expect(RWA_DEFILLAMA_COINS).toEqual({
      PAXG: 'coingecko:pax-gold',
      TSLA: 'coingecko:tesla-xstock',
      AMZN: 'coingecko:amazon-xstock',
      PLTR: 'coingecko:palantir-xstock',
      AMD: 'coingecko:amd-xstock',
    });
  });

  it('values units of one asset, null when it cannot', async () => {
    await expect(rwaUsdValue(src, 'paxg', 0.5)).resolves.toBeCloseTo(2076.5);
    await expect(rwaUsdValue(src, 'NFLX', 1)).resolves.toBeNull();
    await expect(rwaUsdValue(src, 'AMZN', 1)).resolves.toBeNull();
  });

  it('values every position in one request, totalling the ones that priced', async () => {
    const one = fixed({ 'coingecko:pax-gold': 4000, 'coingecko:tesla-xstock': 300 });
    const v = await rwaUsdValues(one, [
      { asset: 'PAXG', units: 0.01 },
      { asset: 'TSLA', units: 2 },
      { asset: 'NFLX', units: 1 },
    ]);
    expect(one.calls).toBe(1);
    expect(v.total).toBeCloseTo(640);
    expect(v.positions).toEqual([
      { asset: 'PAXG', units: 0.01, usd: 40 },
      { asset: 'TSLA', units: 2, usd: 600 },
      { asset: 'NFLX', units: 1, usd: null },
    ]);
    await expect(rwaUsdValues(one, [])).resolves.toEqual({ total: null, positions: [] });
  });
});
