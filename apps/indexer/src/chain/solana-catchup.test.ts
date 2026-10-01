import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createBaseMintRegistry } from '@stonkz/api/router/base-mints';
import { createLogger } from '@stonkz/api/observability/logger';
import type { Alert } from '@stonkz/api/observability/metrics';
import { createTestDb, type TestDb } from '@stonkz/api/test/harness';
import { chainEvents, indexerDeadLetters } from '@stonkz/api/db/schema';
import { applyBuy, buyQuote, deriveCurve, freshState, splitFee } from '@stonkz/curve-sim';
import { CatchupMonitor } from '../catchup.js';
import { readHealth, renderPrometheus } from '../http.js';
import type { PassResult } from '../runner.js';
import type { EventSource } from '../source.js';
import { createIndexerRig, type IndexerTestRig } from '../test/harness.js';
import { ScriptedSource } from '../test/scripted-source.js';
import {
  CREATOR,
  DOGGO_MINT,
  FakeSolanaRpc,
  PROGRAM_ID,
  TRADER,
  WSOL_MINT,
  encodeFeeAccrued,
  encodeTokenCreated,
  encodeTrade,
  programDataLine,
  type FakeTx,
} from '../test/solana-fixtures.js';
import { TokenRegistry } from './registry.js';
import { SolanaChainSource, SolanaRangeTooBusyError } from './solana-source.js';

/**
 * The Solana catch-up walk (`docs/mainnet-readiness.md` item 4.6).
 *
 * `getSignaturesForAddress` only pages *down* from the tip, ingest only runs
 * *up* from the cursor, and the gap after an outage can be any size. The old
 * source capped the walk at 20 pages and threw past it, which the runner
 * dead-lettered — silently losing every fill in the range. These tests drive
 * the new walk the way the runner does (cursor forward, bookmark restored
 * each pass) across gaps far bigger than one pass, and hold it to: every
 * signature fetched exactly once, the cursor never moving backwards, every
 * pass bounded, no dead letters, and a backlog an operator can see.
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

/** `count` program transactions that decode to nothing, `perSlot` per slot from `firstSlot`. */
function quiet(count: number, perSlot = 1, firstSlot = 1_010): FakeTx[] {
  return Array.from({ length: count }, (_, i) => ({
    signature: `sig${String(i).padStart(6, '0')}`,
    slot: firstSlot + Math.floor(i / perSlot),
    blockTimeSecs: 1_757_000_000 + i,
    logs: ['Program log: unrelated'],
  }));
}

interface SourceOpts {
  finalizedSlot?: number;
  maxTxPerPass?: number;
  pageSize?: number;
  maxPages?: number;
  passBudgetMs?: number;
  now?: () => number;
  registry?: TokenRegistry;
}

