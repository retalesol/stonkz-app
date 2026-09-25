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
import { assertEventIntegrity, type TradeEvent } from '../events.js';
import { TokenRegistry, UnknownMintError } from './registry.js';
import {
  SolanaChainSource,
  SolanaRangeTooBusyError,
  boundToSlotBoundary,
} from './solana-source.js';
import {
  CREATOR,
  DOGGO_MINT,
  FakeSolanaRpc,
  PROGRAM_ID,
  TRADER,
  USDC_MINT,
  WSOL_MINT,
  emitCpiPayload,
  encodeFeeAccrued,
  encodeTokenCreated,
  encodeTrade,
  encodeTreasuryCredit,
  programDataLine,
  type FakeTx,
} from '../test/solana-fixtures.js';

/**
 * The Solana source, driven by an in-memory RPC that honours the real
 * `getSignaturesForAddress` contract (newest-first, exclusive `before`/`until`,
 * `limit`).
 *
 * Nothing here has touched a cluster — there is no deployed program and no
 * funded access, which is stated in `docs/real-vs-simulated.md`. What is being
 * tested is the paging arithmetic, the cursor/bookmark contract, the
 * confirmation gate, and the decode-to-`ChainEvent` mapping, all of which are
 * chain-independent logic.
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
 * The fixture curve is *derived*, not invented: `deriveCurve` is the same
 * `@stonkz/curve-sim` mirror `create_token` is held to by
 * `programs/parity-vectors.json`, so the reserves, the fill and the fee legs
 * below are the numbers the program would actually emit for this launch.
 */
const SUPPLY = 1_000_000_000_000_000n; // 1e9 tokens at 6 decimals
const BASE_PRICE_1E6 = 214_080_000n; // $214.08 per SOL
const BASE_DECIMALS = 9;

function required<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`fixture ${what} failed`);
  return value;
}

const CURVE = required(deriveCurve(SUPPLY, BASE_PRICE_1E6, BASE_DECIMALS), 'curve derivation');
const FRESH = freshState(CURVE);
const TOKENS_FOR_SALE = CURVE.tokensForSale;
const GRAD_MCAP_BASE = CURVE.gradMcapBase;

/** A 1.5 SOL buy at the creator's 2.5%, quoted and split exactly as the program would. */
const BUY_BASE = 1_500_000_000n;
const FILL = required(buyQuote(FRESH, 250, BUY_BASE), 'fill quote');
const AFTER = applyBuy(FRESH, FILL);
const CHAIN_LEGS = splitFeeAtoms(FILL.fee);
/** The staker peel: a fifth of the bucket, well inside the half-bucket ceiling. */
const FEE_STAKERS = CHAIN_LEGS.creatorBucket / 5n;

function launchLog(overrides: Partial<Parameters<typeof encodeTokenCreated>[0]> = {}): string {
  return programDataLine(
    'TokenCreated',
    encodeTokenCreated({
      mint: DOGGO_MINT,
      baseMint: WSOL_MINT,
      creator: CREATOR,
      ticker: 'DOGGO',
      supply: SUPPLY,
      feeBps: 250,
      cashback: false,
      cbStart: 0n,
      virtualBase: CURVE.virtualBase,
      virtualToken: CURVE.virtualToken,
      tokensForSale: TOKENS_FOR_SALE,
      lpReserve: CURVE.lpReserve,
      gradMcapBase: GRAD_MCAP_BASE,
      basePrice1e6: BASE_PRICE_1E6,
      ts: 1_757_000_000n,
      ...overrides,
    }),
  );
}

