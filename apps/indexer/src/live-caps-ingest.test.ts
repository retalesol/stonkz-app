import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { candles, koth, tape, tokens, trades } from '@stonkz/api/db/schema';
import { createIndexerRig, type IndexerTestRig } from './test/harness.js';
import type { ChainEvent, TradeEvent } from './events.js';

/**
 * 0027: the indexer persists every cap in the base asset next to the
 * snapshot-USD figure, measures the 24h change on the coin's own curve, and
 * puts `mcBase` on the frames it publishes — so the API and the web can mark
 * everything at the live ETH/SOL price without the indexer ever needing one.
 */

const MINT = '0x847eb6311333f8F7F2cd0E9A89379214302aB2c9';
const TRADER = '0x1FA9D4Ad76D53FbF1274d10ACBA12463ae90Bdca';
/** $2,736.6 / ETH stamped at launch. */
const SNAPSHOT = 2736.6;
const T0 = 1_790_686_260_000;

let rig: IndexerTestRig;
let seq = 0;

beforeAll(async () => {
  rig = await createIndexerRig();
});
afterAll(async () => {
  await rig.close();
});
beforeEach(async () => {
  await rig.db.reset();
  rig.published.length = 0;
  await rig.db.db.insert(tokens).values({
    net: 'BASE',
    sym: 'MEMEMAN',
    name: 'Mememan',
    creator: TRADER,
    mint: MINT,
    baseSymbol: 'WETH',
    baseMint: '0x4200000000000000000000000000000000000006',
    supply: 1e6,
    feeBps: 200,
    mc: 1.5 * SNAPSHOT,
    lastMc: 1.5 * SNAPSHOT,
    mcBase: 1.5,
    lastMcBase: 1.5,
    basePriceUsd1e6: '2736600000',
    lane: 'new',
    seed: 7,
    launchedAt: new Date(T0 - 60_000),
  });
});

function trade(
  mcBase: number | undefined,
  atMs: number,
  over: Partial<TradeEvent> = {},
): TradeEvent {
  seq++;
  const mc = (mcBase ?? 2) * SNAPSHOT;
  return {
    net: 'BASE',
    kind: 'Trade',
    txSig: `0x${seq.toString(16).padStart(64, 'b')}`,
    logIndex: 0,
    chainPosition: 47_000_000 + seq,
    blockTimeMs: atMs,
    mint: MINT,
    sym: 'MEMEMAN',
    trader: TRADER,
    side: 'buy',
    nativeAmount: 0.01,
    baseAmount: 0.01,
    tokenAmount: 6000,
    usdValue: 0.01 * SNAPSHOT,
    mc,
    ...(mcBase !== undefined ? { mcBase } : {}),
    cashback: false,
    ...over,
  };
}

async function apply(events: ChainEvent[]) {
  return rig.ingestor.apply(events);
}

async function tokenRow() {
  const [r] = await rig.db.db
    .select({
      mc: tokens.mc,
      mcBase: tokens.mcBase,
      lastMc: tokens.lastMc,
      lastMcBase: tokens.lastMcBase,
      chg: tokens.chg,
      lane: tokens.lane,
    })
    .from(tokens)
    .where(and(eq(tokens.net, 'BASE'), eq(tokens.mint, MINT)));
  return r!;
}