function makeSource(
  rpc: FakeSolanaRpc,
  opts: SourceOpts = {},
): { source: SolanaChainSource; registry: TokenRegistry } {
  const registry = opts.registry ?? new TokenRegistry(db.db);
  const source = new SolanaChainSource({
    rpc,
    programId: PROGRAM_ID,
    startSlot: 1_000,
    registry,
    baseMints,
    nativeUsd: async () => 214.08,
    logger,
    confirmations: 0,
    ...(opts.maxTxPerPass !== undefined ? { maxTxPerPass: opts.maxTxPerPass } : {}),
    ...(opts.pageSize !== undefined ? { signaturePageSize: opts.pageSize } : {}),
    ...(opts.maxPages !== undefined ? { maxSignaturePages: opts.maxPages } : {}),
    ...(opts.passBudgetMs !== undefined ? { passBudgetMs: opts.passBudgetMs } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  return { source, registry };
}

interface Pass {
  from: number;
  to: number;
  coveredTo: number;
  /** Signature pages this pass spent, counted at the RPC. */
  pages: number;
  txFetched: number;
  remaining: number;
  located: boolean;
  partial: boolean;
}

/**
 * The runner's cursor loop, minus the database: `from` advances to what the
 * pass covered, the bookmark the pass handed back is restored before the
 * next, and `to` is clamped to the batch size. Returns every pass so the
 * invariants can be asserted over the whole run.
 */
async function drive(
  source: SolanaChainSource,
  rpc: FakeSolanaRpc,
  state: { cursor: number; bookmark: string | null },
  opts: { head: number; batchSize?: number; maxPasses?: number; between?: (pass: Pass) => void },
): Promise<Pass[]> {
  const passes: Pass[] = [];
  const batchSize = opts.batchSize ?? 5_000;
  const limit = opts.maxPasses ?? 5_000;
  while (state.cursor < opts.head && passes.length < limit) {
    source.restoreBookmark(state.bookmark);
    const to = Math.min(opts.head, state.cursor + batchSize);
    const sigCallsBefore = rpc.calls.filter((c) => c.method === 'getSignaturesForAddress').length;
    const txCallsBefore = rpc.calls.filter((c) => c.method === 'getTransaction').length;
    const result = await source.pollRange(state.cursor, to);
    const pass: Pass = {
      from: state.cursor,
      to,
      coveredTo: result.coveredTo,
      pages:
        rpc.calls.filter((c) => c.method === 'getSignaturesForAddress').length - sigCallsBefore,
      txFetched: rpc.calls.filter((c) => c.method === 'getTransaction').length - txCallsBefore,
      remaining: result.backlog?.remaining ?? -1,
      located: result.backlog?.located ?? false,
      partial: result.backlog?.partial ?? false,
    };
    passes.push(pass);
    // The runner's guard: never past `to`, never behind `from`.
    expect(result.coveredTo).toBeGreaterThanOrEqual(state.cursor);
    state.cursor = Math.max(state.cursor, Math.min(to, result.coveredTo));
    if (result.bookmark !== undefined) state.bookmark = result.bookmark;
    opts.between?.(pass);
  }
  return passes;
}

const fetchedSignatures = (rpc: FakeSolanaRpc): string[] =>
  rpc.calls.filter((c) => c.method === 'getTransaction').map((c) => c.params as string);

describe('SolanaChainSource — catching up across a gap larger than one pass', () => {
  it('ingests 50k signatures over successive bounded passes, each exactly once, cursor monotonic', async () => {
    // 50,000 signatures, two per slot, in pages of 1,000 — fifty pages, with
    // ten allowed per pass. The locate alone needs five passes.
    const txs = quiet(50_000, 2);
    const head = txs.at(-1)?.slot ?? 0;
    const rpc = new FakeSolanaRpc(txs, head);
    const { source } = makeSource(rpc, { pageSize: 1_000, maxPages: 10, maxTxPerPass: 1_000 });

    const state = { cursor: 1_009, bookmark: null as string | null };
    const passes = await drive(source, rpc, state, { head });

    // Everything arrived, nothing twice: the whole point of the change.
    const fetched = fetchedSignatures(rpc);
    expect(fetched).toHaveLength(50_000);
    expect(new Set(fetched).size).toBe(50_000);
    expect(state.cursor).toBe(head);

    // Oldest first, across pages and passes.
    expect(fetched[0]).toBe('sig000000');
    expect(fetched.at(-1)).toBe('sig049999');
    for (let i = 1; i < fetched.length; i++) {
      expect(fetched[i] > (fetched[i - 1] as string)).toBe(true);
    }

    // The first passes locate without ingesting, and say so.
    const first = passes[0];
    expect(first).toMatchObject({ coveredTo: 1_009, pages: 10, txFetched: 0, partial: true });
    expect(first?.located).toBe(false);
    expect(first?.remaining).toBe(10_000);
    const locating = passes.filter((p) => !p.located);
    expect(locating).toHaveLength(5);
    // The estimate grows as the walk finds more, then shrinks as ingest eats it.
    expect(locating.map((p) => p.remaining)).toEqual([10_000, 20_000, 30_000, 40_000, 50_000]);
    const ingesting = passes.filter((p) => p.located && p.txFetched > 0);
    for (let i = 1; i < ingesting.length; i++) {
      expect(ingesting[i]?.remaining).toBeLessThanOrEqual(ingesting[i - 1]?.remaining ?? 0);
    }
    expect(passes.at(-1)).toMatchObject({ remaining: 0, located: true, partial: false });

    // Every pass stayed inside its caps.
    for (const pass of passes) {
      expect(pass.pages).toBeLessThanOrEqual(10);
      expect(pass.txFetched).toBeLessThanOrEqual(1_000);
      expect(pass.coveredTo).toBeGreaterThanOrEqual(pass.from);
    }
    // And the cursor never went backwards.
    for (let i = 1; i < passes.length; i++) {
      expect(passes[i]?.from).toBeGreaterThanOrEqual(passes[i - 1]?.from ?? 0);
    }
    // Pages were walked once to locate and roughly once more to collect; a
    // walk that restarted from the tip every pass would be quadratic here.
    const totalPages = passes.reduce((n, p) => n + p.pages, 0);
    expect(totalPages).toBeLessThan(50 * 4);
  });

  it('resumes correctly after a restart mid-catch-up, from the persisted bookmark alone', async () => {
    const txs = quiet(12_000, 3);
    const head = txs.at(-1)?.slot ?? 0;
    const rpc = new FakeSolanaRpc(txs, head);
    const registry = new TokenRegistry(db.db);
    const first = makeSource(rpc, { pageSize: 500, maxPages: 6, maxTxPerPass: 400, registry });

    // Walk part of the way: past the locate and into the ingest.
    const state = { cursor: 1_009, bookmark: null as string | null };
    await drive(first.source, rpc, state, { head, maxPasses: 12 });
    const midway = fetchedSignatures(rpc).length;
    expect(midway).toBeGreaterThan(0);
    expect(midway).toBeLessThan(12_000);
    expect(state.bookmark).not.toBeNull();

    // A new process: no in-memory walk, only the cursor row (position + bookmark).
    const second = makeSource(rpc, { pageSize: 500, maxPages: 6, maxTxPerPass: 400, registry });
    const resumed = await drive(second.source, rpc, state, { head });

    const fetched = fetchedSignatures(rpc);
    expect(fetched).toHaveLength(12_000);
    expect(new Set(fetched).size).toBe(12_000);
    expect(state.cursor).toBe(head);
    // The restart re-located from the tip with `until = bookmark` — bounded,
    // and without re-reading anything below the bookmark.
    expect(resumed[0]?.located).toBe(false);
    const untils = rpc.calls
      .filter((c) => c.method === 'getSignaturesForAddress')
      .slice(-resumed.reduce((n, p) => n + p.pages, 0))
      .map((c) => (c.params as { until?: string }).until);
    expect(untils.every((u) => u !== undefined)).toBe(true);
  });

  it('keeps up with a tip that moves by more than a page while the walk is in progress', async () => {
    const initial = quiet(3_000, 1);
    const rpc = new FakeSolanaRpc(initial, 1_010 + 3_000 + 500);
    const { source } = makeSource(rpc, { pageSize: 100, maxPages: 4, maxTxPerPass: 150 });

    // After the walk has located everything and started ingesting, 350 more
    // signatures land — three and a half pages, so the tip page the walk
    // remembered no longer reaches down to anything it knows about.
    let appended = false;
    const state = { cursor: 1_009, bookmark: null as string | null };
    const head = 1_010 + 3_000 + 500;
    await drive(source, rpc, state, {
      head,
      between: (pass) => {
        if (!appended && pass.located && pass.txFetched > 0) {
          appended = true;
          rpc.append(
            Array.from({ length: 350 }, (_, i) => ({
              signature: `late${String(i).padStart(4, '0')}`,
              slot: 1_010 + 3_000 + i,
              blockTimeSecs: 1_757_100_000 + i,
              logs: ['Program log: unrelated'],
            })),
          );
        }
      },
    });

    const fetched = fetchedSignatures(rpc);
    expect(appended).toBe(true);
    expect(fetched).toHaveLength(3_350);
    expect(new Set(fetched).size).toBe(3_350);
    // Still oldest first across the join.
    expect(fetched.indexOf('sig002999')).toBeLessThan(fetched.indexOf('late0000'));
    expect(fetched.at(-1)).toBe('late0349');
  });

  it('honours the per-pass time budget but always fetches at least one page', async () => {
    const txs = quiet(2_000, 1);
    const head = txs.at(-1)?.slot ?? 0;
    const rpc = new FakeSolanaRpc(txs, head);
    // Every clock read is a second later; a 500ms budget is blown after one page.
    let t = 0;
    const now = (): number => (t += 1_000);
    const { source } = makeSource(rpc, {
      pageSize: 100,
      maxPages: 50,
      maxTxPerPass: 500,
      passBudgetMs: 500,
      now,
    });

    source.restoreBookmark(null);
    const first = await source.pollRange(1_009, head);
    expect(rpc.calls.filter((c) => c.method === 'getSignaturesForAddress')).toHaveLength(1);
    expect(first.coveredTo).toBe(1_009);
    expect(first.backlog).toMatchObject({ partial: true, located: false, pages: 1 });

    // And the walk still completes, one page per pass — two at most, when
    // the only thing collected so far is a slot that continues on the next
    // page and a second page is the only way to ever commit it.
    const state = { cursor: 1_009, bookmark: first.bookmark ?? null };
    const passes = await drive(source, rpc, state, { head });
    expect(new Set(fetchedSignatures(rpc)).size).toBe(2_000);
    expect(passes.every((p) => p.pages <= 2)).toBe(true);
    expect(passes.filter((p) => p.pages === 1).length).toBeGreaterThan(passes.length / 2);
  });

  it('never splits a slot that straddles a page boundary across two passes', async () => {
    // Twenty signatures per slot with pages of 50: every other page boundary
    // lands mid-slot. A pass that committed the newest, half-seen slot would
    // lose the other half, because the next pass starts strictly after it.
    const txs = quiet(1_000, 20);
    const head = txs.at(-1)?.slot ?? 0;
    const rpc = new FakeSolanaRpc(txs, head);
    const { source } = makeSource(rpc, { pageSize: 50, maxPages: 1, maxTxPerPass: 30 });

    const state = { cursor: 1_009, bookmark: null as string | null };
    let committed = 0;
    await drive(source, rpc, state, {
      head,
      between: (pass) => {
        if (pass.coveredTo === pass.from) return;
        committed++;
        // Every committed position is a whole slot: by the end of the pass
        // that moved the cursor there, all of that slot's signatures had been
        // fetched — none left behind for a next pass that starts above it.
        const seen = new Set(fetchedSignatures(rpc));
        for (const t of txs) if (t.slot <= pass.coveredTo) expect(seen.has(t.signature)).toBe(true);
      },
    });
    expect(committed).toBeGreaterThan(10);
    const fetched = fetchedSignatures(rpc);
    expect(fetched).toHaveLength(1_000);
    expect(new Set(fetched).size).toBe(1_000);
  });

  it('steady state costs one signature page per pass and no re-scan of the tip', async () => {
    const txs = quiet(10, 1);
    const rpc = new FakeSolanaRpc(txs, 1_019);
    const { source } = makeSource(rpc, { pageSize: 1_000 });

    const state = { cursor: 1_009, bookmark: null as string | null };
    await drive(source, rpc, state, { head: 1_019 });
    expect(rpc.calls.filter((c) => c.method === 'getSignaturesForAddress')).toHaveLength(1);

    // Caught up: a pass with nothing new is one call that returns nothing.
    rpc.finalizedSlot = 1_025;
    source.restoreBookmark(state.bookmark);
    const idle = await source.pollRange(1_019, 1_025);
    expect(idle).toMatchObject({ events: [], coveredTo: 1_025, bookmark: 'sig000009' });
    expect(idle.backlog).toMatchObject({ remaining: 0, located: true, partial: false });
    expect(rpc.calls.filter((c) => c.method === 'getSignaturesForAddress')).toHaveLength(2);
  });

  it('throws away its in-memory walk when the cursor is rewound under it', async () => {
    const txs = quiet(600, 1);
    const head = txs.at(-1)?.slot ?? 0;
    const rpc = new FakeSolanaRpc(txs, head);
    const { source } = makeSource(rpc, { pageSize: 100, maxPages: 3, maxTxPerPass: 100 });

    const state = { cursor: 1_009, bookmark: null as string | null };
    await drive(source, rpc, state, { head, maxPasses: 4 });
    expect(source.backlogEstimate()).toBeGreaterThan(0);

    // A reorg handler or the backfill CLI rewinds and clears the bookmark.
    source.restoreBookmark(null);
    expect(source.backlogEstimate()).toBe(0);
    rpc.calls.length = 0;
    const replay = await drive(
      source,
      rpc,
      { cursor: 1_009, bookmark: null },
      { head, maxPasses: 4 },
    );
    // Located again from the tip, with no `until`, and oldest first as ever.
    expect((rpc.calls[0]?.params as { until?: string }).until).toBeUndefined();
    expect(replay.some((p) => p.coveredTo > 1_009)).toBe(true);
    expect(fetchedSignatures(rpc)[0]).toBe('sig000000');
  });
});

/* ------------------------------------------------------- through the runner */

const SUPPLY = 1_000_000_000_000_000n;
const BASE_PRICE_1E6 = 214_080_000n;
function required<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`fixture ${what} failed`);
  return value;
}
const CURVE = required(deriveCurve(SUPPLY, BASE_PRICE_1E6, 9), 'curve derivation');
const FRESH = freshState(CURVE);
const FILL = required(buyQuote(FRESH, 250, 1_500_000_000n), 'fill quote');
const AFTER = applyBuy(FRESH, FILL);
const LEGS = splitFee(FILL.fee);
const FEE_STAKERS = LEGS.creatorBucket / 5n;

function launchTx(slot: number): FakeTx {
  return {
    signature: 'sigLaunch',
    slot,
    blockTimeSecs: 1_757_000_000,
    logs: [
      programDataLine(
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
          tokensForSale: CURVE.tokensForSale,
          lpReserve: CURVE.lpReserve,
          gradMcapBase: CURVE.gradMcapBase,
          basePrice1e6: BASE_PRICE_1E6,
          ts: 1_757_000_000n,
        }),
      ),
    ],
  };
}