function fillLogs(): string[] {
  return [
    `Program ${PROGRAM_ID} invoke [1]`,
    'Program log: Instruction: Buy',
    programDataLine(
      'Trade',
      encodeTrade({
        mint: DOGGO_MINT,
        trader: TRADER,
        isBuy: true,
        baseAmount: FILL.grossBase,
        tokenAmount: FILL.tokensOut,
        effFeeBps: 250,
        inCashback: false,
        feeTotal: FILL.fee,
        feeProtocol: CHAIN_LEGS.protocol,
        feeOps: CHAIN_LEGS.stonkzOps,
        feeBurn: CHAIN_LEGS.burn,
        feeCreatorBucket: CHAIN_LEGS.creatorBucket,
        feeStakers: FEE_STAKERS,
        feeCreator: CHAIN_LEGS.creatorBucket - FEE_STAKERS,
        cashbackTokens: 0n,
        virtualBase: AFTER.virtualBase,
        virtualToken: AFTER.virtualToken,
        realBase: AFTER.realBase,
        realToken: AFTER.realToken,
        circulating: FILL.tokensOut,
        ts: 1_757_000_100n,
      }),
    ),
    programDataLine(
      'FeeAccrued',
      encodeFeeAccrued({
        mint: DOGGO_MINT,
        baseMint: WSOL_MINT,
        feeTotal: FILL.fee,
        protocol: CHAIN_LEGS.protocol,
        ops: CHAIN_LEGS.stonkzOps,
        burn: CHAIN_LEGS.burn,
        creatorBucket: CHAIN_LEGS.creatorBucket,
        ts: 1_757_000_100n,
      }),
    ),
    programDataLine(
      'TreasuryCredit',
      encodeTreasuryCredit({
        baseMint: WSOL_MINT,
        protocolDelta: CHAIN_LEGS.protocol,
        opsDelta: CHAIN_LEGS.stonkzOps,
        burnDelta: CHAIN_LEGS.burn,
        ts: 1_757_000_100n,
      }),
    ),
  ];
}

function makeSource(
  txs: FakeTx[],
  opts: {
    finalizedSlot?: number;
    confirmations?: number;
    maxTxPerPass?: number;
    pageSize?: number;
    maxPages?: number;
    nativeUsd?: () => Promise<number>;
    trackBlockhash?: boolean;
  } = {},
): { source: SolanaChainSource; rpc: FakeSolanaRpc; registry: TokenRegistry } {
  const rpc = new FakeSolanaRpc(txs, opts.finalizedSlot);
  const registry = new TokenRegistry(db.db);
  const source = new SolanaChainSource({
    rpc,
    programId: PROGRAM_ID,
    startSlot: 1_000,
    registry,
    baseMints,
    nativeUsd: opts.nativeUsd ?? (async () => 214.08),
    logger,
    confirmations: opts.confirmations ?? 0,
    ...(opts.maxTxPerPass !== undefined ? { maxTxPerPass: opts.maxTxPerPass } : {}),
    ...(opts.pageSize !== undefined ? { signaturePageSize: opts.pageSize } : {}),
    ...(opts.maxPages !== undefined ? { maxSignaturePages: opts.maxPages } : {}),
    ...(opts.trackBlockhash !== undefined ? { trackBlockhash: opts.trackBlockhash } : {}),
  });
  return { source, rpc, registry };
}

describe('SolanaChainSource — heads and the confirmation gate', () => {
  it('reads the finalized slot as the head and never starts a fresh cursor at 0', async () => {
    const { source } = makeSource([], { finalizedSlot: 5_000 });
    expect(await source.head()).toBe(5_000);
    expect(await source.startPosition()).toBe(1_000);
  });

  it('holds the confirmed head a configurable number of slots behind the tip', async () => {
    const { source } = makeSource([], { finalizedSlot: 5_000, confirmations: 32 });
    expect(await source.confirmedHead()).toBe(4_968);
  });

  it('clamps the confirmed head at 0 on a chain younger than the buffer', async () => {
    const { source } = makeSource([], { finalizedSlot: 10, confirmations: 64 });
    expect(await source.confirmedHead()).toBe(0);
  });

  it('reports no block identity unless hash tracking is switched on', async () => {
    const off = makeSource([], { finalizedSlot: 100 });
    expect(await off.source.blockIdentity(100)).toBeNull();
    expect(off.rpc.calls.some((c) => c.method === 'getBlockhash')).toBe(false);

    const on = makeSource([], { finalizedSlot: 100, trackBlockhash: true });
    on.rpc.blockhashes.set(100, 'HASH100');
    expect(await on.source.blockIdentity(100)).toBe('HASH100');
  });
});

