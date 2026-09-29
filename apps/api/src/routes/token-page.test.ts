import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GRAD } from '@stonkz/shared';
import { holdersSnapshot, stakePositions, tokens, trades } from '../db/schema.js';
import { createTestApp, type TestApp } from '../test/app.js';
import { curveFacts, shapeHolders } from './tokens.js';
import type { TokenRow } from './serialise.js';

/**
 * The token page's four reads, against MEMEMAN as it stood on Base Sepolia
 * on 2026-09-29: two 0.01 ETH buys by the creator and one FLEX stake of
 * 12,294 tokens. Every figure below was read back from the chain
 * (`Trade` event data, `balanceOf`, Blockscout) — the tests pin the API to
 * those numbers rather than to itself.
 */

const MINT = '0x847eb6311333f8F7F2cd0E9A89379214302aB2c9';
const LAUNCHPAD = '0x2f197741C3ca71e3FE885a4F74C0D44e3A774D35';
const CREATOR = '0x1FA9D4Ad76D53FbF1274d10ACBA12463ae90Bdca';
const SIG1 = '0x0df81a74760dffca76878fb466324dbc1cb13f70b0bb8f9a42f81ebbe8542ca0';
const SIG2 = '0xc9cb1630b6b535c54f37fe5319262950683da8b47cdd88e65e218b9e2301d328';
const T1 = 1_790_686_260_000;
const T2 = 1_790_687_804_000;
/** ~7 hours after the second fill, like the live page was checked. */
const NOW = 1_790_710_764_000;
const SUPPLY = 1_000_000;
/** Oracle snapshot at `create_token`, USD per ETH × 1e6 (from mc / mcBase). */
const BASE_PRICE_1E6 = '2736600000';

/* Trade event #2's post-fill state. `virtualBase0 = virtualBase - realBase`,
 * `virtualToken0 = virtualToken + (tokensForSale - realToken)`. */
const CURVE = {
  tokenDecimals: 18,
  baseDecimals: 18,
  basePriceUsd1e6: BASE_PRICE_1E6,
  curveTokensForSale: '800000000000000000000000',
  curveVirtualBase0: '1680916270148323884',
  curveVirtualToken0: '1066666666666666666666666',
  curveK: (1680916270148323884n * 1066666666666666666666666n).toString(),
  curveRealBase: '19600000000000000',
  curveRealToken: '787705694421351741896502',
  curveGradMcapBase: '25214207556530000000',
};

let h: TestApp;

beforeAll(async () => {
  h = await createTestApp({
    now: NOW,
    env: { BASE_LAUNCHPAD_ADDRESS: LAUNCHPAD, BASE_EXPLORER: 'https://sepolia.basescan.org' },
  });
});
afterAll(async () => {
  await h.close();
});
afterEach(() => {
  vi.unstubAllGlobals();
});
beforeEach(async () => {
  await h.db.reset();
  await h.clearRateLimits();
  h.setNow(NOW);
  await h.deps.db.insert(tokens).values({
    net: 'BASE',
    sym: 'MEMEMAN',
    name: 'The Mememan',
    descr: 'The Mememan',
    creator: CREATOR,
    mint: MINT,
    baseSymbol: 'WETH',
    baseMint: '0x4200000000000000000000000000000000000006',
    supply: SUPPLY,
    feeBps: 200,
    mc: 4413.656488,
    lastMc: 4413.656488,
    chg: 1.162631756914251,
    holders: 1,
    lane: 'new',
    seed: 1214463671,
    launchedAt: new Date(1_790_686_164_000),
    website: 'mememan.example',
    ...CURVE,
  });
  await h.deps.db.insert(trades).values([
    {
      net: 'BASE',
      sym: 'MEMEMAN',
      mint: MINT,
      txSig: SIG1,
      logIndex: 5,
      side: 'buy',
      trader: CREATOR,
      nativeAmount: 0.01,
      baseAmount: 0.01,
      tokenAmount: 6182.783899285643,
      usdValue: 27.366026,
      mc: 4362.931659,
      price: 0.004426165695870733,
      blockTime: new Date(T1),
      chainPosition: 47_458_986,
    },
    {
      net: 'BASE',
      sym: 'MEMEMAN',
      mint: MINT,
      txSig: SIG2,
      logIndex: 5,
      side: 'buy',
      trader: CREATOR,
      nativeAmount: 0.01,
      baseAmount: 0.01,
      tokenAmount: 6111.521679362614,
      usdValue: 27.366026,
      mc: 4413.656488,
      price: 0.004477776147372527,
      blockTime: new Date(T2),
      chainPosition: 47_459_758,
    },
  ]);
  // The indexer's running balance (buys minus sells) and the FLEX stake.
  await h.deps.db.insert(holdersSnapshot).values({
    net: 'BASE',
    sym: 'MEMEMAN',
    mint: MINT,
    wallet: CREATOR,
    tokenAmount: 12294.305578648258,
    costNative: 0.02,
  });
  await h.deps.db.insert(stakePositions).values({
    net: 'BASE',
    sym: 'MEMEMAN',
    mint: MINT,
    wallet: CREATOR,
    amount: 12294,
    lockDays: 0,
    mult: 1,
    untilMs: 0,
  });
});

