import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { QUOTE_CACHE_TTL_SECONDS, quoteCacheKey } from '../redis/quote-cache.js';
import { tokens } from '../db/schema.js';
import { createTestApp, type TestApp } from '../test/app.js';

let h: TestApp;

beforeAll(async () => {
  h = await createTestApp();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.db.reset();
  await h.clearRateLimits();
  await seed();
});

const T0 = Date.parse('2026-09-06T12:00:00.000Z');
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const BONK_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const MINT_NATIVE = 'mint-NATIVE';
const MINT_VIABONK = 'mint-VIABONK';
const MINT_RHTOK = '0x00000000000000000000000000000000000000a1';
const MINT_GRADUATED = 'mint-GRADUATED';
const MINT_CASHBK = 'mint-CASHBK';

async function seed(): Promise<void> {
  h.setNow(T0);
  await h.deps.db.insert(tokens).values([
    // Base is the native token, so there is no aggregator hop at all.
    {
      net: 'SOL',
      sym: 'NATIVE',
      name: 'Native Based',
      creator: 'Dev',
      mint: MINT_NATIVE,
      baseSymbol: 'SOL',
      baseMint: SOL_MINT,
      supply: 1_000_000_000,
      feeBps: 250,
      mc: 20_000,
      lane: 'new',
      seed: 1,
      launchedAt: new Date(T0 - 600_000),
    },
    // Base is a major, so hop 1 goes through the aggregator.
    {
      net: 'SOL',
      sym: 'VIABONK',
      name: 'Via Bonk',
      creator: 'Dev',
      mint: MINT_VIABONK,
      baseSymbol: 'BONK',
      baseMint: BONK_MINT,
      supply: 1_000_000_000,
      feeBps: 250,
      mc: 20_000,
      lane: 'new',
      seed: 2,
      launchedAt: new Date(T0 - 600_000),
    },
    {
      net: 'RH',
      sym: 'RHTOK',
      name: 'RH Token',
      creator: 'Dev',
      mint: MINT_RHTOK,
      baseSymbol: 'USDC',
      baseMint: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      supply: 1_000_000_000,
      feeBps: 200,
      mc: 20_000,
      lane: 'new',
      seed: 3,
      launchedAt: new Date(T0 - 600_000),
    },
    {
      net: 'SOL',
      sym: 'GRADUATED',
      name: 'Graduated',
      creator: 'Dev',
      mint: MINT_GRADUATED,
      baseSymbol: 'SOL',
      baseMint: SOL_MINT,
      supply: 1_000_000_000,
      feeBps: 250,
      mc: 100_000,
      lane: 'grad',
      seed: 4,
      launchedAt: new Date(T0 - 6_000_000),
      graduatedAt: new Date(T0 - 60_000),
    },
    // Cashback window opened 60s ago, so the fee is still decaying.
    {
      net: 'SOL',
      sym: 'CASHBK',
      name: 'Cashback',
      creator: 'Dev',
      mint: MINT_CASHBK,
      baseSymbol: 'SOL',
      baseMint: SOL_MINT,
      supply: 1_000_000_000,
      feeBps: 250,
      mc: 20_000,
      lane: 'new',
      seed: 5,
      cashback: true,
      cbStartMs: T0 - 60_000,
      launchedAt: new Date(T0 - 60_000),
    },
  ]);
}

interface QuoteBody {
  sym: string;
  net: string;
  side: string;
  nativeUnit: string;
  amountIn: number;
  amountOut: number;
  minOut: number;
  routeLabel: string;
  effFeePct: number;
  expiresAt: number;
  indicative: boolean;
  nativeUsd: number | null;
  hops: {
    venue: string;
    inSymbol: string;
    outSymbol: string;
    inAmount: number;
    outAmount: number;
    feeBps: number;
    feeAmount: number;
  }[];
}

async function quote(path: string): Promise<{ status: number; body: QuoteBody; headers: Headers }> {
  const res = await h.app.request(path);
  return { status: res.status, body: (await res.json()) as QuoteBody, headers: res.headers };
}