describe('SolanaChainSource — decoding a launch and a fill', () => {
  it('maps TokenCreated into a launch event carrying real curve state', async () => {
    const { source } = makeSource([
      { signature: 'sigLaunch', slot: 1_100, blockTimeSecs: 1_757_000_000, logs: [launchLog()] },
    ]);

    const { events, coveredTo } = await source.pollRange(1_000, 1_200);
    expect(coveredTo).toBe(1_200);
    expect(events).toHaveLength(1);
    const launch = events[0];
    if (launch?.kind !== 'TokenCreated') throw new Error('expected TokenCreated');

    expect(launch.sym).toBe('DOGGO');
    expect(launch.mint).toBe(DOGGO_MINT);
    expect(launch.creator).toBe(CREATOR);
    // The base mint resolved to a known symbol rather than a raw address.
    expect(launch.baseSymbol).toBe('SOL');
    expect(launch.chainPosition).toBe(1_100);
    expect(launch.blockTimeMs).toBe(1_757_000_000_000);
    expect(launch.supply).toBe(1_000_000_000);
    expect(launch.feeBps).toBe(250);
    // baseDecimals recovered from gradMcapBase + basePrice1e6 alone.
    expect(launch.curve?.baseDecimals).toBe(9);
    expect(launch.curve?.tokenDecimals).toBe(6);
    expect(launch.curve?.k).toBe(CURVE.k.toString());
    expect(launch.curve?.realToken).toBe(TOKENS_FOR_SALE.toString());
    // The curve closes at exactly $69K, so it opens at grad/16 = $4,312.50:
    // virtualBase is grad/15 against a virtualToken of supply*16/15.
    expect(launch.mc).toBeCloseTo(69_000 / 16, 0);
    expect(() => assertEventIntegrity(launch)).not.toThrow();
  });

  it('maps a fill to Trade + FeeAccrued and drops the redundant TreasuryCredit', async () => {
    const { source } = makeSource([
      { signature: 'sigLaunch', slot: 1_100, blockTimeSecs: 1_757_000_000, logs: [launchLog()] },
      { signature: 'sigBuy', slot: 1_150, blockTimeSecs: 1_757_000_100, logs: fillLogs() },
    ]);

    const { events } = await source.pollRange(1_000, 1_200);
    expect(events.map((e) => e.kind)).toEqual(['TokenCreated', 'Trade', 'FeeAccrued']);

    const trade = events.find((e): e is TradeEvent => e.kind === 'Trade');
    expect(trade?.side).toBe('buy');
    expect(trade?.trader).toBe(TRADER);
    expect(trade?.sym).toBe('DOGGO');
    // Base is wrapped SOL, so the native leg is the base leg, exactly.
    expect(trade?.nativeAmount).toBeCloseTo(1.5, 12);
    expect(trade?.baseAmount).toBeCloseTo(1.5, 12);
    expect(trade?.tokenAmount).toBeCloseTo(Number(FILL.tokensOut) / 1e6, 6);
    expect(trade?.usdValue).toBeCloseTo(1.5 * 214.08, 6);
    expect(trade?.realBase).toBe(AFTER.realBase.toString());
    expect(trade?.realToken).toBe(AFTER.realToken.toString());

    const fee = events.find((e) => e.kind === 'FeeAccrued');
    if (fee?.kind !== 'FeeAccrued') throw new Error('expected FeeAccrued');
    expect(fee.creator).toBe(CREATOR);
    // 2.5% of 1.5 SOL = 0.0375 SOL of fee, split exactly 20/70/10 in native.
    expect(fee.feeAmount).toBeCloseTo(0.0375, 12);
    expect(fee.protocol).toBeCloseTo(splitFee(0.0375).protocol, 12);
    // Staker peel stayed inside the bucket.
    expect(fee.stakerShare).toBeLessThanOrEqual(fee.creatorBucket / 2 + 1e-9);
    // The whole point of re-splitting the converted total: the integrity
    // check the ingestor runs must pass on the mapped event.
    for (const event of events) expect(() => assertEventIntegrity(event)).not.toThrow();
  });

  it('reads the emit_cpi! framing too, for a provider that truncates logs', async () => {
    const { source } = makeSource([
      {
        signature: 'sigLaunchCpi',
        slot: 1_100,
        blockTimeSecs: 1_757_000_000,
        logs: ['Program log: Instruction: CreateToken'],
        cpiData: [
          emitCpiPayload(
            'TokenCreated',
            Buffer.from(launchLog().split('Program data: ')[1] as string, 'base64').subarray(8),
          ),
        ],
        accountKeys: [PROGRAM_ID],
      },
    ]);
    const { events } = await source.pollRange(1_000, 1_200);
    expect(events.map((e) => e.kind)).toEqual(['TokenCreated']);
  });

  it('refuses a fill for a mint it has never seen a launch for', async () => {
    const { source } = makeSource([
      { signature: 'sigOrphanBuy', slot: 1_150, blockTimeSecs: 1_757_000_100, logs: fillLogs() },
    ]);
    await expect(source.pollRange(1_000, 1_200)).rejects.toThrow(UnknownMintError);
  });

  it('rejects a fee split the chain did not settle 20/60/10/10', async () => {
    const bent = fillLogs();
    bent[3] = programDataLine(
      'FeeAccrued',
      encodeFeeAccrued({
        mint: DOGGO_MINT,
        baseMint: WSOL_MINT,
        feeTotal: FILL.fee,
        // A protocol leg skimmed by one atom.
        protocol: CHAIN_LEGS.protocol + 1n,
        ops: CHAIN_LEGS.stonkzOps,
        burn: CHAIN_LEGS.burn,
        creatorBucket: CHAIN_LEGS.creatorBucket - 1n,
        ts: 1n,
      }),
    );
    const { source } = makeSource([
      { signature: 'sigLaunch', slot: 1_100, blockTimeSecs: 1_757_000_000, logs: [launchLog()] },
      { signature: 'sigBent', slot: 1_150, blockTimeSecs: 1_757_000_100, logs: bent },
    ]);
    await expect(source.pollRange(1_000, 1_200)).rejects.toThrow(
      /do not match the integer 20\/60\/10\/10/,
    );
  });

  it('prices a non-native base leg through the oracle instead of pretending it is native', async () => {
    const { source } = makeSource(
      [
        {
          signature: 'sigUsdcLaunch',
          slot: 1_100,
          blockTimeSecs: 1_757_000_000,
          logs: [
            launchLog({
              baseMint: USDC_MINT,
              ticker: 'USDCOIN',
              basePrice1e6: 1_000_000n,
              gradMcapBase: (69_000_000_000n * 10n ** 6n) / 1_000_000n,
            }),
          ],
        },
        { signature: 'sigUsdcBuy', slot: 1_150, blockTimeSecs: 1_757_000_100, logs: fillLogs() },
      ],
      { nativeUsd: async () => 200 },
    );

    const { events } = await source.pollRange(1_000, 1_200);
    const trade = events.find((e): e is TradeEvent => e.kind === 'Trade');
    // 1_500_000_000 atoms at 6 decimals = 1500 USDC = $1500 → 7.5 SOL at $200.
    expect(trade?.baseAmount).toBeCloseTo(1_500, 9);
    expect(trade?.usdValue).toBeCloseTo(1_500, 6);
    expect(trade?.nativeAmount).toBeCloseTo(7.5, 9);
    expect(trade?.sym).toBe('USDCOIN');
  });

  it('records 0 native rather than an invented figure when the oracle is down', async () => {
    const { source } = makeSource(
      [
        {
          signature: 'sigUsdcLaunch',
          slot: 1_100,
          blockTimeSecs: 1_757_000_000,
          logs: [
            launchLog({
              baseMint: USDC_MINT,
              ticker: 'NOORACLE',
              basePrice1e6: 1_000_000n,
              gradMcapBase: (69_000_000_000n * 10n ** 6n) / 1_000_000n,
            }),
          ],
        },
        { signature: 'sigUsdcBuy', slot: 1_150, blockTimeSecs: 1_757_000_100, logs: fillLogs() },
      ],
      {
        nativeUsd: async () => {
          throw new Error('oracle unreachable');
        },
      },
    );
    const { events } = await source.pollRange(1_000, 1_200);
    const trade = events.find((e): e is TradeEvent => e.kind === 'Trade');
    expect(trade?.nativeAmount).toBe(0);
    // The exact base and USD legs are still recorded.
    expect(trade?.usdValue).toBeCloseTo(1_500, 6);
  });

  it('skips a reverted transaction entirely', async () => {
    const { source } = makeSource([
      { signature: 'sigLaunch', slot: 1_100, blockTimeSecs: 1_757_000_000, logs: [launchLog()] },
      {
        signature: 'sigFailed',
        slot: 1_150,
        blockTimeSecs: 1_757_000_100,
        logs: fillLogs(),
        err: { InstructionError: [0, { Custom: 6_000 }] },
      },
    ]);
    const { events } = await source.pollRange(1_000, 1_200);
    expect(events.map((e) => e.kind)).toEqual(['TokenCreated']);
  });
});

