import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBaseMintRegistry } from '@stonkz/api/router/base-mints';
import { createLogger } from '@stonkz/api/observability/logger';
import { createTestDb, type TestDb } from '@stonkz/api/test/harness';
import {
  applyBuy,
  buyQuote,
  deriveCurve,
  freshState,
  splitFee as splitFeeAtoms,
} from '@stonkz/curve-sim';
import { splitFee } from '@stonkz/shared';
import { assertEventIntegrity, type FeeAccruedEvent, type TradeEvent } from '../events.js';
import { FeeSplitMismatchError, splitFeeLegacyV1 } from './market.js';
import { TokenRegistry, UnknownMintError } from './registry.js';
import { EvmChainSource, groupByTransaction } from './evm-source.js';
import type { RawEvmLog } from './evm-events.js';
import {
  CREATOR,
  DOGGO,
  FakeEvmRpc,
  LAUNCHPAD,
  ROUTER,
  TRADER,
  USDC_RH,
  WETH,
  blockMap,
  encodeLog,
  hash32,
  type FakeBlock,
} from '../test/evm-fixtures.js';

/**
 * The Robinhood Chain source, driven by an in-memory `eth_getLogs`.
 *
 * The logs themselves are encoded by viem from the same ABI the decoder reads,
 * so they are byte-identical to a node's — but no part of this has run against
 * RH, because there is no deployment and no funded access. What is under test
 * is the confirmation gate, the `getLogs` window arithmetic, the
 * transaction grouping, and the decode-to-`ChainEvent` mapping.
 */
let db: TestDb;
const logger = createLogger('silent');
const baseMints = createBaseMintRegistry();

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

/**
 * As on Solana, the curve is derived rather than invented: `deriveCurve` and
 * `buyQuote` are the `@stonkz/curve-sim` mirrors `programs/parity-vectors.json`
 * holds both implementations to, so these are the figures
 * `StonkzLaunchpad.createToken`/`buy` would emit — at RH's 18 decimals.
 */
function required<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`fixture ${what} failed`);
  return value;
}

const SUPPLY = 10n ** 27n; // 1e9 tokens at 18 decimals
const BASE_PRICE_1E6 = 3_400_000_000n; // $3,400 per ETH
const BASE_DECIMALS = 18;

const CURVE = required(deriveCurve(SUPPLY, BASE_PRICE_1E6, BASE_DECIMALS), 'curve derivation');
const FRESH = freshState(CURVE);

/** A 0.4 ETH buy at the creator's 3%. */
const BUY_BASE = 400_000_000_000_000_000n;
const FILL = required(buyQuote(FRESH, 300, BUY_BASE), 'fill quote');
const AFTER = applyBuy(FRESH, FILL);
const LEGS = splitFeeAtoms(FILL.fee);
const FEE_STAKERS = LEGS.creatorBucket / 4n;

const BLOCKS: FakeBlock[] = [
  { number: 1_000, hash: hash32('b1000'), timestampMs: 1_757_000_000_000 },
  { number: 1_001, hash: hash32('b1001'), timestampMs: 1_757_000_002_000 },
  { number: 1_002, hash: hash32('b1002'), timestampMs: 1_757_000_004_000 },
];

const TX_LAUNCH = hash32('a11');
const TX_FILL = hash32('a22');

function launchLog(
  overrides: Partial<Record<string, unknown>> = {},
  placement: Partial<{ blockNumber: number; txHash: string; logIndex: number }> = {},
): RawEvmLog {
  const blockNumber = placement.blockNumber ?? 1_000;
  return encodeLog(
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
      basePrice1e6: BASE_PRICE_1E6,
      ...overrides,
    },
    {
      address: LAUNCHPAD,
      blockNumber,
      blockHash: BLOCKS.find((b) => b.number === blockNumber)?.hash ?? hash32('bff'),
      txHash: placement.txHash ?? TX_LAUNCH,
      logIndex: placement.logIndex ?? 0,
    },
  );
}