/** Plan step 59 — the cached, native-denominated quote surface. */
describe('GET /tokens/:sym/quote', () => {
  it('quotes in the native unit and charges nothing on the aggregator hop', async () => {
    const { status, body } = await quote('/tokens/VIABONK/quote?side=buy&amount=1.5');
    expect(status).toBe(200);
    expect(body.nativeUnit).toBe('SOL');
    expect(body.amountIn).toBe(1.5);
    expect(body.hops).toHaveLength(2);

    const [hop1, hop2] = body.hops;
    // Hop 1 is the aggregator. Stonkz never takes a cut here.
    expect(hop1).toMatchObject({ venue: 'JUPITER', inSymbol: 'SOL', outSymbol: 'BONK', feeBps: 0, feeAmount: 0 });
    // Hop 2 is the curve, the only hop that carries a fee.
    expect(hop2?.venue).toBe('CURVE');
    expect(hop2?.feeBps).toBe(250);
    expect(hop2?.feeAmount).toBeCloseTo(1.5 * 0.025, 9);
    expect(body.routeLabel).toBe('JUPITER → CURVE');
  });

  it('skips the aggregator when the base already is the native token', async () => {
    const { body } = await quote('/tokens/NATIVE/quote?side=buy&amount=1');
    expect(body.hops).toHaveLength(1);
    expect(body.hops[0]?.venue).toBe('CURVE');
    expect(body.routeLabel).toBe('CURVE');
  });

  it('routes through Uniswap on Robinhood and prices in ETH', async () => {
    const { body } = await quote('/tokens/RHTOK/quote?net=RH&side=buy&amount=0.5');
    expect(body.nativeUnit).toBe('ETH');
    expect(body.routeLabel).toBe('UNISWAP → CURVE');
    expect(body.hops[1]?.feeBps).toBe(200);
  });

  it('stops charging the curve fee after graduation', async () => {
    const { body } = await quote('/tokens/GRADUATED/quote?side=buy&amount=1');
    expect(body.effFeePct).toBe(0);
    expect(body.hops.at(-1)?.venue).toBe('DEX');
    expect(body.hops.at(-1)?.feeAmount).toBe(0);
  });

  it('applies the decaying cashback fee, not the flat one', async () => {
    const { body } = await quote('/tokens/CASHBK/quote?side=buy&amount=1');
    // 60s into a 300s window: base + (50 - base) * 240/300, well above 2.5%.
    expect(body.effFeePct).toBeGreaterThan(2.5);
    expect(body.effFeePct).toBeLessThan(50);
    expect(body.hops.at(-1)?.feeBps).toBe(Math.round(body.effFeePct * 100));
  });

  it('handles the sell side by inverting the hop symbols', async () => {
    const { body } = await quote('/tokens/VIABONK/quote?side=sell&amount=2');
    expect(body.side).toBe('sell');
    // Chronological sell: token → base on curve, then base → native.
    expect(body.hops[0]).toMatchObject({ inSymbol: 'VIABONK', outSymbol: 'BONK' });
    expect(body.hops[1]).toMatchObject({ inSymbol: 'BONK', outSymbol: 'SOL' });
    expect(body.routeLabel).toBe('CURVE → JUPITER');
  });

  it('labels itself indicative so nothing downstream treats it as executable', async () => {
    const { body } = await quote('/tokens/NATIVE/quote?side=buy&amount=1');
    expect(body.indicative).toBe(true);
    expect(body.nativeUsd).toBe(214.08);
  });

  it('rejects a non-positive or unparseable amount', async () => {
    for (const amount of ['0', '-1', 'abc', '']) {
      const res = await h.app.request(`/tokens/NATIVE/quote?side=buy&amount=${amount}`);
      expect(res.status).toBe(400);
      expect((await res.json()) as { error: string }).toMatchObject({ error: 'bad_request' });
    }
  });

  it('404s an unknown token', async () => {
    const res = await h.app.request('/tokens/NOPE/quote?side=buy&amount=1');
    expect(res.status).toBe(404);
  });
});