describe('SolanaChainSource — signature paging and the cursor window', () => {
  const busy = (count: number, firstSlot = 1_010): FakeTx[] =>
    Array.from({ length: count }, (_, i) => ({
      signature: `sig${String(i).padStart(4, '0')}`,
      slot: firstSlot + i,
      blockTimeSecs: 1_757_000_000 + i,
      logs: ['Program log: unrelated'],
    }));

  it('excludes the cursor slot and includes the range end', async () => {
    const { source, rpc } = makeSource(busy(5), { finalizedSlot: 1_014 });
    await source.pollRange(1_011, 1_013);
    const fetched = rpc.calls.filter((c) => c.method === 'getTransaction').map((c) => c.params);
    // Slots 1_010 (at/below cursor) and 1_014 (above range) are excluded.
    expect(fetched).toEqual(['sig0002', 'sig0003']);
  });

  it('pages backwards until it reaches the cursor, oldest-first afterwards', async () => {
    const { source, rpc } = makeSource(busy(25), { finalizedSlot: 1_034, pageSize: 10 });
    await source.pollRange(1_009, 1_034);
    const pages = rpc.calls.filter((c) => c.method === 'getSignaturesForAddress');
    expect(pages.length).toBeGreaterThan(1);
    const fetched = rpc.calls.filter((c) => c.method === 'getTransaction').map((c) => c.params);
    expect(fetched[0]).toBe('sig0000');
    expect(fetched.at(-1)).toBe('sig0024');
  });

  it('passes the restored bookmark as `until`, so a steady pass does not rescan the tip', async () => {
    const { source, rpc } = makeSource(busy(10), { finalizedSlot: 1_019 });
    source.restoreBookmark('sig0004');
    const result = await source.pollRange(1_014, 1_019);
    const page = rpc.calls.find((c) => c.method === 'getSignaturesForAddress');
    expect((page?.params as { until?: string }).until).toBe('sig0004');
    // The bookmark advances to the newest signature actually processed.
    expect(result.bookmark).toBe('sig0009');
  });

  it('keeps the bookmark when a pass finds nothing, rather than clearing it', async () => {
    const { source } = makeSource(busy(3), { finalizedSlot: 1_012 });
    source.restoreBookmark('sig0002');
    const result = await source.pollRange(1_012, 1_012);
    expect(result.events).toHaveLength(0);
    expect(result.bookmark).toBe('sig0002');
  });

  it('bounds a pass at a slot boundary and reports how far it actually covered', async () => {
    const { source, rpc } = makeSource(busy(50), { finalizedSlot: 1_059, maxTxPerPass: 10 });
    const result = await source.pollRange(1_009, 1_059);
    expect(rpc.calls.filter((c) => c.method === 'getTransaction')).toHaveLength(10);
    // One tx per slot here, so ten transactions is ten slots.
    expect(result.coveredTo).toBe(1_019);
    expect(result.coveredTo).toBeLessThan(1_059);
  });

  it('never splits a slot, even when the cap lands mid-slot', () => {
    const infos = [
      { signature: 'a', slot: 10, err: null, blockTime: 1 },
      { signature: 'b', slot: 11, err: null, blockTime: 1 },
      { signature: 'c', slot: 11, err: null, blockTime: 1 },
      { signature: 'd', slot: 11, err: null, blockTime: 1 },
      { signature: 'e', slot: 12, err: null, blockTime: 1 },
    ];
    const { batch, coveredTo } = boundToSlotBoundary(infos, 2, 12);
    // The cap fell inside slot 11, so all of slot 11 comes along and the
    // cursor stops at 11 — otherwise c and d would be lost forever.
    expect(batch.map((b) => b.signature)).toEqual(['a', 'b', 'c', 'd']);
    expect(coveredTo).toBe(11);
  });

  it('covers the whole range when everything fits', () => {
    const infos = [{ signature: 'a', slot: 10, err: null, blockTime: 1 }];
    expect(boundToSlotBoundary(infos, 10, 99)).toEqual({ batch: infos, coveredTo: 99 });
  });

  it('raises rather than silently dropping the older end of an over-busy range', async () => {
    const { source } = makeSource(busy(100), { finalizedSlot: 1_109, pageSize: 5, maxPages: 3 });
    await expect(source.pollRange(1_009, 1_109)).rejects.toThrow(SolanaRangeTooBusyError);
  });

  it('spends no RPC calls at all on a zero-width range', async () => {
    const { source, rpc } = makeSource(busy(3), { finalizedSlot: 1_012 });
    const result = await source.pollRange(1_012, 1_012);
    expect(result).toEqual({ events: [], coveredTo: 1_012, bookmark: null });
    expect(rpc.calls).toHaveLength(0);
  });

  it('surfaces an RPC failure instead of reporting an empty range', async () => {
    const { source, rpc } = makeSource(busy(3), { finalizedSlot: 1_012 });
    rpc.failNext = new Error('429 too many requests');
    await expect(source.pollRange(1_009, 1_012)).rejects.toThrow(/429/);
  });
});
