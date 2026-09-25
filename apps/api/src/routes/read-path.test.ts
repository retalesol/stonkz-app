import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GRAD, MAJORS, RH_STOCKS, STOCKS, nativeUnit } from '@stonkz/shared';
import { candles, holdersSnapshot, koth, tape, tokens, trades } from '../db/schema.js';
import { createTestApp, type TestApp } from '../test/app.js';
import type { SerialisedToken } from './serialise.js';

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
const minutesAgo = (n: number) => new Date(T0 - n * 60_000);
const MINT_DOGE2 = 'mint-DOGE2';
const MINT_MOONER = 'mint-MOONER';
const MINT_GRADD = 'mint-GRADD';
const MINT_RHDOG = '0x00000000000000000000000000000000000000b2';
const MINT_BASEDOG = '0x00000000000000000000000000000000000000c3';

/**
 * A small deterministic board. Ingestion is covered by the indexer's fixture
 * replay; what these tests own is the HTTP layer — filtering, sorting,
 * pagination and the wire shape the terminal renders.
 */
async function seed(): Promise<void> {
  await h.deps.db.insert(tokens).values([
    {
      net: 'SOL',
      sym: 'DOGE2',
      name: 'Doge Two',
      descr: 'much wow',
      creator: 'DevOne',
      mint: MINT_DOGE2,
      baseSymbol: 'SOL',
      baseMint: 'So11111111111111111111111111111111111111112',
      supply: 1_000_000_000,
      feeBps: 250,
      mc: 12_000,
      chg: 4.5,
      replies: 12,
      holders: 30,
      lane: 'new',
      seed: 101,
      launchedAt: minutesAgo(10),
    },
    {
      net: 'SOL',
      sym: 'MOONER',
      name: 'Mooner',
      creator: 'DevTwo',
      mint: MINT_MOONER,
      baseSymbol: 'BONK',
      baseMint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
      supply: 1_000_000_000,
      feeBps: 250,
      mc: 45_000,
      chg: 120.25,
      replies: 3,
      holders: 88,
      lane: 'soon',
      seed: 102,
      launchedAt: minutesAgo(60),
    },
    {
      net: 'SOL',
      sym: 'GRADD',
      name: 'Graduated One',
      creator: 'DevThree',
      mint: MINT_GRADD,
      baseSymbol: 'SOL',
      baseMint: 'So11111111111111111111111111111111111111112',
      supply: 1_000_000_000,
      feeBps: 250,
      mc: GRAD + 5_000,
      chg: -8,
      replies: 40,
      holders: 400,
      lane: 'grad',
      seed: 103,
      launchedAt: minutesAgo(600),
      graduatedAt: minutesAgo(30),
    },
    {
      net: 'RH',
      sym: 'RHDOG',
      name: 'Robinhood Dog',
      creator: 'DevRh',
      mint: MINT_RHDOG,
      baseSymbol: 'ETH',
      baseMint: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
      supply: 1_000_000_000,
      feeBps: 200,
      mc: 22_000,
      chg: 15,
      replies: 1,
      holders: 9,
      lane: 'new',
      seed: 201,
      launchedAt: minutesAgo(5),
    },
    {
      net: 'BASE',
      sym: 'BASEDOG',
      name: 'Base Dog',
      creator: 'DevBase',
      mint: MINT_BASEDOG,
      baseSymbol: 'WETH',
      baseMint: '0x4200000000000000000000000000000000000006',
      supply: 1_000_000_000,
      feeBps: 200,
      mc: 18_000,
      chg: 8,
      replies: 0,
      holders: 4,
      lane: 'new',
      seed: 301,
      launchedAt: minutesAgo(8),
    },
  ]);

  await h.deps.db.insert(trades).values(
    [3, 2, 1].map((i) => ({
      net: 'SOL' as const,
      sym: 'DOGE2',
      mint: MINT_DOGE2,
      txSig: `sig-${i}`,
      logIndex: 0,
      side: i === 2 ? ('sell' as const) : ('buy' as const),
      trader: `Trader${i}`,
      nativeAmount: i * 0.5,
      baseAmount: i * 0.5,
      tokenAmount: i * 1000,
      usdValue: i * 100,
      mc: 12_000 + i,
      price: 0.000012,
      blockTime: minutesAgo(i),
      chainPosition: 250_000_000 + i,
    })),
  );

  await h.deps.db.insert(candles).values(
    [1, 2, 3].map((i) => ({
      net: 'SOL' as const,
      sym: 'DOGE2',
      mint: MINT_DOGE2,
      tf: '1m',
      bucketStart: minutesAgo(i),
      o: 1 + i,
      h: 2 + i,
      l: 0.5,
      c: 1.5 + i,
      v: 100 * i,
      nativeVolume: i,
      trades: i,
    })),
  );

  await h.deps.db.insert(holdersSnapshot).values([
    {
      net: 'SOL',
      sym: 'DOGE2',
      mint: MINT_DOGE2,
      wallet: 'Whale',
      tokenAmount: 500_000_000,
      costNative: 5,
    },
    {
      net: 'SOL',
      sym: 'DOGE2',
      mint: MINT_DOGE2,
      wallet: 'Shrimp',
      tokenAmount: 1_000,
      costNative: 0.01,
    },
    // Sold out, kept for cost basis. Must never appear in the list.
    { net: 'SOL', sym: 'DOGE2', mint: MINT_DOGE2, wallet: 'Exited', tokenAmount: 0, costNative: 2 },
  ]);

  await h.deps.db.insert(koth).values([
    { net: 'SOL', sym: 'MOONER', mc: 45_000, crownedAt: new Date(T0 - 2_000) },
    { net: 'RH', sym: 'RHDOG', mc: 22_000, crownedAt: new Date(T0 - 90_000) },
  ]);

  await h.deps.db.insert(tape).values(
    [1, 2, 3, 4].map((i) => ({
      net: i % 2 === 0 ? ('RH' as const) : ('SOL' as const),
      sym: i % 2 === 0 ? 'RHDOG' : 'DOGE2',
      side: 'buy' as const,
      trader: `Tape${i}`,
      nativeAmount: 0.25,
      tokenAmount: 500,
      usdValue: 50,
      mc: 10_000 + i,
      txSig: `tape-${i}`,
      logIndex: 0,
      blockTime: minutesAgo(i),
    })),
  );
}

