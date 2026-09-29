import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { chatMessages, tape, tokens } from '../db/schema.js';
import { createTestApp, type TestApp } from '../test/app.js';
import { PRIVATE_ROOM_SUFFIX } from '../social/chat.js';
import type { SerialisedToken } from './serialise.js';
import { MINT_PREFIX_MIN, likeEscape } from './tokens.js';

/**
 * The Explore board's read path beyond the basics `read-path.test.ts` covers:
 * paging past the first page, lane counts that agree with the list, the
 * search the header placeholder promises, the derived reply count behind
 * MOST REPLIES, and the fill ids the ticker tape dedupes on.
 */

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
const MINT_A = '0x847EB6311333F8f7f2CD0e9a89379214302AB2C9';
const MINT_B = '0x00000000000000000000000000000000000000b2';
const MINT_C = '8sxJxn4z5FX4Pg4WUnrRSjwjBFsZ422kVoyHpDr5TBo7';
const MINT_D = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

function row(
  over: Partial<typeof tokens.$inferInsert> & Pick<typeof tokens.$inferInsert, 'sym' | 'mint'>,
): typeof tokens.$inferInsert {
  return {
    net: 'SOL',
    name: over.sym + ' coin',
    descr: '',
    creator: 'Dev',
    baseSymbol: 'SOL',
    baseMint: 'So11111111111111111111111111111111111111112',
    supply: 1e9,
    feeBps: 100,
    mc: 5_000,
    chg: 0,
    replies: 0,
    holders: 1,
    lane: 'new',
    seed: 1,
    launchedAt: minutesAgo(10),
    ...over,
  };
}

async function seed(): Promise<void> {
  await h.deps.db.insert(tokens).values([
    // Same cap as CULT so the tiebreak is exercised; newest of the pair.
    row({ net: 'BASE', sym: 'MEMEMAN', name: 'The Mememan', mint: MINT_A, mc: 4_400, seed: 1 }),
    row({ net: 'RH', sym: 'RHDOG', name: 'Robin Dog', mint: MINT_B, mc: 9_000, seed: 2 }),
    row({
      sym: 'DEVCOIN',
      name: 'Devnet smoke',
      mint: MINT_C,
      mc: 4_400,
      seed: 3,
      launchedAt: minutesAgo(50),
    }),
    row({
      sym: 'CULT',
      name: 'Cult 100% Capital',
      mint: MINT_D,
      mc: 60_000,
      lane: 'soon',
      seed: 4,
      launchedAt: minutesAgo(200),
    }),
    // Fixture placeholders the live board must never list *or count*.
    row({ sym: 'GHOST', mint: '', seed: 5 }),
    row({ sym: 'LEGACY', mint: 'legacy:1', lane: 'grad', seed: 6 }),
  ]);

  await h.deps.db.insert(chatMessages).values([
    { net: 'SOL', room: 'CULT', wallet: 'a', text: 'gm' },
    { net: 'SOL', room: 'CULT', wallet: 'b', text: 'wen' },
    { net: 'SOL', room: 'CULT' + PRIVATE_ROOM_SUFFIX, wallet: 'c', text: 'holders only' },
    // Flagged lines and the other chain's room with the same ticker do not count.
    { net: 'SOL', room: 'CULT', wallet: 'd', text: 'spam', flagged: true },
    { net: 'RH', room: 'CULT', wallet: 'e', text: 'other chain' },
    { net: 'SOL', room: 'DEVCOIN', wallet: 'f', text: 'one' },
  ]);

  // One multi-fill transaction (two log indices) and two singles.
  await h.deps.db.insert(tape).values([
    {
      net: 'BASE',
      sym: 'MEMEMAN',
      side: 'buy',
      trader: 'T1',
      nativeAmount: 0.01,
      tokenAmount: 6_000,
      usdValue: 27,
      mc: 4_400,
      txSig: '0xaaa',
      logIndex: 7,
      blockTime: minutesAgo(1),
    },
    {
      net: 'BASE',
      sym: 'MEMEMAN',
      side: 'buy',
      trader: 'T1',
      nativeAmount: 0.02,
      tokenAmount: 12_000,
      usdValue: 54,
      mc: 4_450,
      txSig: '0xaaa',
      logIndex: 9,
      blockTime: minutesAgo(1),
    },
    {
      net: 'SOL',
      sym: 'DEVCOIN',
      side: 'sell',
      trader: 'T2',
      nativeAmount: 0.0048,
      tokenAmount: 167_000,
      usdValue: 0.72,
      mc: 4_348,
      txSig: 'sigB',
      logIndex: 0,
      blockTime: minutesAgo(2),
    },
    // A fill on a fixture token never reaches the strip.
    {
      net: 'SOL',
      sym: 'GHOST',
      side: 'buy',
      trader: 'T3',
      nativeAmount: 1,
      tokenAmount: 1,
      usdValue: 1,
      mc: 1,
      txSig: 'sigGhost',
      logIndex: 0,
      blockTime: minutesAgo(0),
    },
  ]);
}

