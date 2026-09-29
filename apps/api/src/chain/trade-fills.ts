import { decodeEventLog, getAddress, type Abi, type Hex } from 'viem';
import { mcapBase, mcapUsd1e6 } from '@stonkz/curve-sim';
import type { Net } from '@stonkz/shared';
import {
  AnchorEventCoder,
  cpiEventPayloads,
  programDataPayloads,
  type EventLayout,
} from './events/anchor.js';
import type { BorshReader } from './events/borsh.js';
import type { EvmLog, SolanaTransactionLogs } from './types.js';

/**
 * `POST /trade/confirm`'s fast path: the fills one confirmed transaction
 * settled, decoded straight from its receipt / logs so the token page, the
 * tape and the board move within a block instead of after the indexer's
 * confirmation depth (12 blocks on Base/RH, `finalized` on Solana).
 *
 * Nothing here writes a read table. The indexer stays the only writer of
 * `trades` / `candles` / `holders_snapshot` / fees / XP, at its safe depth, and
 * the provisional fill is a WS print the web replaces when the authoritative
 * one lands (same `fid`). See `routes/trade.ts`.
 *
 * The numbers are the indexer's, computed the same way:
 * `apps/indexer/src/chain/{evm,solana}-map.ts` + `market.ts`. The event
 * fragments below are the `Trade` / `AtomicBuy` / `AtomicSell` entries of the
 * indexer's `evm-events.ts` and the `Trade` layout of its `solana-events.ts`;
 * `apps/indexer/src/chain/trade-fills-parity.test.ts` decodes the same fixture
 * logs through both and fails on any divergence.
 */

/* ------------------------------------------------------------------ EVM */