async function get<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await h.app.request(path);
  return { status: res.status, body: (await res.json()) as T };
}

const Q = `?net=BASE&mint=${MINT}`;

describe('curveFacts', () => {
  it('reads the chain state back in whole units', () => {
    const facts = curveFacts({ supply: SUPPLY, ...CURVE } as unknown as TokenRow);
    expect(facts).not.toBeNull();
    // virtualBase / virtualToken × supply = 1.7005 / 1,054,372 × 1e6 ETH.
    expect(facts!.mcBase).toBeCloseTo(1.612823, 5);
    expect(facts!.realBase).toBe(0.0196);
    expect(facts!.realToken).toBeCloseTo(787_705.6944, 3);
    expect(facts!.circulating).toBeCloseTo(12_294.3056, 3);
    expect(facts!.lpReserve).toBe(200_000);
    expect(facts!.baseUsd).toBe(2736.6);
    expect(facts!.gradBase).toBeCloseTo(25.2142, 3);
    // (mcBase - startBase) / (gradBase - startBase): the API's 0.156%.
    expect(facts!.fillPct).toBeCloseTo(0.1564, 3);
  });

  it('is null for a fixture row without curve state', () => {
    expect(curveFacts({ supply: SUPPLY, ...CURVE, curveK: '0' } as unknown as TokenRow)).toBeNull();
  });
});

describe('GET /tokens/:sym (detail extras)', () => {
  it('reports real 24h / lifetime volume, native cap and real liquidity beside the Coin shape', async () => {
    const { status, body } = await get<Record<string, number | string>>('/tokens/MEMEMAN' + Q);
    expect(status).toBe(200);
    expect(body['mc']).toBeCloseTo(4413.656488, 6);
    expect(body['nativeUnit']).toBe('ETH');
    expect(body['vol24Usd']).toBeCloseTo(54.732052, 6);
    expect(body['vol24Native']).toBeCloseTo(0.02, 9);
    expect(body['trades24h']).toBe(2);
    expect(body['volTotalUsd']).toBeCloseTo(54.732052, 6);
    expect(body['tradeCount']).toBe(2);
    expect(body['mcBase']).toBeCloseTo(1.612823, 5);
    // Liquidity is the ETH the curve really holds, not 14% of the cap.
    expect(body['liqBase']).toBe(0.0196);
    expect(body['liqUsd']).toBeCloseTo(0.0196 * 2736.6, 6);
    expect(body['circulating']).toBeCloseTo(12_294.3056, 3);
    expect(body['lpReserve']).toBe(200_000);
    expect(body['graduationUsd']).toBe(GRAD);
    expect(body['graduationBase']).toBeCloseTo(25.2142, 3);
    expect(body['web']).toBe('mememan.example');
  });

  it('drops a fill out of the 24h window while keeping it in the lifetime totals', async () => {
    h.setNow(T2 + 25 * 3_600_000);
    const { body } = await get<Record<string, number>>('/tokens/MEMEMAN' + Q);
    expect(body['vol24Usd']).toBe(0);
    expect(body['trades24h']).toBe(0);
    expect(body['tradeCount']).toBe(2);
  });
});