interface BoardResponse {
  net: string;
  sort: string;
  count: number;
  offset: number;
  total: number;
  hasMore: boolean;
  lanes: { new: number; soon: number; grad: number };
  tokens: SerialisedToken[];
}

async function get<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await h.app.request(path);
  return { status: res.status, body: (await res.json()) as T };
}

const syms = (b: BoardResponse) => b.tokens.map((t) => t.sym);

describe('GET /tokens paging', () => {
  it('reports the total across pages and whether another page exists', async () => {
    const p1 = (await get<BoardResponse>('/tokens?net=ALL&limit=2')).body;
    expect(p1.total).toBe(4);
    expect(p1.count).toBe(2);
    expect(p1.offset).toBe(0);
    expect(p1.hasMore).toBe(true);
    expect(syms(p1)).toEqual(['MEMEMAN', 'RHDOG']);

    const p2 = (await get<BoardResponse>('/tokens?net=ALL&limit=2&offset=2')).body;
    expect(syms(p2)).toEqual(['DEVCOIN', 'CULT']);
    expect(p2.hasMore).toBe(false);

    const past = (await get<BoardResponse>('/tokens?net=ALL&limit=2&offset=99')).body;
    expect(past.tokens).toEqual([]);
    expect(past.hasMore).toBe(false);
  });

  it('ignores a nonsense or negative offset', async () => {
    expect((await get<BoardResponse>('/tokens?net=ALL&offset=-3')).body.offset).toBe(0);
    expect((await get<BoardResponse>('/tokens?net=ALL&offset=abc')).body.offset).toBe(0);
  });

  it('breaks market-cap ties on recency so pages never overlap', async () => {
    const byMc = (await get<BoardResponse>('/tokens?net=ALL&sort=mc')).body;
    // MEMEMAN and DEVCOIN share $4.4K; the newer launch lists first.
    expect(syms(byMc)).toEqual(['CULT', 'RHDOG', 'MEMEMAN', 'DEVCOIN']);
    const one = (await get<BoardResponse>('/tokens?net=ALL&sort=mc&limit=3')).body;
    const rest = (await get<BoardResponse>('/tokens?net=ALL&sort=mc&limit=3&offset=3')).body;
    expect([...syms(one), ...syms(rest)]).toEqual(syms(byMc));
  });

  it('counts lanes over the same live rows the list shows', async () => {
    const all = (await get<BoardResponse>('/tokens?net=ALL')).body;
    // GHOST (empty mint) and LEGACY (`legacy:` id, lane grad) are excluded from both.
    expect(all.lanes).toEqual({ new: 3, soon: 1, grad: 0 });
    expect(syms(all)).not.toContain('GHOST');
    expect(syms(all)).not.toContain('LEGACY');
    const sol = (await get<BoardResponse>('/tokens?net=SOL')).body;
    expect(sol.lanes).toEqual({ new: 1, soon: 1, grad: 0 });
    expect(sol.total).toBe(2);
  });

  it('combines net, lane, sort and search', async () => {
    const b = (await get<BoardResponse>('/tokens?net=SOL&lane=new&sort=mc&q=dev')).body;
    expect(syms(b)).toEqual(['DEVCOIN']);
    expect(b.total).toBe(1);
  });
});