function fillTx(i: number, slot: number): FakeTx {
  const ts = BigInt(1_757_000_100 + i);
  return {
    signature: `sigFill${String(i).padStart(5, '0')}`,
    slot,
    blockTimeSecs: Number(ts),
    logs: [
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
          circulating: FILL.tokensOut,
          ts,
        }),
      ),
      programDataLine(
        'FeeAccrued',
        encodeFeeAccrued({
          mint: DOGGO_MINT,
          baseMint: WSOL_MINT,
          feeTotal: FILL.fee,
          protocol: LEGS.protocol,
          ops: LEGS.stonkzOps,
          burn: LEGS.burn,
          creatorBucket: LEGS.creatorBucket,
          ts,
        }),
      ),
      `Program ${PROGRAM_ID} success`,
    ],
  };
}

function recordingLogger(now: () => number) {
  const lines: { level: string; msg: string; [k: string]: unknown }[] = [];
  const sink = (line: string): void => {
    lines.push(JSON.parse(line) as { level: string; msg: string });
  };
  return { logger: createLogger('debug', {}, sink, now), lines };
}

describe('IndexerRunner — a Solana catch-up never dead-letters', () => {
  let rig: IndexerTestRig;
  afterEach(async () => {
    await rig?.close();
  });

  it('ingests a launch and 400 fills behind a nine-page gap with no dead letters, and reports the backlog', async () => {
    const txs = [launchTx(1_100), ...Array.from({ length: 400 }, (_, i) => fillTx(i, 1_101 + i))];
    const head = 1_500;
    const rpc = new FakeSolanaRpc(txs, head);

    const alerts: Alert[] = [];
    let clock = Date.parse('2026-09-06T12:00:00.000Z');
    const now = (): number => clock;
    const { logger: recording, lines } = recordingLogger(now);
    const catchup = new CatchupMonitor({
      logger: recording,
      onAlert: (a) => alerts.push(a),
      alertAfterMs: 5 * 60_000,
      logEveryMs: 60_000,
      now,
    });

    const idle = (net: 'SOL' | 'RH' | 'BASE' | 'ARC'): ScriptedSource =>
      new ScriptedSource({ net, head: 0, startPosition: 1 });
    // The runner reads this record on every pass, so the real source can be
    // dropped in once the rig's database (which the registry reads launches
    // from) exists.
    const sources = {
      SOL: idle('SOL') as EventSource,
      RH: idle('RH'),
      BASE: idle('BASE'),
      ARC: idle('ARC'),
    };
    rig = await createIndexerRig([], {
      startNow: clock,
      sources,
      deadLetters: true,
      maxBatchAttempts: 2,
      catchup,
    });
    // Two pages per pass against nine pages of signatures, and 40
    // transactions per pass: the kind of gap that used to end in
    // `SolanaRangeTooBusyError` five times and a skipped range.
    sources.SOL = new SolanaChainSource({
      rpc,
      programId: PROGRAM_ID,
      startSlot: 1_000,
      registry: new TokenRegistry(rig.db.db),
      baseMints,
      nativeUsd: async () => 214.08,
      logger: recording,
      signaturePageSize: 50,
      maxSignaturePages: 2,
      maxTxPerPass: 40,
    });
    rig.rpcs.SOL.setHead(head);
    {
      const results: PassResult[] = [];
      // Pass by pass, two minutes apart on the clock, so the backlog persists
      // long enough to cross the alert threshold mid-walk.
      for (let i = 0; i < 6; i++) {
        results.push(await rig.runner.pass('SOL'));
        clock += 2 * 60_000;
        rig.setNow(clock);
      }
      // Mid-walk: the health surface shows the backlog, and health itself is
      // governed by lag, not by the walk.
      const midway = await readHealth({
        cursors: rig.cursors,
        deadLetters: rig.deadLetters,
        logger,
        host: '127.0.0.1',
        port: 0,
        tickMs: { SOL: 400, RH: 2_000, BASE: 2_000, ARC: 1_000 },
        maxLagSeconds: 30,
        mode: 'chain',
        isLeader: () => true,
        catchup: () => catchup.snapshot(),
        now,
      });
      const solMid = midway.chains.find((c) => c.net === 'SOL');
      expect(solMid?.catchupBacklog).toBeGreaterThan(0);
      expect(solMid?.catchupForSeconds).toBeGreaterThan(0);
      expect(renderPrometheus(midway)).toMatch(
        /stonkz_indexer_solana_catchup_backlog\{net="SOL"\} [1-9]\d*/,
      );
      expect(renderPrometheus(midway)).toMatch(/stonkz_indexer_catchup_for_seconds\{net="SOL"\} /);

      // The alert fired once, as `chain-lag` would, with the backlog attached.
      expect(alerts.filter((a) => a.key === 'solana-catchup-backlog:SOL')).toHaveLength(1);
      expect(alerts[0]?.severity).toBe('critical');
      expect(alerts[0]?.fields['remaining']).toBeGreaterThan(0);

      // Then drain to the head.
      for (let i = 0; i < 20 && !results.at(-1)?.caughtUp; i++) {
        results.push(...(await rig.runner.drainNet('SOL')));
      }

      expect(results.at(-1)?.caughtUp).toBe(true);
      expect(results.some((r) => r.skipped)).toBe(false);
      expect(results.some((r) => r.deferred)).toBe(false);
      expect(await rig.db.db.select().from(indexerDeadLetters)).toHaveLength(0);
      const events = await rig.db.db.select().from(chainEvents);
      expect(events).toHaveLength(1 + 400 * 2);
      expect(events.filter((e) => e.kind === 'TokenCreated')).toHaveLength(1);
      expect(events.filter((e) => e.kind === 'Trade')).toHaveLength(400);

      // Cursor monotonic across every pass, and every pass reported a backlog.
      for (let i = 1; i < results.length; i++) {
        expect(results[i]?.from).toBeGreaterThanOrEqual(results[i - 1]?.from ?? 0);
        expect(results[i]?.to).toBeGreaterThanOrEqual(results[i]?.from ?? 0);
      }
      expect(results.every((r) => r.backlog !== undefined)).toBe(true);
      expect(results.at(-1)?.backlog).toMatchObject({
        remaining: 0,
        located: true,
        partial: false,
      });
      expect((await rig.cursors.read('SOL')).position).toBe(head);
      expect((await rig.cursors.read('SOL')).failedAttempts).toBe(0);

      // The alert resolved and the backlog gauge is back to zero.
      expect(alerts.filter((a) => a.message.startsWith('RESOLVED:'))).toHaveLength(1);
      expect(catchup.snapshot().SOL).toMatchObject({ remaining: 0, since: null, alerting: false });

      // Progress was logged once per minute of clock, not once per pass: the
      // six spaced passes each logged, the burst inside one drain did not.
      const progress = lines.filter((l) => l.msg.startsWith('catch-up in progress'));
      expect(progress.length).toBeGreaterThanOrEqual(6);
      expect(progress.length).toBeLessThan(results.length);
      expect(lines.filter((l) => l.msg === 'catch-up complete')).toHaveLength(1);
    }
  });

  it('treats a legacy SolanaRangeTooBusyError as deferral, never as a failed attempt', async () => {
    const sol = new ScriptedSource({ net: 'SOL', head: 2_000, startPosition: 1_000 });
    const idle = (net: 'RH' | 'BASE' | 'ARC'): ScriptedSource =>
      new ScriptedSource({ net, head: 0, startPosition: 1 });
    const catchup = new CatchupMonitor({ logger, alertAfterMs: 0, logEveryMs: 0 });
    rig = await createIndexerRig([], {
      sources: { SOL: sol, RH: idle('RH'), BASE: idle('BASE'), ARC: idle('ARC') },
      deadLetters: true,
      maxBatchAttempts: 1,
      catchup,
    });

    sol.failFor(3, new SolanaRangeTooBusyError(999, 2_000, 20));
    for (let i = 0; i < 3; i++) {
      const pass = await rig.runner.pass('SOL');
      expect(pass.deferred).toBe(true);
      expect(pass.skipped).toBeUndefined();
      expect(pass.to).toBe(pass.from);
    }
    expect(await rig.db.db.select().from(indexerDeadLetters)).toHaveLength(0);
    const cursor = await rig.cursors.read('SOL');
    expect(cursor.failedAttempts).toBe(0);
    expect(cursor.position).toBe(0);
    expect(catchup.snapshot().SOL.passes).toBe(3);

    // A deferral ends the tick's burst for that chain rather than spinning.
    sol.failFor(1, new SolanaRangeTooBusyError(999, 2_000, 20));
    const burst = await rig.runner.drainNet('SOL');
    expect(burst).toHaveLength(1);
    expect(burst[0]?.deferred).toBe(true);

    // Once the source makes progress the chain carries on as normal.
    const next = await rig.runner.drainNet('SOL');
    expect(next.at(-1)?.caughtUp).toBe(true);
    expect(catchup.snapshot().SOL.since).toBeNull();
  });
});