describe('GET /tokens/:sym/candles', () => {
  type Candle = {
    t: number;
    o: number;
    h: number;
    l: number;
    c: number;
    v: number;
    trades: number;
  };

  it('builds spot-priced candles from the fills, bucketed like the indexer', async () => {
    const { body } = await get<{ basis: string; bucketMs: number; candles: Candle[] }>(
      '/tokens/MEMEMAN/candles' + Q + '&tf=1m',
    );
    expect(body.basis).toBe('spot');
    expect(body.bucketMs).toBe(60_000);
    expect(body.candles.map((k) => k.t)).toEqual([T1, 1_790_687_760_000]);
    const [a, b] = body.candles as [Candle, Candle];
    // Close is the header's price: cap / supply.
    expect(a.c).toBeCloseTo(4362.931659 / SUPPLY, 15);
    expect(b.c).toBeCloseTo(4413.656488 / SUPPLY, 15);
    // The second candle opens at the first's close and holds it as its low.
    expect(b.o).toBe(a.c);
    expect(b.l).toBe(a.c);
    expect(b.h).toBe(b.c);
    expect(a.v).toBeCloseTo(27.366026, 6);
    expect(a.trades).toBe(1);
  });

  it('serves every timeframe with the indexer bucket starts', async () => {
    const five = await get<{ candles: Candle[] }>('/tokens/MEMEMAN/candles' + Q + '&tf=5m');
    expect(five.body.candles.map((k) => k.t)).toEqual([1_790_686_200_000, 1_790_687_700_000]);
    const day = await get<{ candles: Candle[] }>('/tokens/MEMEMAN/candles' + Q + '&tf=1d');
    expect(day.body.candles).toHaveLength(1);
    expect(day.body.candles[0]).toMatchObject({ trades: 2 });
    expect(day.body.candles[0]?.v).toBeCloseTo(54.732052, 6);
    expect(day.body.candles[0]?.o).toBeCloseTo(4362.931659 / SUPPLY, 15);
    expect(day.body.candles[0]?.c).toBeCloseTo(4413.656488 / SUPPLY, 15);
  });
});

describe('GET /tokens/:sym/trades', () => {
  type Row = { id: number; sig: string; t: number; mc: number; v: number };

  it('pages older fills with a `before` cursor and says when more exist', async () => {
    const first = await get<{ hasMore: boolean; nextBefore?: number; trades: Row[] }>(
      '/tokens/MEMEMAN/trades' + Q + '&limit=1',
    );
    expect(first.body.trades.map((t) => t.sig)).toEqual([SIG2]);
    expect(first.body.hasMore).toBe(true);
    expect(first.body.nextBefore).toBe(first.body.trades[0]?.id);
    const older = await get<{ hasMore: boolean; trades: Row[] }>(
      `/tokens/MEMEMAN/trades${Q}&limit=1&before=${first.body.nextBefore}`,
    );
    expect(older.body.trades.map((t) => t.sig)).toEqual([SIG1]);
    expect(older.body.hasMore).toBe(false);
    expect(older.body.trades[0]).toMatchObject({ t: T1, mc: 4362.931659, v: 27.366026 });
  });
});