function tradeLog(
  overrides: Partial<Record<string, unknown>> = {},
  placement: Partial<{ blockNumber: number; txHash: string; logIndex: number }> = {},
): RawEvmLog {
  const blockNumber = placement.blockNumber ?? 1_001;
  return encodeLog(
    'Trade',
    {
      token: DOGGO,
      trader: TRADER,
      isBuy: true,
      baseAmount: FILL.grossBase,
      tokenAmount: FILL.tokensOut,
      effFeeBps: 300,
      inCashback: false,
      feeTotal: FILL.fee,
      feeProtocol: LEGS.protocol,
      feeOps: LEGS.stonkzOps,
      feeBurn: LEGS.burn,
      feeCreatorBucket: LEGS.creatorBucket,
      feeStakers: FEE_STAKERS,
      feeCreator: LEGS.creatorBucket - FEE_STAKERS,
      cashbackTokens: 0n,
      virtualBase: AFTER.virtualBase,
      virtualToken: AFTER.virtualToken,
      realBase: AFTER.realBase,
      realToken: AFTER.realToken,
      ...overrides,
    },
    {
      address: LAUNCHPAD,
      blockNumber,
      blockHash: BLOCKS.find((b) => b.number === blockNumber)?.hash ?? hash32('bff'),
      txHash: placement.txHash ?? TX_FILL,
      logIndex: placement.logIndex ?? 4,
    },
  );
}

function feeLog(
  overrides: Partial<Record<string, unknown>> = {},
  placement: Partial<{ blockNumber: number; txHash: string; logIndex: number }> = {},
): RawEvmLog {
  const blockNumber = placement.blockNumber ?? 1_001;
  return encodeLog(
    'FeeAccrued',
    {
      token: DOGGO,
      baseToken: WETH,
      feeTotal: FILL.fee,
      protocol: LEGS.protocol,
      ops: LEGS.stonkzOps,
      burn: LEGS.burn,
      creatorBucket: LEGS.creatorBucket,
      ...overrides,
    },
    {
      address: LAUNCHPAD,
      blockNumber,
      blockHash: BLOCKS.find((b) => b.number === blockNumber)?.hash ?? hash32('bff'),
      txHash: placement.txHash ?? TX_FILL,
      logIndex: placement.logIndex ?? 5,
    },
  );
}

function treasuryLog(
  placement: { blockNumber?: number; txHash?: string; logIndex?: number } = {},
): RawEvmLog {
  const blockNumber = placement.blockNumber ?? 1_001;
  return encodeLog(
    'TreasuryCredit',
    {
      baseToken: WETH,
      protocolDelta: LEGS.protocol,
      opsDelta: LEGS.stonkzOps,
      burnDelta: LEGS.burn,
    },
    {
      address: LAUNCHPAD,
      blockNumber,
      blockHash: BLOCKS.find((b) => b.number === blockNumber)?.hash ?? hash32('bff'),
      txHash: placement.txHash ?? TX_FILL,
      logIndex: placement.logIndex ?? 6,
    },
  );
}

/** An unrelated ERC-20 `Transfer`, which the address filter cannot exclude. */
function transferLog(): RawEvmLog {
  return {
    address: LAUNCHPAD.toLowerCase(),
    topics: [hash32('ddf252ad'), hash32('01'), hash32('02')],
    data: `0x${1n.toString(16).padStart(64, '0')}`,
    blockNumber: '0x3e9',
    blockHash: hash32('b1001'),
    transactionHash: TX_FILL,
    logIndex: '0x3',
  };
}