export const TRADE_FILL_EVENTS_ABI = [
  {
    type: 'event',
    name: 'Trade',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'trader', type: 'address', indexed: true },
      { name: 'isBuy', type: 'bool', indexed: false },
      { name: 'baseAmount', type: 'uint256', indexed: false },
      { name: 'tokenAmount', type: 'uint256', indexed: false },
      { name: 'effFeeBps', type: 'uint16', indexed: false },
      { name: 'inCashback', type: 'bool', indexed: false },
      { name: 'feeTotal', type: 'uint256', indexed: false },
      { name: 'feeProtocol', type: 'uint256', indexed: false },
      { name: 'feeOps', type: 'uint256', indexed: false },
      { name: 'feeBurn', type: 'uint256', indexed: false },
      { name: 'feeCreatorBucket', type: 'uint256', indexed: false },
      { name: 'feeStakers', type: 'uint256', indexed: false },
      { name: 'feeCreator', type: 'uint256', indexed: false },
      { name: 'cashbackTokens', type: 'uint256', indexed: false },
      { name: 'virtualBase', type: 'uint256', indexed: false },
      { name: 'virtualToken', type: 'uint256', indexed: false },
      { name: 'realBase', type: 'uint256', indexed: false },
      { name: 'realToken', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'AtomicBuy',
    inputs: [
      { name: 'trader', type: 'address', indexed: true },
      { name: 'token', type: 'address', indexed: true },
      { name: 'ethIn', type: 'uint256', indexed: false },
      { name: 'baseFromAggregator', type: 'uint256', indexed: false },
      { name: 'tokensOut', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'AtomicSell',
    inputs: [
      { name: 'trader', type: 'address', indexed: true },
      { name: 'token', type: 'address', indexed: true },
      { name: 'tokensIn', type: 'uint256', indexed: false },
      { name: 'baseFromCurve', type: 'uint256', indexed: false },
      { name: 'ethOut', type: 'uint256', indexed: false },
    ],
  },
] as const satisfies Abi;

/** One launchpad `Trade`, with the router leg that belongs to it (if any). */
export interface DecodedTradeFill {
  /**
   * Position among this transaction's `Trade` events, in log order. With the
   * transaction id it is the fill id (`fid`) the indexer derives too, so the
   * web can supersede this provisional print with the authoritative one.
   */
  ordinal: number;
  /** EVM block log index; `null` on Solana, whose indexer log index is synthetic. */
  logIndex: number | null;
  mint: string;
  trader: string;
  isBuy: boolean;
  baseAmount: bigint;
  tokenAmount: bigint;
  inCashback: boolean;
  virtualBase: bigint;
  virtualToken: bigint;
  realBase: bigint;
  realToken: bigint;
  /** Exact native leg from `StonkzRouter` (wei), EVM only. */
  router: RouterLeg | null;
}

export type RouterLeg =
  | { kind: 'AtomicBuy'; ethIn: bigint; baseFromAggregator: bigint }
  | { kind: 'AtomicSell'; ethOut: bigint };

interface DecodedLog {
  name: 'Trade' | 'AtomicBuy' | 'AtomicSell';
  args: Record<string, unknown>;
  logIndex: number | null;
}

function checksum(value: unknown): string {
  if (typeof value !== 'string') throw new Error(`not an address: ${JSON.stringify(value)}`);
  try {
    return getAddress(value);
  } catch {
    return value.toLowerCase();
  }
}

function uint(args: Record<string, unknown>, key: string): bigint {
  const v = args[key];
  if (typeof v === 'bigint') return v;
  throw new Error(`log field ${key} is not a uint`);
}

function logIndexOf(log: EvmLog): number | null {
  const raw = log.logIndex;
  if (raw === undefined || raw === null) return null;
  const n = typeof raw === 'number' ? raw : Number(BigInt(raw));
  return Number.isFinite(n) ? n : null;
}

/**
 * The launchpad fills a receipt carries.
 *
 * Emitters are checked strictly, exactly like the indexer's
 * `groupByTransaction`: a `Trade` only counts from the launchpad and an
 * `AtomicBuy`/`AtomicSell` only from a configured router. The ABI is public —
 * any contract can emit a byte-identical `Trade` in a transaction the caller
 * then posts here — so topic0 alone proves nothing.
 */
export function decodeEvmTradeFills(
  logs: readonly EvmLog[],
  emitters: { launchpad: string; routers: readonly string[] },
): DecodedTradeFill[] {
  const launchpad = emitters.launchpad.toLowerCase();
  const routers = emitters.routers.map((r) => r.toLowerCase());
  const decoded: DecodedLog[] = [];
  for (const log of logs) {
    if (!log.topics || log.topics.length === 0) continue;
    let name: DecodedLog['name'];
    let args: Record<string, unknown>;
    try {
      const d = decodeEventLog({
        abi: TRADE_FILL_EVENTS_ABI,
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data as Hex,
      });
      name = d.eventName;
      args = d.args as Record<string, unknown>;
    } catch {
      continue; // ERC-20 Transfer, FeeAccrued, … — not a fill leg.
    }
    const from = log.address.toLowerCase();
    const allowed = name === 'Trade' ? from === launchpad : routers.includes(from);
    if (!allowed) continue;
    decoded.push({ name, args, logIndex: logIndexOf(log) });
  }
  // Receipts list logs in block order already; sort defensively when the
  // node reported indices, so the router pairing below stays positional.
  if (decoded.every((d) => d.logIndex !== null)) {
    decoded.sort((a, b) => (a.logIndex as number) - (b.logIndex as number));
  }

  const out: DecodedTradeFill[] = [];
  for (const [index, entry] of decoded.entries()) {
    if (entry.name !== 'Trade') continue;
    const a = entry.args;
    const mint = checksum(a['token']);
    const isBuy = a['isBuy'] === true;
    const router = routerLegFor(decoded, index, mint, isBuy);
    out.push({
      ordinal: out.length,
      logIndex: entry.logIndex,
      mint,
      // Routed fills call the launchpad from StonkzRouter, so Trade.trader is
      // the router; the router event names the wallet (as `evm-map.ts` does).
      trader: router ? router.trader : checksum(a['trader']),
      isBuy,
      baseAmount: uint(a, 'baseAmount'),
      tokenAmount: uint(a, 'tokenAmount'),
      inCashback: a['inCashback'] === true,
      virtualBase: uint(a, 'virtualBase'),
      virtualToken: uint(a, 'virtualToken'),
      realBase: uint(a, 'realBase'),
      realToken: uint(a, 'realToken'),
      router: router?.leg ?? null,
    });
  }
  return out;
}

/** `evm-map.ts`'s `routerLogFor`: the first matching router log after the `Trade`, before the next one. */
function routerLegFor(
  logs: readonly DecodedLog[],
  index: number,
  token: string,
  isBuy: boolean,
): { trader: string; leg: RouterLeg } | null {
  const wanted = isBuy ? 'AtomicBuy' : 'AtomicSell';
  for (let i = index + 1; i < logs.length; i++) {
    const e = logs[i];
    if (!e) continue;
    if (e.name === 'Trade' && checksum(e.args['token']) === token) return null;
    if (e.name !== wanted) continue;
    if (checksum(e.args['token']) !== token) continue;
    const trader = checksum(e.args['trader']);
    return e.name === 'AtomicBuy'
      ? {
          trader,
          leg: {
            kind: 'AtomicBuy',
            ethIn: uint(e.args, 'ethIn'),
            baseFromAggregator: uint(e.args, 'baseFromAggregator'),
          },
        }
      : { trader, leg: { kind: 'AtomicSell', ethOut: uint(e.args, 'ethOut') } };
  }
  return null;
}

/* --------------------------------------------------------------- Solana */

interface SolTradeRecord {
  mint: string;
  trader: string;
  isBuy: boolean;
  baseAmount: bigint;
  tokenAmount: bigint;
  inCashback: boolean;
  virtualBase: bigint;
  virtualToken: bigint;
  realBase: bigint;
  realToken: bigint;
}

/** `solana-events.ts`'s `Trade` layout — field order is the wire format. */
export const SOL_TRADE_LAYOUT: EventLayout<SolTradeRecord> = {
  name: 'Trade',
  read: (r: BorshReader): SolTradeRecord => {
    const mint = r.pubkey();
    const trader = r.pubkey();
    const isBuy = r.bool();
    const baseAmount = r.u64();
    const tokenAmount = r.u64();
    r.u16(); // effFeeBps
    const inCashback = r.bool();
    for (let i = 0; i < 8; i++) r.u64(); // feeTotal … cashbackTokens
    const virtualBase = r.u128();
    const virtualToken = r.u128();
    const realBase = r.u64();
    const realToken = r.u64();
    r.u64(); // circulating
    r.i64(); // ts
    return {
      mint,
      trader,
      isBuy,
      baseAmount,
      tokenAmount,
      inCashback,
      virtualBase,
      virtualToken,
      realBase,
      realToken,
    };
  },
};

const solTradeCoder = new AnchorEventCoder<SolTradeRecord>([SOL_TRADE_LAYOUT]);

function safeDecode(fn: () => { data: SolTradeRecord } | null): SolTradeRecord | null {
  try {
    return fn()?.data ?? null;
  } catch {
    return null; // A truncated / mis-sized body is not a fill we can show.
  }
}

/**
 * The launchpad `Trade`s in one Solana transaction, in the order the indexer
 * decodes them (`Program data:` lines, then `emit_cpi!` inner instructions),
 * attributed to `programId` by the same invoke-stack walk.
 */
export function decodeSolanaTradeFills(
  tx: SolanaTransactionLogs,
  programId: string,
): DecodedTradeFill[] {
  const records: SolTradeRecord[] = [];
  for (const payload of programDataPayloads(tx.logMessages, programId)) {
    const r = safeDecode(() => solTradeCoder.decode(payload));
    if (r) records.push(r);
  }
  if (tx.innerInstructions.length > 0) {
    for (const bytes of cpiEventPayloads(tx.innerInstructions, tx.accountKeys, programId)) {
      const r = safeDecode(() => solTradeCoder.decodeCpiBytes(bytes));
      if (r) records.push(r);
    }
  }
  return records.map((r, ordinal) => ({ ordinal, logIndex: null, router: null, ...r }));
}

/* ----------------------------------------------------------- fill math */

/** What a fill needs from the `tokens` row — `TokenRegistry.resolve`'s fields. */
export interface FillTokenMeta {
  mint: string;
  sym: string;
  baseMint: string;
  baseDecimals: number;
  tokenDecimals: number;
  basePrice1e6: bigint;
  supplyAtoms: bigint;
}

/** `market.ts`'s `NATIVE_BASE_MINTS`; the parity test pins the two together. */
export const NATIVE_BASE_MINTS: Record<Net, readonly string[]> = {
  SOL: ['So11111111111111111111111111111111111111112'],
  RH: [
    '0x0000000000000000000000000000000000000000',
    '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
    '0x7943e237c7f95da44e0301572d358911207852fa',
  ],
  BASE: [
    '0x0000000000000000000000000000000000000000',
    '0x4200000000000000000000000000000000000006',
  ],
  ARC: ['0x0000000000000000000000000000000000000000'],
};

const NATIVE_DECIMALS = 18;

function isNativeBase(net: Net, baseMint: string): boolean {
  return NATIVE_BASE_MINTS[net].includes(net === 'SOL' ? baseMint : baseMint.toLowerCase());
}

function whole(atoms: bigint, decimals: number): number {
  return Number(atoms) / 10 ** decimals;
}

/** The WS `fill` payload — the indexer's shape plus the fields a provisional print needs. */
export interface FillPayload {
  t: number;
  sym: string;
  net: Net;
  mint: string;
  buy: boolean;
  sol: number;
  tok: number;
  /** Cap after the fill, USD at the launch snapshot price (base-proportional). */
  mc: number;
  /** Cap after the fill in whole base units — what a client marks at its live base price. */
  mcBase: number;
  /** Base per token after the fill. */
  priceBase: number;
  w: string;
  v: number;
  cb: boolean;
  sig: string;
  /** `${sig}:${ordinal}` — identical for the provisional and the authoritative print. */
  fid: string;
  /** Present and true only on the fast-path print. */
  provisional?: true;
}

/**
 * Stable fill id shared by `/trade/confirm` and the indexer. `txSig` must
 * already be in the indexer's form: lowercased on EVM, verbatim (base58 is
 * case-sensitive) on Solana.
 */
export function fillId(txSig: string, ordinal: number): string {
  return `${txSig}:${ordinal}`;
}

export function fillPayload(
  fill: DecodedTradeFill,
  meta: FillTokenMeta,
  ctx: { net: Net; txSig: string; blockTimeMs: number; nativeUsdPrice: number },
): FillPayload {
  const usdValue = Number(mcapUsd1e6(fill.baseAmount, meta.basePrice1e6, meta.baseDecimals)) / 1e6;
  const nativeBase = isNativeBase(ctx.net, meta.baseMint);
  let sol: number;
  if (fill.router && !nativeBase) {
    if (fill.router.kind === 'AtomicSell') {
      sol = whole(fill.router.ethOut, NATIVE_DECIMALS);
    } else {
      const { ethIn, baseFromAggregator } = fill.router;
      const wei =
        baseFromAggregator > 0n && fill.baseAmount < baseFromAggregator
          ? (ethIn * fill.baseAmount) / baseFromAggregator
          : ethIn;
      sol = whole(wei, NATIVE_DECIMALS);
    }
  } else if (nativeBase) {
    sol = whole(fill.baseAmount, meta.baseDecimals);
  } else {
    sol = ctx.nativeUsdPrice > 0 ? usdValue / ctx.nativeUsdPrice : 0;
  }
  const mcBaseAtoms =
    fill.virtualToken > 0n
      ? mcapBase(
          {
            virtualBase: fill.virtualBase,
            virtualToken: fill.virtualToken,
            realBase: 0n,
            realToken: 0n,
            k: fill.virtualBase * fill.virtualToken,
          },
          meta.supplyAtoms,
        )
      : 0n;
  const mc =
    mcBaseAtoms > 0n
      ? Number(mcapUsd1e6(mcBaseAtoms, meta.basePrice1e6, meta.baseDecimals)) / 1e6
      : 0;
  const mcBase = mcBaseAtoms > 0n ? whole(mcBaseAtoms, meta.baseDecimals) : 0;
  const supplyWhole = whole(meta.supplyAtoms, meta.tokenDecimals);
  // EVM hashes are lowercased everywhere the indexer stores them.
  const sig = ctx.net === 'SOL' ? ctx.txSig : ctx.txSig.toLowerCase();
  return {
    t: ctx.blockTimeMs,
    sym: meta.sym,
    net: ctx.net,
    mint: meta.mint,
    buy: fill.isBuy,
    sol,
    tok: whole(fill.tokenAmount, meta.tokenDecimals),
    mc,
    mcBase,
    priceBase: supplyWhole > 0 ? mcBase / supplyWhole : 0,
    w: fill.trader,
    v: usdValue,
    cb: fill.inCashback,
    sig,
    fid: fillId(sig, fill.ordinal),
  };
}
