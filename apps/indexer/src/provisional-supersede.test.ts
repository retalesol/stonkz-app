import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { applyBuy, buyQuote, deriveCurve, freshState, splitFee } from '@stonkz/curve-sim';
import type { AppDeps } from '@stonkz/api/app/context';
import { candles, holdersSnapshot, trades, xpEvents } from '@stonkz/api/db/schema';
import { createBaseMintRegistry } from '@stonkz/api/router/base-mints';
import { createLogger } from '@stonkz/api/observability/logger';
import { confirmTradeFills } from '@stonkz/api/routes/trade-provisional';
import { EvmChainSource } from './chain/evm-source.js';
import { TokenRegistry } from './chain/registry.js';
import type { RawEvmLog } from './chain/evm-events.js';
import {
  CREATOR,
  DOGGO,
  FakeEvmRpc,
  LAUNCHPAD,
  ROUTER,
  TRADER,
  WETH,
  blockMap,
  encodeLog,
  hash32,
  type FakeBlock,
} from './test/evm-fixtures.js';
import { createIndexerRig, type IndexerTestRig } from './test/harness.js';

/**
 * `/trade/confirm`'s provisional fill, then the indexer's authoritative ingest
 * of the same transaction, end to end on one database and one Redis:
 *
 * - the provisional print writes nothing to any read table (so a reorg that
 *   drops the transaction has nothing to roll back server-side);
 * - the indexer's print carries the same `fid` and the same numbers, so the
 *   web replaces rather than adds;
 * - volume, candles, holders and XP are counted exactly once;
 * - a late or repeated confirm never re-broadcasts.
 */

function required<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`fixture ${what} failed`);
  return value;
}

const SUPPLY = 10n ** 27n;
const PRICE_1E6 = 3_400_000_000n;
const CURVE = required(deriveCurve(SUPPLY, PRICE_1E6, 18), 'curve');
const FRESH = freshState(CURVE);
const FILL1 = required(buyQuote(FRESH, 300, 400_000_000_000_000_000n), 'fill 1');
const AFTER1 = applyBuy(FRESH, FILL1);
const FILL2 = required(buyQuote(AFTER1, 300, 100_000_000_000_000_000n), 'fill 2');
const AFTER2 = applyBuy(AFTER1, FILL2);

const BLOCKS: FakeBlock[] = [
  { number: 1_000, hash: hash32('b1000'), timestampMs: 1_757_000_000_000 },
  { number: 1_001, hash: hash32('b1001'), timestampMs: 1_757_000_002_000 },
];
const TX_LAUNCH = hash32('a11');
const TX_BUYS = hash32('a22');

function at(logIndex: number, txHash = TX_BUYS, blockNumber = 1_001) {
  return {
    address: LAUNCHPAD,
    blockNumber,
    blockHash: BLOCKS.find((b) => b.number === blockNumber)!.hash,
    txHash,
    logIndex,
  };
}

function tradeLog(
  fill: typeof FILL1,
  after: typeof AFTER1,
  base: bigint,
  logIndex: number,
): RawEvmLog {
  const legs = splitFee(fill.fee);
  return encodeLog(
    'Trade',
    {
      token: DOGGO,
      trader: ROUTER, // routed: the launchpad sees the router
      isBuy: true,
      baseAmount: base,
      tokenAmount: fill.tokensOut,
      effFeeBps: 300,
      inCashback: false,
      feeTotal: fill.fee,
      feeProtocol: legs.protocol,
      feeOps: legs.stonkzOps,
      feeBurn: legs.burn,
      feeCreatorBucket: legs.creatorBucket,
      feeStakers: 0n,
      feeCreator: legs.creatorBucket,
      cashbackTokens: 0n,
      virtualBase: after.virtualBase,
      virtualToken: after.virtualToken,
      realBase: after.realBase,
      realToken: after.realToken,
    },
    at(logIndex),
  );
}

function atomicBuyLog(fill: typeof FILL1, ethIn: bigint, logIndex: number): RawEvmLog {
  return encodeLog(
    'AtomicBuy',
    {
      trader: TRADER,
      token: DOGGO,
      ethIn,
      baseFromAggregator: 0n,
      tokensOut: fill.tokensOut,
    },
    { ...at(logIndex), address: ROUTER },
  );
}

const LAUNCH_LOG = encodeLog(
  'TokenCreated',
  {
    token: DOGGO,
    baseToken: WETH,
    creator: CREATOR,
    ticker: 'DOGGO',
    supply: SUPPLY,
    feeBps: 300,
    cashback: false,
    cbStart: 0n,
    virtualBase: CURVE.virtualBase,
    virtualToken: CURVE.virtualToken,
    tokensForSale: CURVE.tokensForSale,
    lpReserve: CURVE.lpReserve,
    gradMcapBase: CURVE.gradMcapBase,
    basePrice1e6: PRICE_1E6,
  },
  at(0, TX_LAUNCH, 1_000),
);

const BUY_LOGS: RawEvmLog[] = [
  tradeLog(FILL1, AFTER1, FILL1.grossBase, 4),
  atomicBuyLog(FILL1, FILL1.grossBase, 5),
  tradeLog(FILL2, AFTER2, FILL2.grossBase, 6),
  atomicBuyLog(FILL2, FILL2.grossBase, 7),
];

interface FillFrame {
  type: string;
  payload: Record<string, unknown>;
}

let rig: IndexerTestRig;
let deps: AppDeps;
let source: EvmChainSource;