function makeSource(
  logs: RawEvmLog[],
  opts: {
    head?: number;
    confirmations?: number;
    logWindow?: number;
    nativeUsd?: number | Error;
    router?: string;
  } = {},
) {
  const rpc = new FakeEvmRpc(opts.head ?? 1_020, logs, blockMap(BLOCKS));
  const registry = new TokenRegistry(db.db);
  const source = new EvmChainSource({
    rpc,
    launchpadAddress: LAUNCHPAD,
    routerAddress: opts.router ?? ROUTER,
    startBlock: 990,
    registry,
    baseMints,
    nativeUsd: async () => {
      const v = opts.nativeUsd ?? 3_400;
      if (v instanceof Error) throw v;
      return v;
    },
    logger,
    confirmations: opts.confirmations ?? 12,
    ...(opts.logWindow === undefined ? {} : { logWindow: opts.logWindow }),
  });
  return { source, rpc, registry };
}

describe('EvmChainSource — the confirmation gate', () => {
  it('holds ingest a configurable number of blocks behind the raw tip', async () => {
    const { source } = makeSource([], { head: 1_020, confirmations: 12 });
    expect(await source.head()).toBe(1_020);
    expect(await source.confirmedHead()).toBe(1_008);
  });

  it('never reports a negative confirmed head on a young chain', async () => {
    const { source } = makeSource([], { head: 3, confirmations: 12 });
    expect(await source.confirmedHead()).toBe(0);
  });

  it('starts a fresh cursor at the deployment block, not at genesis', async () => {
    const { source } = makeSource([]);
    expect(await source.startPosition()).toBe(990);
  });

  it('reports the block hash at a position so the runner can spot a reorg', async () => {
    const { source, rpc } = makeSource([]);
    expect(await source.blockIdentity(1_001)).toBe(hash32('b1001'));
    rpc.reorgAt(1_001, hash32('dead'));
    expect(await source.blockIdentity(1_001)).toBe(hash32('dead'));
    expect(await source.blockIdentity(9_999)).toBeNull();
  });
});

