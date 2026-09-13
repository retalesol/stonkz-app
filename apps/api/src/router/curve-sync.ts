/**
 * Refresh bonding-curve reserves from chain before quote/prepare.
 *
 * DB columns are a cache (indexer / last confirm). Sells fail with a misleading
 * `no route TOKEN → BASE` when `realBase` is still 0 after an on-chain buy.
 * Always prefer an on-chain read; persist best-effort for board/mc speed.
 */
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { and, eq } from 'drizzle-orm';
import { mcapBase, mcapUsd1e6 } from '@stonkz/curve-sim';
import { encodeFunctionData, type Address, type Hex } from 'viem';
import type { Db } from '../db/client.js';
import { tokens } from '../db/schema.js';
import { derivePdas } from './solana-idl.js';
import { hasCurveState, liveCurveState, type CurveStateRow } from './curve-state.js';
import { laneOf } from '@stonkz/shared';

export interface EthCaller {
  ethCall(to: string, data: string): Promise<string>;
}

export interface SolanaAccountSource {
  getAccountDataBase64(address: string): Promise<string | null>;
}

export type CurveSyncRow = CurveStateRow & {
  net: string;
  sym: string;
  mint: string | null;
  baseMint: string;
  baseSymbol: string;
  name: string;
  graduatedAt: Date | null;
  supply?: number;
  mc?: number;
  lane?: string | null;
};

export interface CurveReserves {
  realBase: string;
  realToken: string;
}

const ZERO = '0x0000000000000000000000000000000000000000';

const COINS_ABI = [
  {
    type: 'function',
    name: 'coins',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [
      { name: 'token', type: 'address' },
      { name: 'baseToken', type: 'address' },
      { name: 'creator', type: 'address' },
      { name: 'baseDecimals', type: 'uint8' },
      { name: 'feeBps', type: 'uint16' },
      { name: 'cashback', type: 'bool' },
      { name: 'complete', type: 'bool' },
      { name: 'graduated', type: 'bool' },
      { name: 'graduationReason', type: 'uint8' },
      { name: 'cbStart', type: 'uint64' },
      { name: 'graduatedAt', type: 'uint64' },
      { name: 'supply', type: 'uint256' },
      { name: 'virtualBase', type: 'uint256' },
      { name: 'virtualToken', type: 'uint256' },
      { name: 'realBase', type: 'uint256' },
      { name: 'realToken', type: 'uint256' },
      { name: 'k', type: 'uint256' },
      { name: 'tokensForSale', type: 'uint256' },
      { name: 'lpReserve', type: 'uint256' },
      { name: 'gradMcapBase', type: 'uint256' },
      { name: 'creationPrice1e6', type: 'uint256' },
      { name: 'protocolAccrued', type: 'uint256' },
      { name: 'opsAccrued', type: 'uint256' },
      { name: 'creatorBucketAccrued', type: 'uint256' },
      { name: 'creatorClaimableBase', type: 'uint256' },
      { name: 'creatorClaimableToken', type: 'uint256' },
      { name: 'bucketBase', type: 'uint256' },
      { name: 'bucketToken', type: 'uint256' },
      { name: 'eligibleStaked', type: 'uint256' },
      { name: 'flexStaked', type: 'uint256' },
      { name: 'totalWeight', type: 'uint256' },
      { name: 'accBasePerWeight', type: 'uint256' },
      { name: 'accTokenPerWeight', type: 'uint256' },
      { name: 'poolDustBase', type: 'uint256' },
      { name: 'poolDustToken', type: 'uint256' },
      { name: 'stakerAccruedBase', type: 'uint256' },
      { name: 'stakerAccruedToken', type: 'uint256' },
    ],
  },
] as const;

export const COINS_REAL_BASE_WORD = 14;
export const COINS_REAL_TOKEN_WORD = 15;

/** Anchor `account:Curve` discriminator. */
export const CURVE_ACCOUNT_DISC = createHash('sha256').update('account:Curve').digest().subarray(0, 8);

export function parseCoinsReserves(raw: string): CurveReserves | null {
  const hex = (raw.startsWith('0x') ? raw.slice(2) : raw).toLowerCase();
  if (hex.length < (COINS_REAL_TOKEN_WORD + 1) * 64) return null;
  const word = (i: number): bigint => BigInt(`0x${hex.slice(i * 64, i * 64 + 64)}`);
  if (word(0) === 0n) return null;
  return {
    realBase: word(COINS_REAL_BASE_WORD).toString(),
    realToken: word(COINS_REAL_TOKEN_WORD).toString(),
  };
}

export async function fetchRhCurveReserves(
  eth: EthCaller,
  launchpad: string,
  mint: string,
): Promise<CurveReserves | null> {
  if (!launchpad || launchpad.toLowerCase() === ZERO) return null;
  if (!mint || !mint.startsWith('0x') || mint.length !== 42) return null;
  const data = encodeFunctionData({
    abi: COINS_ABI,
    functionName: 'coins',
    args: [mint as Address],
  });
  try {
    const raw = await eth.ethCall(launchpad, data);
    return parseCoinsReserves(raw as Hex);
  } catch {
    return null;
  }
}