describe('GET /tokens sort=mc with live base prices', () => {
  /**
   * Three coins on three chains with three bases, each with a base cap and a
   * launch snapshot chosen so the snapshot-USD order (RHDOG > DEVCOIN >
   * MEMEMAN) differs from the live-USD order. `FakePriceOracle`: SOL $214.08,
   * ETH $4,200; USDC is $1 by definition.
   */
  async function priceRows(): Promise<void> {
    const set = async (
      net: string,
      mint: string,
      patch: Partial<typeof tokens.$inferInsert>,
    ): Promise<void> => {
      await h.deps.db
        .update(tokens)
        .set(patch)
        .where(and(eq(tokens.net, net), eq(tokens.mint, mint)));
    };
    // 1 ETH: $2,736.6 at launch, $4,200 live.
    await set('BASE', MINT_A, {
      baseSymbol: 'WETH',
      basePriceUsd1e6: '2736600000',
      mcBase: 1,
      mc: 2736.6,
    });
    // 20 SOL: $150 at launch ($3,000), $214.08 live ($4,281.6).
    await set('SOL', MINT_C, {
      baseSymbol: 'SOL',
      basePriceUsd1e6: '150000000',
      mcBase: 20,
      mc: 3000,
    });
    // 3,500 USDC: $3,500 either way.
    await set('RH', MINT_B, {
      baseSymbol: 'USDC',
      basePriceUsd1e6: '1000000',
      mcBase: 3500,
      mc: 3500,
    });
  }

  it('ranks mixed nets and bases by the live USD cap and pages that order', async () => {
    await priceRows();
    const byMc = (await get<BoardResponse>('/tokens?net=ALL&sort=mc')).body;
    expect(syms(byMc)).toEqual(['CULT', 'DEVCOIN', 'MEMEMAN', 'RHDOG']);
    const of = (sym: string) => byMc.tokens.find((t) => t.sym === sym) as SerialisedToken;
    expect(of('MEMEMAN').mc).toBeCloseTo(4200, 9);
    expect(of('MEMEMAN').baseUsd).toBe(4200);
    expect(of('MEMEMAN').mcBase).toBe(1);
    expect(of('DEVCOIN').mc).toBeCloseTo(20 * 214.08, 9);
    expect(of('RHDOG').mc).toBe(3500);
    expect(of('RHDOG').baseUsd).toBe(1);
    // CULT never had a base price: its `mc` is USD as stored.
    expect(of('CULT').mc).toBe(60_000);
    expect(of('CULT').mcBase).toBe(0);

    const one = (await get<BoardResponse>('/tokens?net=ALL&sort=mc&limit=2')).body;
    const rest = (await get<BoardResponse>('/tokens?net=ALL&sort=mc&limit=2&offset=2')).body;
    expect([...syms(one), ...syms(rest)]).toEqual(syms(byMc));
  });

  it('re-ranks when a native price moves', async () => {
    await priceRows();
    h.oracle.set('ETH', 6000);
    try {
      const byMc = (await get<BoardResponse>('/tokens?net=ALL&sort=mc')).body;
      expect(syms(byMc)).toEqual(['CULT', 'MEMEMAN', 'DEVCOIN', 'RHDOG']);
      expect(byMc.tokens.find((t) => t.sym === 'MEMEMAN')?.mc).toBeCloseTo(6000, 9);
    } finally {
      h.oracle.set('ETH', 4200);
    }
  });

  it('marks KOTH and the tape at the live base price too', async () => {
    await priceRows();
    await h.deps.db.insert((await import('../db/schema.js')).koth).values({
      net: 'BASE',
      sym: 'MEMEMAN',
      mc: 2736.6,
      mcBase: 1,
      crownedAt: minutesAgo(1),
    });
    const koth = (
      await get<{ kings: { sym: string; mc: number; mcBase: number; baseUsd: number }[] }>(
        '/koth?net=BASE',
      )
    ).body;
    expect(koth.kings[0]).toMatchObject({ sym: 'MEMEMAN', mcBase: 1, baseUsd: 4200 });
    expect(koth.kings[0]?.mc).toBeCloseTo(4200, 9);

    // The MEMEMAN prints were recorded at the launch snapshot ($4,400 and
    // $4,450 caps); the strip shows them at today's ETH.
    const tapeRes = (
      await get<{ fills: { sym: string; mc: number; mcBase?: number; baseUsd?: number }[] }>(
        '/tape?net=BASE',
      )
    ).body;
    const prints = tapeRes.fills.filter((f) => f.sym === 'MEMEMAN');
    expect(prints).toHaveLength(2);
    for (const f of prints) {
      expect(f.baseUsd).toBe(4200);
      expect(f.mc).toBeCloseTo((f.mcBase as number) * 4200, 9);
    }
    expect(prints.map((f) => f.mcBase)).toEqual(
      expect.arrayContaining([4450 / 2736.6, 4400 / 2736.6]),
    );
  });
});