describe('EvmChainSource — decoding a launch and a fill', () => {
  it('maps TokenCreated into a launch carrying real curve state', async () => {
    const { source } = makeSource([launchLog()]);
    const { events, coveredTo } = await source.pollRange(999, 1_000);
    expect(coveredTo).toBe(1_000);
    expect(events).toHaveLength(1);

    const launch = events[0];
    if (launch?.kind !== 'TokenCreated') throw new Error('expected TokenCreated');
    expect(launch.sym).toBe('DOGGO');
    expect(launch.mint).toBe(DOGGO);
    expect(launch.creator).toBe(CREATOR);
    expect(launch.baseSymbol).toBe('WETH');
    expect(launch.supply).toBe(1e9);
    expect(launch.feeBps).toBe(300);
    expect(launch.blockTimeMs).toBe(1_757_000_000_000);
    // 18 decimals recovered from gradMcapBase alone, no extra RPC call.
    expect(launch.curve?.baseDecimals).toBe(18);
    expect(launch.curve?.tokenDecimals).toBe(18);
    expect(launch.curve?.k).toBe(CURVE.k.toString());
    // Same $69K/16 opening cap as Solana — the curve shape is chain-agnostic.
    expect(launch.mc).toBeCloseTo(69_000 / 16, 0);
    expect(() => assertEventIntegrity(launch)).not.toThrow();
  });

  it('maps a fill to Trade + FeeAccrued and drops the redundant TreasuryCredit', async () => {
    const { source } = makeSource([
      launchLog(),
      tradeLog(),
      feeLog(),
      treasuryLog(),
      transferLog(),
    ]);
    const { events } = await source.pollRange(999, 1_001);

    expect(events.map((e) => e.kind)).toEqual(['TokenCreated', 'Trade', 'FeeAccrued']);

    const trade = events.find((e): e is TradeEvent => e.kind === 'Trade');
    expect(trade?.sym).toBe('DOGGO');
    expect(trade?.trader).toBe(TRADER);
    expect(trade?.side).toBe('buy');
    // aeWETH is the native wrapper, so the base leg *is* the ETH leg, exactly.
    expect(trade?.nativeAmount).toBeCloseTo(0.4, 12);
    expect(trade?.baseAmount).toBeCloseTo(0.4, 12);
    expect(trade?.usdValue).toBeCloseTo(0.4 * 3_400, 6);
    expect(trade?.realToken).toBe(AFTER.realToken.toString());
    // The block's own log index is preserved, not renumbered from zero.
    expect(trade?.logIndex).toBe(4);

    const fee = events.find((e): e is FeeAccruedEvent => e.kind === 'FeeAccrued');
    expect(fee?.creator).toBe(CREATOR);
    expect(fee?.feeAmount).toBeCloseTo(0.012, 12); // 3% of 0.4 ETH
    expect(fee?.protocol).toBeCloseTo(splitFee(0.012).protocol, 12);
    // Chain leg names: `stonkzOps` is the buyback leg, `burn` the RWA leg.
    expect(fee?.stonkzOps).toBeCloseTo(splitFee(0.012).buyback, 12);
    expect(fee?.burn).toBeCloseTo(splitFee(0.012).rwa, 12);
    expect(fee?.stakerShare).toBeCloseTo(splitFee(0.012).creatorBucket / 4, 9);
    if (fee) expect(() => assertEventIntegrity(fee)).not.toThrow();
  });

  it('takes the exact ETH leg from the router rather than reconstructing it', async () => {
    // A USDC-based curve reached through the aggregator: the launchpad's
    // `baseAmount` is USDC, so only `AtomicBuy.ethIn` knows the real ETH.
    const usdcLaunch = launchLog({
      baseToken: USDC_RH,
      basePrice1e6: 1_000_000n,
      gradMcapBase: (69_000_000_000n * 10n ** 6n) / 1_000_000n,
    });
    const atomic = encodeLog(
      'AtomicBuy',
      {
        trader: TRADER,
        token: DOGGO,
        ethIn: 123_456_789_000_000_000n, // 0.123456789 ETH
        baseFromAggregator: FILL.grossBase,
        tokensOut: FILL.tokensOut,
      },
      {
        address: ROUTER,
        blockNumber: 1_001,
        blockHash: hash32('b1001'),
        txHash: TX_FILL,
        // After the curve's Trade/FeeAccrued/TreasuryCredit (4..6): the router
        // emits only once `launchpad.buy` has returned.
        logIndex: 7,
      },
    );

    const { source } = makeSource([usdcLaunch, atomic, tradeLog(), feeLog()]);
    const { events } = await source.pollRange(999, 1_001);
    const trade = events.find((e): e is TradeEvent => e.kind === 'Trade');
    expect(trade?.nativeAmount).toBeCloseTo(0.123456789, 15);
    // The USDC base leg is unchanged: 0.4e18 atoms is 4e11 USDC at 6 decimals.
    expect(trade?.baseAmount).toBeCloseTo(Number(FILL.grossBase) / 1e6, 0);
    // Trade.trader on chain is the router when buy() is called via StonkzRouter;
    // AtomicBuy carries the wallet that actually paid ETH.
    expect(trade?.trader).toBe(TRADER);
  });

  it('attributes a routed fill to AtomicBuy.trader even when Trade.trader is the router', async () => {
    const ROUTER_AS_TRADER = ROUTER;
    const usdcLaunch = launchLog({
      baseToken: USDC_RH,
      basePrice1e6: 1_000_000n,
      gradMcapBase: (69_000_000_000n * 10n ** 6n) / 1_000_000n,
    });
    const atomic = encodeLog(
      'AtomicBuy',
      {
        trader: TRADER,
        token: DOGGO,
        ethIn: 10_000_000_000_000_000n,
        baseFromAggregator: FILL.grossBase,
        tokensOut: FILL.tokensOut,
      },
      {
        address: ROUTER,
        blockNumber: 1_001,
        blockHash: hash32('b1001'),
        txHash: TX_FILL,
        // After the curve's Trade/FeeAccrued/TreasuryCredit (4..6): the router
        // emits only once `launchpad.buy` has returned.
        logIndex: 7,
      },
    );
    const { source } = makeSource([
      usdcLaunch,
      atomic,
      tradeLog({ trader: ROUTER_AS_TRADER }),
      feeLog(),
    ]);
    const { events } = await source.pollRange(999, 1_001);
    const trade = events.find((e): e is TradeEvent => e.kind === 'Trade');
    expect(trade?.trader).toBe(TRADER);
  });

  it('reconstructs the ETH leg through the oracle when no router log is present', async () => {
    const usdcLaunch = launchLog({
      baseToken: USDC_RH,
      basePrice1e6: 1_000_000n,
      gradMcapBase: (69_000_000_000n * 10n ** 6n) / 1_000_000n,
    });
    const { source } = makeSource([usdcLaunch, tradeLog(), feeLog()], { nativeUsd: 3_400 });
    const { events } = await source.pollRange(999, 1_001);
    const trade = events.find((e): e is TradeEvent => e.kind === 'Trade');
    expect(trade?.nativeAmount).toBeCloseTo((trade?.usdValue ?? 0) / 3_400, 12);
  });

  it('records 0 native rather than an invented figure when the oracle is down', async () => {
    const usdcLaunch = launchLog({
      baseToken: USDC_RH,
      basePrice1e6: 1_000_000n,
      gradMcapBase: (69_000_000_000n * 10n ** 6n) / 1_000_000n,
    });
    const { source } = makeSource([usdcLaunch, tradeLog(), feeLog()], {
      nativeUsd: new Error('oracle unreachable'),
    });
    const { events } = await source.pollRange(999, 1_001);
    const trade = events.find((e): e is TradeEvent => e.kind === 'Trade');
    expect(trade?.nativeAmount).toBe(0);
    // The exact legs the chain did report are still recorded.
    expect(trade?.usdValue).toBeGreaterThan(0);
  });

  it('refuses a fill for a token it has never seen a launch for', async () => {
    const { source } = makeSource([tradeLog()]);
    await expect(source.pollRange(1_000, 1_001)).rejects.toThrow(UnknownMintError);
  });

  it('still accepts a fill the contract settled under the legacy v1 split', async () => {
    const v1 = splitFeeLegacyV1(FILL.fee);
    expect(v1.protocol).not.toBe(LEGS.protocol);
    const { source } = makeSource([
      launchLog(),
      tradeLog({
        feeProtocol: v1.protocol,
        feeOps: v1.stonkzOps,
        feeBurn: v1.burn,
        feeCreatorBucket: v1.creatorBucket,
        feeStakers: v1.creatorBucket / 4n,
        feeCreator: v1.creatorBucket - v1.creatorBucket / 4n,
      }),
      feeLog({
        protocol: v1.protocol,
        ops: v1.stonkzOps,
        burn: v1.burn,
        creatorBucket: v1.creatorBucket,
      }),
    ]);
    const { events } = await source.pollRange(999, 1_001);
    const fee = events.find((e): e is FeeAccruedEvent => e.kind === 'FeeAccrued');
    expect(fee?.protocol).toBeCloseTo(0.012 * 0.2, 12);
    expect(fee?.stonkzOps).toBeCloseTo(0.012 * 0.1, 12);
    expect(fee?.burn).toBeCloseTo(0.012 * 0.1, 12);
    expect(fee?.creatorBucket).toBeCloseTo(0.012 * 0.6, 12);
    for (const event of events) expect(() => assertEventIntegrity(event)).not.toThrow();
  });

  it('rejects a fee split the contract settled under neither v2 nor legacy v1', async () => {
    const { source } = makeSource([
      launchLog(),
      tradeLog(),
      feeLog({ protocol: LEGS.protocol + 1n, creatorBucket: LEGS.creatorBucket - 1n }),
    ]);
    await expect(source.pollRange(999, 1_001)).rejects.toThrow(FeeSplitMismatchError);
    await expect(source.pollRange(999, 1_001)).rejects.toThrow(/match neither/);
  });

  it('weights a stake against circulating supply, not against total staked', async () => {
    const staked = encodeLog(
      'Staked',
      {
        token: DOGGO,
        owner: TRADER,
        amount: FILL.tokensOut / 2n,
        lockDays: 30,
        weight: (FILL.tokensOut / 2n) * 2n,
        lockUntil: 1_759_600_000n,
      },
      {
        address: LAUNCHPAD,
        blockNumber: 1_002,
        blockHash: hash32('b1002'),
        txHash: hash32('a33'),
        logIndex: 0,
      },
    );
    const { source } = makeSource([launchLog(), tradeLog(), feeLog(), staked]);
    const { events } = await source.pollRange(999, 1_002);

    const stake = events.find((e) => e.kind === 'Staked');
    if (stake?.kind !== 'Staked') throw new Error('expected Staked');
    // The fill sold `tokensOut` off the curve, so that is the float — and the
    // staker locked exactly half of it.
    expect(stake.circulating).toBeCloseTo(Number(FILL.tokensOut) / 1e18, 6);
    expect(stake.amount / stake.circulating).toBeCloseTo(0.5, 9);
    expect(stake.mult).toBeCloseTo(2, 9);
    expect(stake.lockDays).toBe(30);
  });
});