describe('quote cache', () => {
  it('expires exactly 8 seconds out, matching the UI drain bar', async () => {
    const { body, headers } = await quote('/tokens/NATIVE/quote?side=buy&amount=1');
    expect(body.expiresAt).toBe(T0 + QUOTE_CACHE_TTL_SECONDS * 1000);
    expect(headers.get('cache-control')).toBe(`public, max-age=${QUOTE_CACHE_TTL_SECONDS}`);
  });

  it('keys on net, side, native amount, base mint and reserves', async () => {
    for (const k of await h.redis.keys('quote:*')) await h.redis.del(k);
    await quote('/tokens/VIABONK/quote?side=buy&amount=1');
    const keys = await h.redis.keys('quote:SOL:VIABONK:buy:*');
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain(BONK_MINT);
    // reserve fingerprint is the last segment
    expect(keys[0]!.split(':').length).toBeGreaterThanOrEqual(7);

    expect(
      await h.redis.get(
        quoteCacheKey({
          net: 'SOL',
          side: 'sell',
          nativeAmount: 1,
          baseMint: BONK_MINT,
          sym: 'VIABONK',
          reserves: '0-0',
        }),
      ),
    ).toBeNull();
  });

  it('serves a hit without re-reading the oracle, and reports the original expiry', async () => {
    const first = await quote('/tokens/NATIVE/quote?side=buy&amount=1');

    // Move the clock inside the window and change the price underneath.
    h.advance(3_000);
    h.oracle.set('SOL', 999);
    const second = await quote('/tokens/NATIVE/quote?side=buy&amount=1');

    expect(second.body.nativeUsd).toBe(214.08);
    // The bar drains against the entry's expiry, so a hit is honest about age.
    expect(second.body.expiresAt).toBe(first.body.expiresAt);

    h.oracle.set('SOL', 214.08);
  });

  it('re-quotes once the entry expires', async () => {
    const first = await quote('/tokens/NATIVE/quote?side=buy&amount=1');
    h.advance(QUOTE_CACHE_TTL_SECONDS * 1000);
    h.oracle.set('SOL', 300);

    const second = await quote('/tokens/NATIVE/quote?side=buy&amount=1');
    expect(second.body.nativeUsd).toBe(300);
    expect(second.body.expiresAt).toBeGreaterThan(first.body.expiresAt);

    h.oracle.set('SOL', 214.08);
  });

  it('keeps the two chains on separate entries for the same ticker and size', async () => {
    await quote('/tokens/NATIVE/quote?side=buy&amount=1');
    const rhKey = quoteCacheKey({
      net: 'RH',
      side: 'buy',
      nativeAmount: 1,
      baseMint: SOL_MINT,
      sym: 'NATIVE',
      reserves: '0-0',
    });
    expect(await h.redis.get(rhKey)).toBeNull();
  });

  it('degrades to a null USD price instead of failing when the oracle is down', async () => {
    const broken = await createTestApp();
    try {
      await broken.deps.db.insert(tokens).values({
        net: 'SOL',
        sym: 'NATIVE',
        name: 'Native Based',
        creator: 'Dev',
        mint: MINT_NATIVE,
        baseSymbol: 'SOL',
        baseMint: SOL_MINT,
        supply: 1_000_000_000,
        feeBps: 250,
        mc: 20_000,
        lane: 'new',
        seed: 1,
        launchedAt: new Date(T0 - 600_000),
      });
      broken.oracle.nativeUsd = async () => {
        throw new Error('oracle unreachable');
      };

      const res = await broken.app.request('/tokens/NATIVE/quote?side=buy&amount=1');
      expect(res.status).toBe(200);
      const body = (await res.json()) as QuoteBody;
      // A quote with no USD reference is still a quote; the fee math is native.
      expect(body.nativeUsd).toBeNull();
      expect(body.effFeePct).toBe(2.5);
    } finally {
      await broken.close();
    }
  });
});