beforeAll(async () => {
  rig = await createIndexerRig();
  // The rig's env has no RH deployment; point the API at the fixture contracts.
  deps = {
    ...rig.deps,
    env: { ...rig.deps.env, rhLaunchpadAddress: LAUNCHPAD, rhRouterAddress: ROUTER },
  };
  source = new EvmChainSource({
    rpc: new FakeEvmRpc(1_020, [LAUNCH_LOG, ...BUY_LOGS], blockMap(BLOCKS)),
    launchpadAddress: LAUNCHPAD,
    routerAddress: ROUTER,
    startBlock: 990,
    registry: new TokenRegistry(rig.db.db),
    baseMints: createBaseMintRegistry(),
    nativeUsd: async () => 3_400,
    logger: createLogger('silent'),
    confirmations: 12,
  });
  // The launch is indexed long before anyone trades it.
  const launch = await source.pollRange(999, 1_000);
  await rig.ingestor.apply(launch.events);

  rig.rpcs.RH.setEvmReceipt(TX_BUYS, {
    status: 'success',
    from: TRADER,
    to: ROUTER,
    input: '0x',
    blockNumber: 1_001,
    logs: BUY_LOGS.map((l) => ({
      address: l.address,
      topics: l.topics,
      data: l.data,
      logIndex: l.logIndex,
    })),
  });
  rig.rpcs.RH.setBlockTime(1_001, BLOCKS[1]!.timestampMs);
});

afterAll(async () => {
  await rig.close();
});

function fillFrames(channel: string): FillFrame[] {
  return rig.published
    .filter((p) => p.channel === channel && (p.data as FillFrame).type === 'fill')
    .map((p) => p.data as FillFrame);
}

async function tradeCount(): Promise<number> {
  const [row] = await rig.db.db
    .select({ n: sql<number>`count(*)::int` })
    .from(trades)
    .where(eq(trades.txSig, TX_BUYS));
  return row?.n ?? 0;
}

describe('provisional fill → authoritative ingest', () => {
  it('publishes provisional prints at one confirmation and writes no read table', async () => {
    const outcome = await confirmTradeFills(deps, 'RH', TX_BUYS);
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.published).toBe(true);
    expect(outcome.fills.map((f) => f.fid)).toEqual([`${TX_BUYS}:0`, `${TX_BUYS}:1`]);
    expect(outcome.fills[0]?.w).toBe(TRADER); // AtomicBuy.trader, not the router
    expect(outcome.fills[0]?.t).toBe(BLOCKS[1]!.timestampMs);

    const token = fillFrames('token:DOGGO');
    expect(token).toHaveLength(2);
    expect(token.every((f) => f.payload['provisional'] === true)).toBe(true);
    expect(fillFrames('tape')).toHaveLength(2);

    expect(await tradeCount()).toBe(0);
    const [c] = await rig.db.db
      .select({ n: sql<number>`count(*)::int` })
      .from(candles)
      .where(eq(candles.sym, 'DOGGO'));
    expect(c?.n).toBe(0);
  });

  it('does not re-broadcast a repeated confirm', async () => {
    const before = rig.published.length;
    const again = await confirmTradeFills(deps, 'RH', TX_BUYS);
    expect(again.kind === 'ok' && again.published).toBe(false);
    expect(rig.published.length).toBe(before);
  });

  it('supersedes by fid with identical numbers and counts everything once', async () => {
    const provisional = fillFrames('token:DOGGO').map((f) => f.payload);
    const buys = await source.pollRange(1_000, 1_001);
    await rig.ingestor.apply(buys.events);

    const authoritative = fillFrames('token:DOGGO')
      .slice(provisional.length)
      .map((f) => f.payload);
    expect(authoritative).toHaveLength(2);
    for (const [i, a] of authoritative.entries()) {
      const p = provisional[i]!;
      expect(a['provisional']).toBeUndefined();
      expect(a['fid']).toBe(p['fid']);
      for (const k of ['t', 'sym', 'mint', 'buy', 'sol', 'tok', 'mc', 'w', 'v', 'cb', 'sig']) {
        expect(a[k], k).toEqual(p[k]);
      }
    }

    expect(await tradeCount()).toBe(2);
    const [m1] = await rig.db.db
      .select()
      .from(candles)
      .where(and(eq(candles.sym, 'DOGGO'), eq(candles.tf, '1m')));
    expect(m1?.trades).toBe(2);
    const holders = await rig.db.db
      .select()
      .from(holdersSnapshot)
      .where(eq(holdersSnapshot.wallet, TRADER));
    expect(holders).toHaveLength(1);
    const tokensOut = Number(FILL1.tokensOut + FILL2.tokensOut) / 1e18;
    expect(holders[0]!.tokenAmount).toBeCloseTo(tokensOut, 6);
    // XP is keyed (wallet, tx, reason): the provisional print never reached
    // the ledger, so each reason pays exactly once for the transaction.
    const xp = await rig.db.db
      .select({ reason: xpEvents.reason, n: sql<number>`count(*)::int` })
      .from(xpEvents)
      .where(eq(xpEvents.txSig, TX_BUYS))
      .groupBy(xpEvents.reason);
    expect(xp.length).toBeGreaterThan(0);
    expect(xp.every((r) => r.n === 1)).toBe(true);
  });

  it('stays silent once the indexer has the transaction, and on a replay', async () => {
    const before = rig.published.length;
    const late = await confirmTradeFills(deps, 'RH', TX_BUYS);
    expect(late.kind === 'ok' && late.final).toBe(true);
    const replay = await source.pollRange(1_000, 1_001);
    const report = await rig.ingestor.apply(replay.events);
    expect(report.accepted).toBe(0);
    expect(rig.published.length).toBe(before);
    expect(await tradeCount()).toBe(2);
  });
});