describe('EvmChainSource — the getLogs window', () => {
  it('asks for an inclusive range starting one past the cursor', async () => {
    const { source, rpc } = makeSource([]);
    await source.pollRange(1_000, 1_003);
    expect(rpc.calls.find((c) => c.method === 'eth_getLogs')?.params).toMatchObject({
      fromBlock: 1_001,
      toBlock: 1_003,
    });
  });

  it('caps a pass at the window and reports only what it covered', async () => {
    const { source, rpc } = makeSource([], { logWindow: 5 });
    const result = await source.pollRange(1_000, 9_999);
    expect(rpc.calls.find((c) => c.method === 'eth_getLogs')?.params).toMatchObject({
      fromBlock: 1_001,
      toBlock: 1_005,
    });
    // The cursor must not advance past what was actually read.
    expect(result.coveredTo).toBe(1_005);
  });

  it('queries the launchpad and the router together', async () => {
    const { source, rpc } = makeSource([]);
    await source.pollRange(1_000, 1_001);
    const filter = rpc.calls.find((c) => c.method === 'eth_getLogs')?.params as {
      addresses: string[];
    };
    // The RPC filter is lowercased on purpose (eth_getLogs is case-insensitive
    // and this is not a join key); the fixtures are EIP-55 like the decoder's output.
    expect(filter.addresses).toEqual([LAUNCHPAD, ROUTER].map((a) => a.toLowerCase()));
  });

  it('omits an unset router instead of filtering on the zero address', async () => {
    const { source, rpc } = makeSource([], {
      router: '0x0000000000000000000000000000000000000000',
    });
    await source.pollRange(1_000, 1_001);
    const filter = rpc.calls.find((c) => c.method === 'eth_getLogs')?.params as {
      addresses: string[];
    };
    expect(filter.addresses).toEqual([LAUNCHPAD.toLowerCase()]);
  });

  it('spends no RPC calls at all on a zero-width range', async () => {
    const { source, rpc } = makeSource([launchLog()]);
    expect(await source.pollRange(1_000, 1_000)).toEqual({ events: [], coveredTo: 1_000 });
    expect(rpc.calls).toHaveLength(0);
  });

  it('surfaces an RPC failure instead of reporting an empty range', async () => {
    const { source, rpc } = makeSource([launchLog()]);
    rpc.failGetLogs = new Error('provider returned more than 10000 results');
    await expect(source.pollRange(999, 1_000)).rejects.toThrow(/10000 results/);
  });

  it('fetches each block header once, however many transactions it holds', async () => {
    const second = hash32('a44');
    const { source, rpc } = makeSource([
      launchLog(),
      tradeLog(),
      feeLog(),
      tradeLog({}, { txHash: second, logIndex: 9 }),
      feeLog({}, { txHash: second, logIndex: 10 }),
    ]);
    await source.pollRange(999, 1_001);
    const headerCalls = rpc.calls.filter((c) => c.method === 'eth_getBlockByNumber');
    expect(headerCalls.map((c) => c.params).sort()).toEqual([1_000, 1_001]);
  });
});