async function get<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await h.app.request(path);
  return { status: res.status, body: (await res.json()) as T };
}

interface BoardResponse {
  net: string;
  sort: string;
  count: number;
  lanes: { new: number; soon: number; grad: number };
  tokens: SerialisedToken[];
}

/** Review gate 1.C — the server-side read path. */
describe('GET /tokens', () => {
  it('defaults to Solana and returns the board with lane counts', async () => {
    const { status, body } = await get<BoardResponse>('/tokens');
    expect(status).toBe(200);
    expect(body.net).toBe('SOL');
    expect(body.tokens.map((t) => t.sym)).toEqual(['DOGE2', 'MOONER', 'GRADD']);
    expect(body.lanes).toEqual({ new: 1, soon: 1, grad: 1 });
    // The RH token is not on the Solana board.
    expect(body.tokens.map((t) => t.sym)).not.toContain('RHDOG');
  });

  it('filters by net and reports lane counts for that net only', async () => {
    const { body } = await get<BoardResponse>('/tokens?net=RH');
    expect(body.tokens.map((t) => t.sym)).toEqual(['RHDOG']);
    expect(body.lanes).toEqual({ new: 1, soon: 0, grad: 0 });
  });

  it('returns both chains for net=ALL', async () => {
    const { body } = await get<BoardResponse>('/tokens?net=ALL');
    expect(body.net).toBe('ALL');
    expect(body.count).toBe(5);
    expect(new Set(body.tokens.map((t) => t.net))).toEqual(new Set(['SOL', 'RH', 'BASE']));
  });

  it('filters by lane', async () => {
    const { body } = await get<BoardResponse>('/tokens?lane=grad');
    expect(body.tokens.map((t) => t.sym)).toEqual(['GRADD']);
  });

  it('sorts by market cap, change, replies and recency', async () => {
    const byMc = await get<BoardResponse>('/tokens?sort=mc');
    expect(byMc.body.tokens.map((t) => t.sym)).toEqual(['GRADD', 'MOONER', 'DOGE2']);

    const byChg = await get<BoardResponse>('/tokens?sort=chg');
    expect(byChg.body.tokens.map((t) => t.sym)).toEqual(['MOONER', 'DOGE2', 'GRADD']);

    const byReplies = await get<BoardResponse>('/tokens?sort=rep');
    expect(byReplies.body.tokens.map((t) => t.sym)).toEqual(['GRADD', 'DOGE2', 'MOONER']);

    // NEWEST is the default, and it is age-ordered rather than cap-ordered.
    const byNew = await get<BoardResponse>('/tokens?sort=new');
    expect(byNew.body.tokens.map((t) => t.sym)).toEqual(['DOGE2', 'MOONER', 'GRADD']);
    expect(byNew.body.sort).toBe('new');
  });

  it('falls back to NEWEST for an unknown sort rather than erroring', async () => {
    const { body } = await get<BoardResponse>('/tokens?sort=vibes');
    expect(body.sort).toBe('new');
  });

  it('searches ticker by prefix and name by substring', async () => {
    expect((await get<BoardResponse>('/tokens?q=MOON')).body.tokens.map((t) => t.sym)).toEqual([
      'MOONER',
    ]);
    // Case-insensitive, and matches inside the name.
    expect((await get<BoardResponse>('/tokens?q=two')).body.tokens.map((t) => t.sym)).toEqual([
      'DOGE2',
    ]);
    expect((await get<BoardResponse>('/tokens?q=nothinghere')).body.tokens).toEqual([]);
  });

  it('clamps the limit and ignores nonsense values', async () => {
    expect((await get<BoardResponse>('/tokens?limit=2')).body.tokens).toHaveLength(2);
    expect((await get<BoardResponse>('/tokens?limit=0')).body.tokens).toHaveLength(3);
    expect((await get<BoardResponse>('/tokens?limit=-5')).body.tokens).toHaveLength(3);
    expect((await get<BoardResponse>('/tokens?limit=abc')).body.tokens).toHaveLength(3);
  });

  it('serves the Coin shape the board already renders, with derived fields', async () => {
    const { body } = await get<BoardResponse>('/tokens?q=DOGE2');
    const coin = body.tokens[0] as SerialisedToken;
    // Everything `card()` and `paint()` read.
    expect(coin).toMatchObject({
      sym: 'DOGE2',
      name: 'Doge Two',
      desc: 'much wow',
      mc: 12_000,
      chg: 4.5,
      reps: 12,
      hold: 30,
      dev: 'DevOne',
      lane: 'new',
      base: 'SOL',
      net: 'SOL',
      seed: 101,
      tfee: 2.5,
    });
    // Age is derived server-side from the frozen clock, not sent by the client.
    expect(coin.age).toBe(10);
    expect(coin.curvePct).toBeGreaterThan(0);
    expect(coin.priceUsd).toBeGreaterThan(0);
    expect(coin.graduatedAt).toBeNull();
  });

  it('marks a graduated token and stops charging the curve fee', async () => {
    const { body } = await get<SerialisedToken>('/tokens/GRADD');
    expect(body.graduatedAt).not.toBeNull();
    expect(body.lane).toBe('grad');
    expect(body.curvePct).toBe(100);
  });
});

