import { and, eq, sql } from 'drizzle-orm';
import { isEvm, laneOf, nativeUnit, type Net } from '@stonkz/shared';
import type { AppDeps } from '../app/context.js';
import { evmLaunchpadAddress, evmRouterAddress } from '../chain/evm-net.js';
import {
  decodeEvmTradeFills,
  decodeSolanaTradeFills,
  fillPayload,
  type DecodedTradeFill,
  type FillPayload,
  type FillTokenMeta,
} from '../chain/trade-fills.js';
import type {
  EvmBlockTimeSource,
  EvmTransactionReceipt,
  SolanaTransactionLogs,
} from '../chain/types.js';
import { tokens, trades } from '../db/schema.js';
import { ZERO_EVM_ADDRESS } from '../env.js';

/**
 * `POST /trade/confirm`'s provisional fills.
 *
 * **Why provisional state lives only in Redis/WS, never in the database.**
 * The indexer is the only writer of `trades`, `tape`, `candles`,
 * `holders_snapshot`, fee vaults and XP, and it writes them at its safe depth
 * (12 blocks on Base/RH, `finalized` on Solana), idempotently on
 * `(net, tx_sig, log_index)`. A provisional row in any of those tables would
 * need its own supersede path in every aggregate (volume, OHLC, holder counts,
 * fee legs, XP) *and* a second rollback path for a reorged-out transaction.
 * Publishing the fill to the WS lanes instead gives every open page the trade
 * within a block, while nothing is ever counted twice and a reorg has nothing
 * to undo server-side: the web replaces the print when the authoritative fill
 * with the same `fid` arrives, and re-reads REST if it never does.
 *
 * The one Redis key (`prov:fill:{net}:{sig}`, 15 min) only stops a retried
 * confirm from re-broadcasting the same fills.
 */
export type ProvisionalOutcome =
  | { kind: 'pending' }
  | { kind: 'reverted' }
  | { kind: 'ok'; fills: FillPayload[]; published: boolean; final: boolean };

const DEDUPE_TTL_SECONDS = 900;

function asEvmReceiptSource(
  rpc: unknown,
): { getTransactionReceipt(hash: string): Promise<EvmTransactionReceipt | null> } | null {
  const c = rpc as { getTransactionReceipt?: unknown };
  return typeof c.getTransactionReceipt === 'function'
    ? (rpc as { getTransactionReceipt(hash: string): Promise<EvmTransactionReceipt | null> })
    : null;
}

function asBlockTimeSource(rpc: unknown): EvmBlockTimeSource | null {
  const c = rpc as { getBlockTimestampMs?: unknown };
  return typeof c.getBlockTimestampMs === 'function' ? (rpc as EvmBlockTimeSource) : null;
}

function asSolanaLogsSource(
  rpc: unknown,
): { getTransactionLogs(sig: string): Promise<SolanaTransactionLogs | null> } | null {
  const c = rpc as { getTransactionLogs?: unknown };
  return typeof c.getTransactionLogs === 'function'
    ? (rpc as { getTransactionLogs(sig: string): Promise<SolanaTransactionLogs | null> })
    : null;
}

interface Decoded {
  fills: DecodedTradeFill[];
  blockTimeMs: number;
  /** Indexer form: lowercased on EVM, verbatim on Solana. */
  sig: string;
}

async function decodeEvm(
  deps: AppDeps,
  net: Net,
  hash: string,
): Promise<Decoded | 'pending' | 'reverted'> {
  if (!isEvm(net)) return 'pending';
  const rpc = deps.rpcs[net];
  const source = asEvmReceiptSource(rpc);
  if (!source) return { fills: [], blockTimeMs: deps.now(), sig: hash.toLowerCase() };
  const receipt = await source.getTransactionReceipt(hash);
  if (!receipt) return 'pending';
  if (receipt.status !== 'success') return 'reverted';
  const launchpad = evmLaunchpadAddress(deps.env, net);
  if (!launchpad || launchpad.toLowerCase() === ZERO_EVM_ADDRESS) {
    return { fills: [], blockTimeMs: deps.now(), sig: hash.toLowerCase() };
  }
  const router = evmRouterAddress(deps.env, net);
  const fills = decodeEvmTradeFills(receipt.logs, {
    launchpad,
    routers: router && router.toLowerCase() !== ZERO_EVM_ADDRESS ? [router] : [],
  });
  let blockTimeMs: number | null = null;
  const clock = asBlockTimeSource(rpc);
  if (fills.length > 0 && clock && typeof receipt.blockNumber === 'number') {
    blockTimeMs = await clock.getBlockTimestampMs(receipt.blockNumber).catch(() => null);
  }
  return { fills, blockTimeMs: blockTimeMs ?? deps.now(), sig: hash.toLowerCase() };
}