describe('groupByTransaction', () => {
  it("groups a fill's three logs together and orders them by log index", () => {
    const groups = groupByTransaction([treasuryLog(), feeLog(), tradeLog()], logger);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.logs.map((l) => l.logIndex)).toEqual([4, 5, 6]);
    expect(groups[0]?.logs.map((l) => l.event.name)).toEqual([
      'Trade',
      'FeeAccrued',
      'TreasuryCredit',
    ]);
  });

  it('orders transactions by block, then by first log index', () => {
    const later = tradeLog({}, { blockNumber: 1_002, txHash: hash32('c1'), logIndex: 1 });
    const earlier = launchLog({}, { blockNumber: 1_000, txHash: hash32('c2'), logIndex: 7 });
    const groups = groupByTransaction([later, earlier], logger);
    expect(groups.map((g) => g.blockNumber)).toEqual([1_000, 1_002]);
  });

  it('ignores logs it has no ABI for, which every launchpad tx also emits', () => {
    const groups = groupByTransaction([transferLog()], logger);
    expect(groups).toHaveLength(0);
  });

  it('drops a reorg-removed log rather than materialising a disowned one', () => {
    const groups = groupByTransaction([{ ...tradeLog(), removed: true }, feeLog()], logger);
    expect(groups[0]?.logs.map((l) => l.event.name)).toEqual(['FeeAccrued']);
  });
});