describe('GET /tokens/:sym', () => {
  it('is case-insensitive on the ticker', async () => {
    const { status, body } = await get<SerialisedToken>('/tokens/doge2');
    expect(status).toBe(200);
    expect(body.sym).toBe('DOGE2');
  });

  it('404s a ticker that exists on the other chain only', async () => {
    // RHDOG is real, but not on Solana, and the default net is Solana.
    expect((await get('/tokens/RHDOG')).status).toBe(404);
    expect((await get('/tokens/RHDOG?net=RH')).status).toBe(200);
  });

  it('404s an unknown ticker', async () => {
    expect((await get('/tokens/NOPE')).status).toBe(404);
  });
});

describe('GET /tokens/:sym/candles', () => {
  it('returns OHLCV oldest-first for the chart to walk left to right', async () => {
    const { status, body } = await get<{
      tf: string;
      candles: { t: number; o: number; h: number; l: number; c: number; v: number }[];
    }>('/tokens/DOGE2/candles?tf=1m');
    expect(status).toBe(200);
    expect(body.tf).toBe('1m');
    expect(body.candles).toHaveLength(3);
    const times = body.candles.map((c) => c.t);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(body.candles[0]).toMatchObject({ o: 4, h: 5, l: 0.5, c: 4.5, v: 300 });
  });

  it('defaults to 1m and rejects an unsupported timeframe', async () => {
    expect((await get<{ tf: string }>('/tokens/DOGE2/candles')).body.tf).toBe('1m');
    for (const tf of ['5m', '15m', '1h', '4h', '1d']) {
      expect((await get(`/tokens/DOGE2/candles?tf=${tf}`)).status).toBe(200);
    }
    const bad = await get<{ error: string }>('/tokens/DOGE2/candles?tf=3s');
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('bad_timeframe');
  });

  it('returns an empty series rather than 404 for a token with no candles', async () => {
    const { status, body } = await get<{ candles: unknown[] }>('/tokens/MOONER/candles');
    expect(status).toBe(200);
    expect(body.candles).toEqual([]);
  });
});