async function decodeSol(deps: AppDeps, sig: string): Promise<Decoded | 'pending' | 'reverted'> {
  const source = asSolanaLogsSource(deps.rpcs.SOL);
  if (!source) return { fills: [], blockTimeMs: deps.now(), sig };
  const tx = await source.getTransactionLogs(sig);
  if (!tx) return 'pending';
  if (tx.failed) return 'reverted';
  const programId = deps.env.solanaLaunchpadProgramId;
  if (!programId) return { fills: [], blockTimeMs: deps.now(), sig };
  return {
    fills: decodeSolanaTradeFills(tx, programId),
    blockTimeMs: tx.blockTimeMs ?? deps.now(),
    sig,
  };
}

interface MetaRow extends FillTokenMeta {
  lane: string;
}

async function tokenMeta(deps: AppDeps, net: Net, mint: string): Promise<MetaRow | null> {
  const [row] = await deps.db
    .select()
    .from(tokens)
    .where(
      and(
        eq(tokens.net, net),
        net === 'SOL' ? eq(tokens.mint, mint) : sql`lower(${tokens.mint}) = ${mint.toLowerCase()}`,
      ),
    )
    .limit(1);
  // Same refusal as the indexer's `TokenRegistry.resolve`: a row without the
  // launch's curve constants cannot price a fill.
  if (!row || !row.basePriceUsd1e6 || row.basePriceUsd1e6 === '0') return null;
  const tokenDecimals = row.tokenDecimals || (net === 'SOL' ? 6 : 18);
  return {
    mint: row.mint,
    sym: row.sym,
    baseMint: row.baseMint,
    baseDecimals: row.baseDecimals,
    tokenDecimals,
    basePrice1e6: BigInt(row.basePriceUsd1e6),
    supplyAtoms: BigInt(Math.round(row.supply * 10 ** tokenDecimals)),
    lane: row.lane,
  };
}

/**
 * Decode the fills `proof` settled and, the first time this transaction is
 * confirmed and before the indexer has recorded it, publish them to the
 * `token:{sym}` and `tape` lanes marked `provisional`, plus a `curve` update
 * carrying the post-fill market cap.
 */
export async function confirmTradeFills(
  deps: AppDeps,
  net: Net,
  proof: string,
): Promise<ProvisionalOutcome> {
  const decoded = isEvm(net) ? await decodeEvm(deps, net, proof) : await decodeSol(deps, proof);
  if (decoded === 'pending') return { kind: 'pending' };
  if (decoded === 'reverted') return { kind: 'reverted' };
  if (decoded.fills.length === 0) return { kind: 'ok', fills: [], published: false, final: false };

  const metas = new Map<string, MetaRow | null>();
  let nativeUsdPrice: number | null = null;
  const out: { payload: FillPayload; lane: string }[] = [];
  for (const fill of decoded.fills) {
    const key = net === 'SOL' ? fill.mint : fill.mint.toLowerCase();
    if (!metas.has(key)) metas.set(key, await tokenMeta(deps, net, fill.mint));
    const meta = metas.get(key);
    if (!meta) continue; // Not one of ours (or no curve constants yet).
    if (nativeUsdPrice === null) {
      nativeUsdPrice = await deps.oracle.nativeUsd(nativeUnit(net)).catch(() => 0);
    }
    out.push({
      payload: fillPayload(fill, meta, {
        net,
        txSig: decoded.sig,
        blockTimeMs: decoded.blockTimeMs,
        nativeUsdPrice,
      }),
      lane: meta.lane,
    });
  }
  const fills = out.map((o) => o.payload);
  if (fills.length === 0) return { kind: 'ok', fills, published: false, final: false };

  // The indexer already has it: its own `fill` frames went out, nothing to add.
  const [recorded] = await deps.db
    .select({ id: trades.id })
    .from(trades)
    .where(and(eq(trades.net, net), eq(trades.txSig, decoded.sig)))
    .limit(1);
  if (recorded) return { kind: 'ok', fills, published: false, final: true };

  const first = await deps.redis.set(`prov:fill:${net}:${decoded.sig}`, '1', {
    ttlSeconds: DEDUPE_TTL_SECONDS,
    ifNotExists: true,
  });
  if (!first) return { kind: 'ok', fills, published: false, final: false };

  const lastBySym = new Map<string, { payload: FillPayload; lane: string }>();
  for (const o of out) {
    const provisional: FillPayload = { ...o.payload, provisional: true };
    await deps.publisher.fill(net, o.payload.sym, provisional, o.payload.mint);
    lastBySym.set(o.payload.sym, o);
  }
  for (const { payload, lane } of lastBySym.values()) {
    await deps.publisher.token(payload.sym, {
      type: 'curve',
      net,
      sym: payload.sym,
      mint: payload.mint,
      mc: payload.mc,
      price: payload.tok > 0 ? payload.v / payload.tok : 0,
      mcBase: payload.mcBase,
      priceBase: payload.priceBase,
      // A graduated token stays graduated, as in `Ingestor.updateToken`. The
      // lane reads the snapshot-priced cap: base-proportional, like the chain.
      lane: lane === 'grad' ? 'grad' : laneOf({ mc: payload.mc }),
      provisional: true,
    });
  }
  return { kind: 'ok', fills, published: true, final: false };
}