describe('EvmChainSource — the launch path end to end', () => {
  const EMITTERS = { launchpad: LAUNCHPAD.toLowerCase(), router: ROUTER.toLowerCase() };

  it('ignores a byte-identical TokenCreated emitted by any other contract', () => {
    const spoof = { ...launchLog(), address: '0x000000000000000000000000000000000000bad1' };
    expect(groupByTransaction([spoof], logger, EMITTERS)).toHaveLength(0);
    // Without emitters (the old contract) it would have been accepted.
    expect(groupByTransaction([spoof], logger)).toHaveLength(1);
  });

  it('accepts router events only from the router, and launchpad events only from the launchpad', () => {
    const atomicFromLaunchpad = encodeLog(
      'AtomicBuy',
      { trader: TRADER, token: DOGGO, ethIn: 1n, baseFromAggregator: 1n, tokensOut: 1n },
      {
        address: LAUNCHPAD,
        blockNumber: 1_001,
        blockHash: hash32('b1001'),
        txHash: TX_FILL,
        logIndex: 9,
      },
    );
    const tradeFromRouter = { ...tradeLog(), address: ROUTER.toLowerCase() };
    expect(
      groupByTransaction([atomicFromLaunchpad, tradeFromRouter], logger, EMITTERS),
    ).toHaveLength(0);
    expect(
      groupByTransaction([atomicFromLaunchpad], logger, {
        launchpad: EMITTERS.launchpad,
        router: null,
      }),
    ).toHaveLength(0);
  });

  it('drops spoofed logs even when the provider ignores the address filter', async () => {
    const spoofLaunch = {
      ...launchLog({ ticker: 'FAKE' }, { txHash: hash32('bad') }),
      address: '0x000000000000000000000000000000000000bad1',
    };
    const { source, rpc } = makeSource([launchLog()]);
    const honest = rpc.getLogs.bind(rpc);
    rpc.getLogs = async (filter) => [...(await honest(filter)), spoofLaunch];
    const { events } = await source.pollRange(999, 1_000);
    expect(events.map((e) => (e.kind === 'TokenCreated' ? e.sym : e.kind))).toEqual(['DOGGO']);
  });

  it('narrows a getLogs window the provider refuses for size instead of failing it', async () => {
    const { source, rpc } = makeSource([launchLog(), tradeLog(), feeLog()]);
    rpc.maxLogsPerCall = 1;
    const result = await source.pollRange(999, 1_001);
    // [1000, 1001] held 3 logs; [1000, 1000] holds the launch alone.
    expect(result.coveredTo).toBe(1_000);
    expect(result.events.map((e) => e.kind)).toEqual(['TokenCreated']);
    const spans = rpc.calls
      .filter((c) => c.method === 'eth_getLogs')
      .map((c) => [
        (c.params as { fromBlock: number }).fromBlock,
        (c.params as { toBlock: number }).toBlock,
      ]);
    expect(spans).toEqual([
      [1_000, 1_001],
      [1_000, 1_000],
    ]);
  });

  it('does not narrow on a rate limit, which is not a size problem', async () => {
    const { source, rpc } = makeSource([launchLog()]);
    rpc.failGetLogs = new Error('429 Too Many Requests: rate limit exceeded');
    await expect(source.pollRange(990, 1_001)).rejects.toThrow(/429/);
    expect(rpc.calls.filter((c) => c.method === 'eth_getLogs')).toHaveLength(1);
  });

  it('fails the pass instead of stamping a launch at 1970 when its block header is missing', async () => {
    const { source } = makeSource([launchLog({}, { blockNumber: 1_005 })]);
    await expect(source.pollRange(999, 1_005)).rejects.toThrow(/no header timestamp/);
  });

  it('orders a same-block snipe after the launch it trades, whatever the tx hashes', async () => {
    const launchTx = hash32('ff01');
    const snipeTx = hash32('0001');
    const { source } = makeSource([
      launchLog({}, { blockNumber: 1_001, txHash: launchTx, logIndex: 0 }),
      tradeLog({}, { blockNumber: 1_001, txHash: snipeTx, logIndex: 4 }),
      feeLog({}, { blockNumber: 1_001, txHash: snipeTx, logIndex: 5 }),
    ]);
    const { events } = await source.pollRange(1_000, 1_001);
    expect(events.map((e) => e.kind)).toEqual(['TokenCreated', 'Trade', 'FeeAccrued']);
  });

  it('keeps the exact base leg for a WETH curve even when the router refunded part of msg.value', async () => {
    const atomic = encodeLog(
      'AtomicBuy',
      {
        trader: TRADER,
        token: DOGGO,
        // msg.value was 1 ETH; the curve only took 0.4 and 0.6 went back.
        ethIn: 10n ** 18n,
        baseFromAggregator: FILL.grossBase,
        tokensOut: FILL.tokensOut,
      },
      {
        address: ROUTER,
        blockNumber: 1_001,
        blockHash: hash32('b1001'),
        txHash: TX_FILL,
        logIndex: 7,
      },
    );
    const { source } = makeSource([launchLog(), tradeLog({ trader: ROUTER }), feeLog(), atomic]);
    const { events } = await source.pollRange(999, 1_001);
    const trade = events.find((e): e is TradeEvent => e.kind === 'Trade');
    expect(trade?.nativeAmount).toBeCloseTo(0.4, 12);
    expect(trade?.trader).toBe(TRADER);
  });

  it("pairs each FeeAccrued with its own fill's staker peel in a multi-fill transaction", async () => {
    const { source } = makeSource([
      launchLog(),
      tradeLog({ feeStakers: LEGS.creatorBucket / 4n }, { logIndex: 4 }),
      feeLog({}, { logIndex: 5 }),
      treasuryLog({ logIndex: 6 }),
      tradeLog({ feeStakers: 0n, feeCreator: LEGS.creatorBucket }, { logIndex: 7 }),
      feeLog({}, { logIndex: 8 }),
      treasuryLog({ logIndex: 9 }),
    ]);
    const { events } = await source.pollRange(999, 1_001);
    const fees = events.filter((e): e is FeeAccruedEvent => e.kind === 'FeeAccrued');
    expect(fees).toHaveLength(2);
    expect(fees[0]?.stakerShare).toBeCloseTo((fees[0]?.creatorBucket ?? 0) / 4, 9);
    expect(fees[1]?.stakerShare).toBe(0);
  });
});