/** Minimal Borsh cursor for Curve account fields through real_token. */
export function decodeSolanaCurveReserves(data: Buffer): CurveReserves | null {
  if (data.length < 8 + 1 + 32 * 3 + 4) return null;
  if (!data.subarray(0, 8).equals(CURVE_ACCOUNT_DISC)) return null;
  let o = 8;
  o += 1; // bump
  o += 32 * 3; // mint, base_mint, creator
  if (o + 4 > data.length) return null;
  const tickerLen = data.readUInt32LE(o);
  o += 4 + tickerLen;
  o += 8; // supply
  o += 1 + 1 + 2 + 1 + 8; // decimals, base_decimals, fee_bps, cashback, cb_start
  o += 16 + 16; // virtual_base, virtual_token
  if (o + 16 > data.length) return null;
  const realBase = data.readBigUInt64LE(o);
  const realToken = data.readBigUInt64LE(o + 8);
  return { realBase: realBase.toString(), realToken: realToken.toString() };
}

export async function fetchSolCurveReserves(opts: {
  rpc: SolanaAccountSource;
  programId: string;
  mint: string;
  baseMint: string;
}): Promise<CurveReserves | null> {
  const { rpc, programId, mint, baseMint } = opts;
  if (!mint || !baseMint || !programId) return null;
  try {
    const pdas = derivePdas(new PublicKey(programId), new PublicKey(mint), new PublicKey(baseMint));
    const b64 = await rpc.getAccountDataBase64(pdas.curve.toBase58());
    if (!b64) return null;
    return decodeSolanaCurveReserves(Buffer.from(b64, 'base64'));
  } catch {
    return null;
  }
}

function mcUsdFromRow(row: CurveSyncRow): number | null {
  if (!hasCurveState(row) || row.supply === undefined) return null;
  try {
    const state = liveCurveState(row);
    const supplyAtoms = BigInt(Math.round(row.supply)) * 10n ** BigInt(row.tokenDecimals);
    const base = mcapBase(state, supplyAtoms);
    const usd1e6 = mcapUsd1e6(base, BigInt(row.basePriceUsd1e6 || '0'), row.baseDecimals);
    const usd = Number(usd1e6) / 1e6;
    return Number.isFinite(usd) && usd > 0 ? usd : null;
  } catch {
    return null;
  }
}

async function persistReserves<T extends CurveSyncRow>(
  db: Db,
  row: T,
  live: CurveReserves,
): Promise<T> {
  const next = {
    ...row,
    curveRealBase: live.realBase,
    curveRealToken: live.realToken,
  } as T;

  const mc = mcUsdFromRow(next);
  const patch: {
    curveRealBase: string;
    curveRealToken: string;
    updatedAt: Date;
    mc?: number;
    lastMc?: number;
    lane?: string;
  } = {
    curveRealBase: live.realBase,
    curveRealToken: live.realToken,
    updatedAt: new Date(),
  };
  if (mc !== null) {
    patch.lastMc = typeof row.mc === 'number' && row.mc > 0 ? row.mc : mc;
    patch.mc = mc;
    if (row.lane !== 'grad') patch.lane = laneOf({ mc });
    (next as CurveSyncRow).mc = mc;
    if (patch.lane) (next as CurveSyncRow).lane = patch.lane;
  }

  try {
    await db
      .update(tokens)
      .set(patch)
      .where(and(eq(tokens.net, row.net), eq(tokens.sym, row.sym)));
  } catch {
    // Quote with live numbers even if persistence blips.
  }
  return next;
}

/** @deprecated Prefer `syncCurveReserves`. Kept for existing imports/tests. */
export async function syncRhCurveReserves<T extends CurveSyncRow>(opts: {
  db: Db;
  eth: EthCaller | undefined;
  launchpad: string;
  row: T;
}): Promise<T> {
  return syncCurveReserves({
    db: opts.db,
    row: opts.row,
    rh: { eth: opts.eth, launchpad: opts.launchpad },
  });
}

export async function syncCurveReserves<T extends CurveSyncRow>(opts: {
  db: Db;
  row: T;
  rh?: { eth: EthCaller | undefined; launchpad: string };
  sol?: { rpc: SolanaAccountSource | undefined; programId: string };
}): Promise<T> {
  const { db, row } = opts;
  if (!hasCurveState(row) || !row.mint) return row;

  let live: CurveReserves | null = null;
  if (row.net === 'RH' && opts.rh?.eth) {
    live = await fetchRhCurveReserves(opts.rh.eth, opts.rh.launchpad, row.mint);
  } else if (row.net === 'SOL' && opts.sol?.rpc && row.baseMint) {
    live = await fetchSolCurveReserves({
      rpc: opts.sol.rpc,
      programId: opts.sol.programId,
      mint: row.mint,
      baseMint: row.baseMint,
    });
  }
  if (!live) return row;
  if (live.realBase === row.curveRealBase && live.realToken === row.curveRealToken) return row;
  return persistReserves(db, row, live);
}

export function reserveFingerprint(row: Pick<CurveStateRow, 'curveRealBase' | 'curveRealToken'>): string {
  return `${row.curveRealBase}-${row.curveRealToken}`;
}