describe('GET /tokens/:sym/trades', () => {
  it('returns newest fills first in the shape pushTrade renders', async () => {
    const { status, body } = await get<{
      nativeUnit: string;
      trades: { sig: string; buy: boolean; sol: number; tok: number; w: string }[];
    }>('/tokens/DOGE2/trades');
    expect(status).toBe(200);
    expect(body.nativeUnit).toBe('SOL');
    // Insert order was 3, 2, 1; newest-first means descending id.
    expect(body.trades.map((t) => t.sig)).toEqual(['sig-1', 'sig-2', 'sig-3']);
    expect(body.trades[1]?.buy).toBe(false);
    expect(body.trades[0]).toMatchObject({ w: 'Trader1', sol: 0.5, tok: 1000 });
  });

  it('reports ETH as the native unit on Robinhood', async () => {
    const { body } = await get<{ nativeUnit: string }>('/tokens/RHDOG/trades?net=RH');
    expect(body.nativeUnit).toBe(nativeUnit('RH'));
    expect(body.nativeUnit).toBe('ETH');
  });

  it('clamps the limit', async () => {
    expect(
      (await get<{ trades: unknown[] }>('/tokens/DOGE2/trades?limit=2')).body.trades,
    ).toHaveLength(2);
  });
});

describe('GET /tokens/:sym/holders', () => {
  it('ranks live holders by size with a supply percentage', async () => {
    const { status, body } = await get<{
      holders: { wallet: string; amount: number; pct: number; costNative: number }[];
    }>('/tokens/DOGE2/holders');
    expect(status).toBe(200);
    expect(body.holders.map((holder) => holder.wallet)).toEqual(['Whale', 'Shrimp']);
    expect(body.holders[0]?.pct).toBeCloseTo(50, 6);
    expect(body.holders[0]?.costNative).toBe(5);
  });

  it('omits wallets that sold out, which are kept only for cost basis', async () => {
    const { body } = await get<{ holders: { wallet: string }[] }>('/tokens/DOGE2/holders');
    expect(body.holders.map((holder) => holder.wallet)).not.toContain('Exited');
  });
});

describe('GET /koth', () => {
  it('returns the reigning king with the crown freshness the glow uses', async () => {
    const { status, body } = await get<{
      kings: {
        net: string;
        sym: string;
        mc: number;
        freshMs: number;
        token: SerialisedToken | null;
      }[];
    }>('/koth');
    expect(status).toBe(200);
    expect(body.kings).toHaveLength(1);
    const king = body.kings[0];
    expect(king).toMatchObject({ net: 'SOL', sym: 'MOONER', mc: 45_000 });
    // Under 5s, so the card is still mid-crowning animation.
    expect(king?.freshMs).toBe(2_000);
    expect(king?.token?.sym).toBe('MOONER');
  });

  it('returns both crowns for net=ALL', async () => {
    const { body } = await get<{ kings: { net: string }[] }>('/koth?net=ALL');
    expect(body.kings.map((k) => k.net).sort()).toEqual(['RH', 'SOL']);
  });
});