describe('GET /tokens search', () => {
  it('matches a ticker prefix in any case', async () => {
    expect(syms((await get<BoardResponse>('/tokens?net=ALL&q=meme')).body)).toEqual(['MEMEMAN']);
    expect(syms((await get<BoardResponse>('/tokens?net=ALL&q=MEME')).body)).toEqual(['MEMEMAN']);
    // A prefix, not a substring: `HDOG` starts no ticker and is in no name.
    expect(syms((await get<BoardResponse>('/tokens?net=ALL&q=HDOG')).body)).toEqual([]);
  });

  it('matches a name substring', async () => {
    expect(syms((await get<BoardResponse>('/tokens?net=ALL&q=robin')).body)).toEqual(['RHDOG']);
  });

  it('matches a contract address exactly whatever its case', async () => {
    expect(syms((await get<BoardResponse>(`/tokens?net=ALL&q=${MINT_A}`)).body)).toEqual([
      'MEMEMAN',
    ]);
    expect(
      syms((await get<BoardResponse>(`/tokens?net=ALL&q=${MINT_A.toLowerCase()}`)).body),
    ).toEqual(['MEMEMAN']);
    expect(syms((await get<BoardResponse>(`/tokens?net=ALL&q=${MINT_C}`)).body)).toEqual([
      'DEVCOIN',
    ]);
  });

  it('matches a contract prefix once it is long enough to mean something', async () => {
    expect(syms((await get<BoardResponse>('/tokens?net=ALL&q=0x847eb6')).body)).toEqual([
      'MEMEMAN',
    ]);
    expect(syms((await get<BoardResponse>('/tokens?net=ALL&q=8sxJxn4z5')).body)).toEqual([
      'DEVCOIN',
    ]);
    // `0x` alone would be every EVM coin; it matches nothing instead.
    expect('0x'.length).toBeLessThan(MINT_PREFIX_MIN);
    expect(syms((await get<BoardResponse>('/tokens?net=ALL&q=0x')).body)).toEqual([]);
  });

  it('treats LIKE metacharacters in the query literally', async () => {
    expect(likeEscape('100%_\\')).toBe('100\\%\\_\\\\');
    // `%` must not turn into "everything"; it is part of CULT's name only.
    expect(syms((await get<BoardResponse>('/tokens?net=ALL&q=%25')).body)).toEqual(['CULT']);
    expect(syms((await get<BoardResponse>('/tokens?net=ALL&q=100%25')).body)).toEqual(['CULT']);
    expect(syms((await get<BoardResponse>('/tokens?net=ALL&q=_')).body)).toEqual([]);
  });

  it('finds nothing for a query that matches nothing, not an error', async () => {
    const { status, body } = await get<BoardResponse>('/tokens?net=ALL&q=zzzz');
    expect(status).toBe(200);
    expect(body.tokens).toEqual([]);
    expect(body.total).toBe(0);
  });
});

describe('GET /tokens replies', () => {
  it('derives the reply count from the coin’s chat rooms on its own chain', async () => {
    const b = (await get<BoardResponse>('/tokens?net=ALL')).body;
    const reps = Object.fromEntries(b.tokens.map((t) => [t.sym, t.reps]));
    // Two public lines + one holders-room line; the flagged one and RH's room do not count.
    expect(reps).toEqual({ MEMEMAN: 0, RHDOG: 0, DEVCOIN: 1, CULT: 3 });
  });

  it('sorts MOST REPLIES by that count', async () => {
    const b = (await get<BoardResponse>('/tokens?net=ALL&sort=rep')).body;
    expect(syms(b).slice(0, 2)).toEqual(['CULT', 'DEVCOIN']);
  });

  it('never lowers a stored counter that is already higher', async () => {
    await h.deps.db.insert(tokens).values(row({ sym: 'LOUD', mint: 'mint-LOUD', replies: 9 }));
    const b = (await get<BoardResponse>('/tokens?net=SOL&sort=rep')).body;
    expect(syms(b)[0]).toBe('LOUD');
    expect(b.tokens[0]?.reps).toBe(9);
  });

  it('gives the token page the same number', async () => {
    const { body } = await get<SerialisedToken>('/tokens/CULT?net=SOL');
    expect(body.reps).toBe(3);
  });
});

interface TapeResponse {
  net: string;
  fills: { sym: string; net: string; sig: string; fid: string; mint?: string; sol: number }[];
}

describe('GET /tape fill ids', () => {
  it('gives every print the indexer’s `${sig}:${ordinal}` id and its coin’s mint', async () => {
    const { body } = await get<TapeResponse>('/tape?net=ALL&limit=16');
    // Newest insert first; the two fills of `0xaaa` keep their log order.
    expect(body.fills.map((f) => f.fid)).toEqual(['sigB:0', '0xaaa:1', '0xaaa:0']);
    expect(body.fills.map((f) => f.mint)).toEqual([MINT_C, MINT_A, MINT_A]);
    // The fixture token's fill is not on the strip.
    expect(body.fills.map((f) => f.sym)).not.toContain('GHOST');
  });

  it('keeps the ordinal right when only one fill of a transaction makes the page', async () => {
    const { body } = await get<TapeResponse>('/tape?net=BASE&limit=1');
    expect(body.fills.map((f) => f.fid)).toEqual(['0xaaa:1']);
  });

  it('falls back to the default limit for nonsense values', async () => {
    expect((await get<TapeResponse>('/tape?net=ALL&limit=-1')).body.fills).toHaveLength(3);
    expect((await get<TapeResponse>('/tape?net=ALL&limit=abc')).body.fills).toHaveLength(3);
    expect((await get<TapeResponse>('/tape?net=ALL&limit=2')).body.fills).toHaveLength(2);
  });
});