describe('GET /tokens/:sym/holders', () => {
  const LP_ATOMS = '999999694421351741896502';
  const CREATOR_ATOMS = '305578648258103498';
  type HolderRow = {
    wallet: string;
    amount: number;
    pct: number;
    staked?: number;
    kind: string;
    curve?: boolean;
    costNative: number;
  };
  type Body = {
    source: string;
    holderCount: number;
    curveWallet: string;
    stakedTotal: number;
    holders: HolderRow[];
  };

  function stubExplorer(): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        const u = String(url);
        // Basescan has no holders API; the route must ask Blockscout instead.
        expect(u).toContain('base-sepolia.blockscout.com');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: '1',
            result: [
              { address: LAUNCHPAD.toLowerCase(), value: LP_ATOMS },
              { address: CREATOR.toLowerCase(), value: CREATOR_ATOMS },
            ],
          }),
        } as unknown as Response;
      }),
    );
  }

  it('splits the launchpad balance into curve + LP reserve and hands stakes back to their wallets', async () => {
    stubExplorer();
    const { status, body } = await get<Body>('/tokens/MEMEMAN/holders' + Q);
    expect(status).toBe(200);
    expect(body.source).toBe('explorer');
    expect(body.curveWallet).toBe(LAUNCHPAD);
    expect(body.stakedTotal).toBe(12_294);
    // One wallet holder: the creator, whose 0.3 on-chain balance plus the
    // 12,294 staked in the launchpad is the 12,294.3 the trades add up to.
    expect(body.holderCount).toBe(1);
    const creator = body.holders.find((x) => x.wallet === CREATOR);
    expect(creator).toMatchObject({ kind: 'wallet', staked: 12_294, costNative: 0.02 });
    expect(creator!.amount).toBeCloseTo(12_294.3055786, 5);
    expect(creator!.pct).toBeCloseTo(1.2294, 4);
    const curve = body.holders.find((x) => x.kind === 'curve');
    expect(curve).toMatchObject({ wallet: LAUNCHPAD.toLowerCase(), curve: true });
    expect(curve!.amount).toBeCloseTo(787_705.6944, 3);
    const lp = body.holders.find((x) => x.kind === 'lp');
    expect(lp!.amount).toBeCloseTo(200_000, 3);
    // Every token is accounted for exactly once.
    expect(body.holders.reduce((n, x) => n + x.pct, 0)).toBeCloseTo(100, 6);
  });

  it("verifies the indexer's wallets over RPC when the explorer is down", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('offline'))),
    );
    const hex = (atoms: string): string => '0x' + BigInt(atoms).toString(16).padStart(64, '0');
    h.rpcs.BASE.setContract(MINT, (data: string) => {
      const owner = '0x' + data.slice(-40);
      if (owner === LAUNCHPAD.toLowerCase()) return hex(LP_ATOMS);
      if (owner === CREATOR.toLowerCase()) return hex(CREATOR_ATOMS);
      return hex('0');
    });
    const { body } = await get<Body>('/tokens/MEMEMAN/holders' + Q);
    expect(body.source).toBe('rpc');
    expect(body.holderCount).toBe(1);
    expect(body.holders.find((x) => x.wallet === CREATOR)?.amount).toBeCloseTo(12_294.3055786, 5);
    expect(body.holders.find((x) => x.kind === 'lp')?.amount).toBeCloseTo(200_000, 3);
  });

  it('falls back to the indexer snapshot (which already includes stakes) when the chain cannot answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('offline'))),
    );
    h.rpcs.BASE.setFailing(true);
    const { body } = await get<Body>('/tokens/MEMEMAN/holders' + Q).finally(() =>
      h.rpcs.BASE.setFailing(false),
    );
    expect(body.source).toBe('db');
    expect(body.holderCount).toBe(1);
    const creator = body.holders.find((x) => x.wallet === CREATOR);
    expect(creator!.amount).toBeCloseTo(12_294.3055786, 5);
    expect(creator!.staked).toBeUndefined();
  });

  it('keeps the tokens row holder count in step with the chain read', async () => {
    stubExplorer();
    await get<Body>('/tokens/MEMEMAN/holders' + Q);
    await new Promise((r) => setTimeout(r, 20));
    const { body } = await get<{ hold: number }>('/tokens/MEMEMAN' + Q);
    expect(body.hold).toBe(1);
  });
});

describe('shapeHolders', () => {
  it('never counts program accounts and reports a Solana escrow remainder the indexer has not attributed', () => {
    const out = shapeHolders({
      chain: [
        { wallet: 'Vault', amount: 700_000, curve: true, kind: 'curve' },
        { wallet: 'Escrow', amount: 1_000, curve: false, kind: 'stake' },
        { wallet: 'Lp', amount: 200_000, curve: false, kind: 'lp' },
        { wallet: 'A', amount: 99_000, curve: false, kind: 'wallet' },
      ],
      supply: 1_000_000,
      facts: null,
      staked: new Map([['A', 600]]),
      cost: new Map([['A', 1.5]]),
      evm: false,
      limit: 50,
    });
    expect(out.holderCount).toBe(1);
    expect(out.holders.map((x) => [x.kind, x.amount])).toEqual([
      ['curve', 700_000],
      ['lp', 200_000],
      ['wallet', 99_600],
      ['stake', 400],
    ]);
    expect(out.holders[2]).toMatchObject({ staked: 600, costNative: 1.5 });
  });
});