describe('base-denominated caps through the ingestor', () => {
  it('writes the base cap beside the snapshot USD on trades, tape, candles, token and KOTH', async () => {
    expect((await apply([trade(1.6, T0)])).accepted).toBe(1);

    const [t] = await rig.db.db.select().from(trades).where(eq(trades.net, 'BASE'));
    expect(t?.mc).toBeCloseTo(1.6 * SNAPSHOT, 9);
    expect(t?.mcBase).toBe(1.6);
    // Execution price in base per token, the twin of `price` (USD paid ÷ tokens).
    expect(t?.priceBase).toBeCloseTo(0.01 / 6000, 15);
    expect(t?.price).toBeCloseTo((0.01 * SNAPSHOT) / 6000, 12);

    const [tp] = await rig.db.db.select().from(tape).where(eq(tape.net, 'BASE'));
    expect(tp?.mcBase).toBe(1.6);

    const oneMinute = await rig.db.db
      .select()
      .from(candles)
      .where(and(eq(candles.net, 'BASE'), eq(candles.mint, MINT), eq(candles.tf, '1m')));
    expect(oneMinute).toHaveLength(1);
    expect(oneMinute[0]?.cBase).toBeCloseTo(0.01 / 6000, 15);
    expect(oneMinute[0]?.oBase).toBe(oneMinute[0]?.cBase);
    expect(oneMinute[0]?.c).toBeCloseTo((0.01 * SNAPSHOT) / 6000, 12);

    const row = await tokenRow();
    expect(row.mcBase).toBe(1.6);
    expect(row.lastMcBase).toBe(1.5);
    expect(row.mc).toBeCloseTo(1.6 * SNAPSHOT, 9);
    expect(row.lastMc).toBeCloseTo(1.5 * SNAPSHOT, 9);

    const [crown] = await rig.db.db.select().from(koth).where(eq(koth.net, 'BASE'));
    expect(crown).toMatchObject({ sym: 'MEMEMAN', mcBase: 1.6 });
  });

  it('measures the 24h change on the curve in base terms and publishes mcBase on the frames', async () => {
    await apply([trade(1.6, T0)]);
    await apply([trade(2.0, T0 + 120_000)]);
    const row = await tokenRow();
    // (2.0 − 1.6) / 1.6, against the oldest fill in the window.
    expect(row.chg).toBeCloseTo(25, 9);
    expect(row.mcBase).toBe(2);
    expect(row.lastMcBase).toBe(1.6);

    const fills = rig.published.filter(
      (p) => p.channel === 'token:MEMEMAN' && (p.data as { type: string }).type === 'fill',
    );
    expect(fills).toHaveLength(2);
    const last = (fills[1]?.data as { payload: { mc: number; mcBase: number; priceBase: number } })
      .payload;
    expect(last.mcBase).toBe(2);
    expect(last.mc).toBeCloseTo(2 * SNAPSHOT, 9);
    expect(last.priceBase).toBeCloseTo(0.01 / 6000, 15);
    const curve = rig.published.find(
      (p) =>
        p.channel === 'token:MEMEMAN' &&
        (p.data as { type: string; mcBase?: number }).type === 'curve' &&
        (p.data as { mcBase?: number }).mcBase === 2,
    );
    expect(curve).toBeDefined();
    const crown = rig.published.find(
      (p) => p.channel === 'board' && (p.data as { type: string }).type === 'koth',
    );
    expect(crown?.data).toMatchObject({ sym: 'MEMEMAN', mcBase: 1.6 });
  });

  it('candles opened before 0027 adopt the first base fill as their base open', async () => {
    // A bucket written by an older indexer: USD only.
    await rig.db.db.insert(candles).values({
      net: 'BASE',
      sym: 'MEMEMAN',
      mint: MINT,
      tf: '1m',
      bucketStart: new Date(T0 - (T0 % 60_000)),
      o: 0.004,
      h: 0.004,
      l: 0.004,
      c: 0.004,
      v: 10,
      nativeVolume: 0.004,
      trades: 1,
    });
    await apply([trade(1.6, T0)]);
    const [k] = await rig.db.db
      .select()
      .from(candles)
      .where(and(eq(candles.net, 'BASE'), eq(candles.mint, MINT), eq(candles.tf, '1m')));
    expect(k?.trades).toBe(2);
    expect(k?.o).toBe(0.004);
    expect(k?.oBase).toBeCloseTo(0.01 / 6000, 15);
    expect(k?.cBase).toBeCloseTo(0.01 / 6000, 15);
  });

  it('a fill without a base figure (fixture source) leaves the base columns null and keeps the USD change', async () => {
    await apply([trade(undefined, T0, { mc: 1.6 * SNAPSHOT })]);
    await apply([trade(undefined, T0 + 60_000, { mc: 2.0 * SNAPSHOT })]);
    const [t] = await rig.db.db.select().from(trades).where(eq(trades.net, 'BASE'));
    expect(t?.mcBase).toBeNull();
    expect(t?.priceBase).toBeNull();
    const row = await tokenRow();
    expect(row.mcBase).toBe(1.5); // untouched
    expect(row.chg).toBeCloseTo(25, 9);
  });
});