describe('GET /tape', () => {
  it('returns the newest fills first, net-filtered by default', async () => {
    const { status, body } = await get<{ net: string; fills: { sig: string; net: string }[] }>(
      '/tape',
    );
    expect(status).toBe(200);
    expect(body.net).toBe('SOL');
    expect(body.fills.every((f) => f.net === 'SOL')).toBe(true);
    expect(body.fills.map((f) => f.sig)).toEqual(['tape-3', 'tape-1']);
  });

  it('interleaves both chains for net=ALL, newest first', async () => {
    const { body } = await get<{ fills: { sig: string }[] }>('/tape?net=ALL');
    expect(body.fills.map((f) => f.sig)).toEqual(['tape-4', 'tape-3', 'tape-2', 'tape-1']);
  });

  it('clamps the limit', async () => {
    expect((await get<{ fills: unknown[] }>('/tape?net=ALL&limit=2')).body.fills).toHaveLength(2);
    expect((await get<{ fills: unknown[] }>('/tape?net=ALL&limit=999')).body.fills).toHaveLength(4);
  });
});

describe('GET /base-tokens', () => {
  it('returns majors plus tokenized stocks on Solana', async () => {
    const { status, body } = await get<{
      net: string;
      nativeUnit: string;
      source: string;
      stale: boolean;
      baseTokens: { symbol: string; kind: string }[];
    }>('/base-tokens?network=SOL');
    expect(status).toBe(200);
    expect(body.nativeUnit).toBe('SOL');
    expect(body.baseTokens).toHaveLength(MAJORS.SOL.length + STOCKS.length);
    expect(body.baseTokens.filter((t) => t.kind === 'stock')).toHaveLength(STOCKS.length);
    // Honest about provenance: this is a snapshot, not a live cron.
    expect(body.source).toBe('snapshot:2026-09-06');
    expect(body.stale).toBe(true);
  });

  it('returns majors plus the Robinhood stock/ETF bases on Robinhood', async () => {
    // 284ae9a added RH_STOCKS (canonical RH tickers, testnet pins in base-mints.ts).
    const { body } = await get<{
      nativeUnit: string;
      baseTokens: { symbol: string; kind: string }[];
    }>('/base-tokens?network=RH');
    expect(body.nativeUnit).toBe('ETH');
    expect(body.baseTokens).toHaveLength(MAJORS.RH.length + RH_STOCKS.length);
    expect(body.baseTokens.filter((t) => t.kind === 'stock').map((t) => t.symbol)).toEqual(
      RH_STOCKS.map(([symbol]) => symbol),
    );
  });

  it('returns majors only on Base, which has no stock bases', async () => {
    const { body } = await get<{ nativeUnit: string; baseTokens: { kind: string }[] }>(
      '/base-tokens?network=BASE',
    );
    expect(body.nativeUnit).toBe('ETH');
    expect(body.baseTokens).toHaveLength(MAJORS.BASE.length);
    expect(body.baseTokens.some((t) => t.kind === 'stock')).toBe(false);
  });

  it('accepts net= as well as network=, and defaults to Solana', async () => {
    expect((await get<{ net: string }>('/base-tokens?net=RH')).body.net).toBe('RH');
    expect((await get<{ net: string }>('/base-tokens')).body.net).toBe('SOL');
  });
});

describe('GET /treasuries', () => {
  it('exposes both vaults per net as read-only', async () => {
    const { status, body } = await get<{
      claimable: boolean;
      note: string;
      vaults: { net: string; kind: string; nativeUnit: string }[];
    }>('/treasuries');
    expect(status).toBe(200);
    expect(body.claimable).toBe(false);
    // SOL + RH from 0001, BASE from 0014, ARC from 0015.
    expect(body.vaults).toHaveLength(8);
    expect(body.vaults.filter((v) => v.kind === 'protocol')).toHaveLength(4);
    expect(body.vaults.filter((v) => v.kind === 'stonkz_ops')).toHaveLength(4);
    expect(body.vaults.find((v) => v.net === 'RH')?.nativeUnit).toBe('ETH');
    expect(body.vaults.find((v) => v.net === 'BASE')?.nativeUnit).toBe('ETH');
    // Arc's gas token is USDC, so its vaults are USDC-denominated.
    expect(body.vaults.find((v) => v.net === 'ARC')?.nativeUnit).toBe('USDC');
  });
});