describe('CatchupMonitor', () => {
  it('logs once per minute, alerts once after the threshold, and resolves once', () => {
    let clock = 0;
    const now = (): number => clock;
    const { logger: recording, lines } = recordingLogger(now);
    const alerts: Alert[] = [];
    const monitor = new CatchupMonitor({
      logger: recording,
      onAlert: (a) => alerts.push(a),
      alertAfterMs: 3 * 60_000,
      logEveryMs: 60_000,
      now,
    });
    const ctx = { from: 10, to: 20 };
    const busy = { remaining: 5_000, located: false, partial: true, pages: 10 };

    // Thirty passes inside one minute: one log line.
    for (let i = 0; i < 30; i++) {
      clock += 1_000;
      monitor.observe('SOL', busy, ctx);
    }
    expect(lines.filter((l) => l.msg.startsWith('catch-up in progress'))).toHaveLength(1);
    expect(alerts).toHaveLength(0);

    // A minute later, and another: a line each; then the alert at the
    // threshold (three minutes after the first observation), once.
    clock = 61_000;
    monitor.observe('SOL', busy, ctx);
    clock = 121_000;
    monitor.observe('SOL', busy, ctx);
    clock = 181_000;
    monitor.observe('SOL', { ...busy, located: true, remaining: 1_200 }, ctx);
    monitor.observe('SOL', { ...busy, located: true, remaining: 1_000 }, ctx);
    expect(lines.filter((l) => l.msg.startsWith('catch-up in progress'))).toHaveLength(4);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ key: 'solana-catchup-backlog:SOL', severity: 'critical' });
    expect(alerts[0]?.fields).toMatchObject({ net: 'SOL', remaining: 1_200, located: true });

    const snap = monitor.snapshot().SOL;
    expect(snap).toMatchObject({ remaining: 1_000, located: true, since: 1_000, alerting: true });
    expect(snap.passes).toBe(34);
    expect(snap.pages).toBe(340);
    // Other chains are untouched.
    expect(monitor.snapshot().RH).toMatchObject({ remaining: 0, since: null, alerting: false });

    // A complete pass with nothing left clears it, resolving the alert once.
    monitor.observe('SOL', { remaining: 0, located: true, partial: false, pages: 1 }, ctx);
    monitor.observe('SOL', { remaining: 0, located: true, partial: false, pages: 1 }, ctx);
    expect(alerts).toHaveLength(2);
    expect(alerts[1]?.message).toMatch(/^RESOLVED: SOL indexer catch-up backlog/);
    expect(lines.filter((l) => l.msg === 'catch-up complete')).toHaveLength(1);
    expect(monitor.snapshot().SOL).toMatchObject({ remaining: 0, since: null, alerting: false });
  });

  it('does not alert on a backlog that clears before the threshold', () => {
    let clock = 0;
    const alerts: Alert[] = [];
    const monitor = new CatchupMonitor({
      logger,
      onAlert: (a) => alerts.push(a),
      alertAfterMs: 10 * 60_000,
      now: () => clock,
    });
    const ctx = { from: 0, to: 1 };
    monitor.observe('SOL', { remaining: 300, located: true, partial: true, pages: 3 }, ctx);
    clock = 9 * 60_000;
    monitor.observe('SOL', { remaining: 100, located: true, partial: true, pages: 3 }, ctx);
    monitor.observe('SOL', { remaining: 0, located: true, partial: false, pages: 1 }, ctx);
    expect(alerts).toHaveLength(0);
    // A fresh backlog starts a fresh clock.
    clock = 20 * 60_000;
    monitor.observe('SOL', { remaining: 50, located: true, partial: true, pages: 1 }, ctx);
    expect(alerts).toHaveLength(0);
    expect(monitor.snapshot().SOL.since).toBe(20 * 60_000);
  });
});
