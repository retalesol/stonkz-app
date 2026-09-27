import bs58 from 'bs58';
import { eventDiscriminator, EVENT_IX_TAG, PROGRAM_DATA_PREFIX } from '../chain/anchor.js';
import type {
  SolanaTransaction,
  SignatureInfo,
  SolanaIndexRpc,
  SignaturePage,
  Commitment,
} from '../chain/solana-rpc.js';

/**
 * A Borsh **writer**, and encoders for each of the launchpad's `#[event]`
 * structs, used to build realistic RPC payloads for the decoder tests.
 *
 * This is the honest version of "captured fixtures": there is no deployed
 * program and no funded chain access, so nothing here was recorded off a live
 * cluster. What it is instead is a second, independent transcription of
 * `programs/solana/programs/launchpad/src/events.rs` — encoder here, decoder
 * in `chain/solana-events.ts` — so a test that round-trips through both only
 * passes when both agree with the Rust declaration. The event discriminators
 * are additionally pinned to literal bytes in `chain/solana-events.test.ts`,
 * which is what catches a *renamed* event that both sides would otherwise
 * agree about.
 */
export class BorshWriter {
  private readonly parts: Buffer[] = [];

  u8(n: number): this {
    return this.push(Buffer.from([n]));
  }

  bool(b: boolean): this {
    return this.u8(b ? 1 : 0);
  }

  u16(n: number): this {
    const buf = Buffer.alloc(2);
    buf.writeUInt16LE(n, 0);
    return this.push(buf);
  }

  u32(n: number): this {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(n, 0);
    return this.push(buf);
  }

  u64(n: bigint): this {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(n, 0);
    return this.push(buf);
  }

  i64(n: bigint): this {
    const buf = Buffer.alloc(8);
    buf.writeBigInt64LE(n, 0);
    return this.push(buf);
  }

  u128(n: bigint): this {
    return this.u64(n & 0xffff_ffff_ffff_ffffn).u64(n >> 64n);
  }

  pubkey(base58: string): this {
    const raw = Buffer.from(bs58.decode(base58));
    if (raw.length !== 32) throw new Error(`pubkey ${base58} is ${raw.length} bytes, not 32`);
    return this.push(raw);
  }

  string(s: string): this {
    const body = Buffer.from(s, 'utf8');
    return this.u32(body.length).push(body);
  }

  private push(buf: Buffer): this {
    this.parts.push(buf);
    return this;
  }

  done(): Buffer {
    return Buffer.concat(this.parts);
  }
}

/** `emit!` framing: discriminator, then the Borsh body. */
export function emitPayload(eventName: string, body: Buffer): Buffer {
  return Buffer.concat([eventDiscriminator(eventName), body]);
}

/** `emit_cpi!` framing: Anchor's fixed tag, then the same pair. */
export function emitCpiPayload(eventName: string, body: Buffer): Buffer {
  return Buffer.concat([EVENT_IX_TAG, emitPayload(eventName, body)]);
}

/** The `Program data: <base64>` line the RPC surfaces for an `emit!`. */
export function programDataLine(eventName: string, body: Buffer): string {
  return `${PROGRAM_DATA_PREFIX}${emitPayload(eventName, body).toString('base64')}`;
}

/* ------------------------------------------------------------------ addresses */

export const PROGRAM_ID = 'FF1f3V47FtApwWWMHX462Gm7NVqNpUJ7K4yqKrYGSMbg';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const DOGGO_MINT = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
export const CREATOR = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R';
export const TRADER = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

/* ------------------------------------------------------------------- encoders */
// Field order below is the wire format and mirrors `events.rs` exactly.

export interface TokenCreatedFields {
  mint: string;
  baseMint: string;
  creator: string;
  ticker: string;
  supply: bigint;
  feeBps: number;
  cashback: boolean;
  cbStart: bigint;
  virtualBase: bigint;
  virtualToken: bigint;
  tokensForSale: bigint;
  lpReserve: bigint;
  gradMcapBase: bigint;
  basePrice1e6: bigint;
  ts: bigint;
}

export function encodeTokenCreated(f: TokenCreatedFields): Buffer {
  return new BorshWriter()
    .pubkey(f.mint)
    .pubkey(f.baseMint)
    .pubkey(f.creator)
    .string(f.ticker)
    .u64(f.supply)
    .u16(f.feeBps)
    .bool(f.cashback)
    .i64(f.cbStart)
    .u128(f.virtualBase)
    .u128(f.virtualToken)
    .u64(f.tokensForSale)
    .u64(f.lpReserve)
    .u128(f.gradMcapBase)
    .u64(f.basePrice1e6)
    .i64(f.ts)
    .done();
}

export interface TradeFields {
  mint: string;
  trader: string;
  isBuy: boolean;
  baseAmount: bigint;
  tokenAmount: bigint;
  effFeeBps: number;
  inCashback: boolean;
  feeTotal: bigint;
  feeProtocol: bigint;
  feeOps: bigint;
  feeBurn: bigint;
  feeCreatorBucket: bigint;
  feeStakers: bigint;
  feeCreator: bigint;
  cashbackTokens: bigint;
  virtualBase: bigint;
  virtualToken: bigint;
  realBase: bigint;
  realToken: bigint;
  circulating: bigint;
  ts: bigint;
}

export function encodeTrade(f: TradeFields): Buffer {
  return new BorshWriter()
    .pubkey(f.mint)
    .pubkey(f.trader)
    .bool(f.isBuy)
    .u64(f.baseAmount)
    .u64(f.tokenAmount)
    .u16(f.effFeeBps)
    .bool(f.inCashback)
    .u64(f.feeTotal)
    .u64(f.feeProtocol)
    .u64(f.feeOps)
    .u64(f.feeBurn)
    .u64(f.feeCreatorBucket)
    .u64(f.feeStakers)
    .u64(f.feeCreator)
    .u64(f.cashbackTokens)
    .u128(f.virtualBase)
    .u128(f.virtualToken)
    .u64(f.realBase)
    .u64(f.realToken)
    .u64(f.circulating)
    .i64(f.ts)
    .done();
}

export interface FeeAccruedFields {
  mint: string;
  baseMint: string;
  feeTotal: bigint;
  protocol: bigint;
  ops: bigint;
  burn: bigint;
  creatorBucket: bigint;
  ts: bigint;
}

export function encodeFeeAccrued(f: FeeAccruedFields): Buffer {
  return new BorshWriter()
    .pubkey(f.mint)
    .pubkey(f.baseMint)
    .u64(f.feeTotal)
    .u64(f.protocol)
    .u64(f.ops)
    .u64(f.burn)
    .u64(f.creatorBucket)
    .i64(f.ts)
    .done();
}

export function encodeTreasuryCredit(f: {
  baseMint: string;
  protocolDelta: bigint;
  opsDelta: bigint;
  burnDelta: bigint;
  ts: bigint;
}): Buffer {
  return new BorshWriter()
    .pubkey(f.baseMint)
    .u64(f.protocolDelta)
    .u64(f.opsDelta)
    .u64(f.burnDelta)
    .i64(f.ts)
    .done();
}

export function encodeGraduated(f: {
  mint: string;
  baseMint: string;
  reason: number;
  baseMigrated: bigint;
  tokensMigrated: bigint;
  tokensBurned: bigint;
  mcapBase: bigint;
  mcapUsd1e6: bigint;
  ts: bigint;
}): Buffer {
  return new BorshWriter()
    .pubkey(f.mint)
    .pubkey(f.baseMint)
    .u8(f.reason)
    .u64(f.baseMigrated)
    .u64(f.tokensMigrated)
    .u64(f.tokensBurned)
    .u128(f.mcapBase)
    .u128(f.mcapUsd1e6)
    .i64(f.ts)
    .done();
}

export function encodeLiquidityMigrated(f: {
  mint: string;
  baseMint: string;
  pool: string;
  position: string;
  baseDeposited: bigint;
  tokenDeposited: bigint;
  lockReleasePoint: bigint;
  positionLocked: bigint;
  ts: bigint;
}): Buffer {
  return new BorshWriter()
    .pubkey(f.mint)
    .pubkey(f.baseMint)
    .pubkey(f.pool)
    .pubkey(f.position)
    .u64(f.baseDeposited)
    .u64(f.tokenDeposited)
    .u64(f.lockReleasePoint)
    .u64(f.positionLocked)
    .i64(f.ts)
    .done();
}

export function encodeCreatorFeesClaimed(f: {
  mint: string;
  creator: string;
  baseAmount: bigint;
  tokenAmount: bigint;
  ts: bigint;
}): Buffer {
  return new BorshWriter()
    .pubkey(f.mint)
    .pubkey(f.creator)
    .u64(f.baseAmount)
    .u64(f.tokenAmount)
    .i64(f.ts)
    .done();
}

export function encodeStaked(f: {
  mint: string;
  owner: string;
  amount: bigint;
  lockDays: number;
  weight: bigint;
  lockUntil: bigint;
  eligibleStaked: bigint;
  totalWeight: bigint;
  ts: bigint;
}): Buffer {
  return new BorshWriter()
    .pubkey(f.mint)
    .pubkey(f.owner)
    .u64(f.amount)
    .u16(f.lockDays)
    .u128(f.weight)
    .i64(f.lockUntil)
    .u64(f.eligibleStaked)
    .u128(f.totalWeight)
    .i64(f.ts)
    .done();
}

export function encodeUnstaked(f: {
  mint: string;
  owner: string;
  amount: bigint;
  eligibleStaked: bigint;
  totalWeight: bigint;
  ts: bigint;
}): Buffer {
  return new BorshWriter()
    .pubkey(f.mint)
    .pubkey(f.owner)
    .u64(f.amount)
    .u64(f.eligibleStaked)
    .u128(f.totalWeight)
    .i64(f.ts)
    .done();
}

export function encodeStakeClaimed(f: {
  mint: string;
  owner: string;
  baseAmount: bigint;
  tokenAmount: bigint;
  ts: bigint;
}): Buffer {
  return new BorshWriter()
    .pubkey(f.mint)
    .pubkey(f.owner)
    .u64(f.baseAmount)
    .u64(f.tokenAmount)
    .i64(f.ts)
    .done();
}

export function encodeTreasuryWithdrawn(f: {
  baseMint: string;
  which: number;
  amount: bigint;
  destination: string;
  ts: bigint;
}): Buffer {
  return new BorshWriter()
    .pubkey(f.baseMint)
    .u8(f.which)
    .u64(f.amount)
    .pubkey(f.destination)
    .i64(f.ts)
    .done();
}

/* ------------------------------------------------------------- a fake RPC */

export interface FakeTx {
  signature: string;
  slot: number;
  blockTimeSecs: number;
  /** `Program data:` payloads, already `emit!`-framed. */
  logs: string[];
  err?: unknown;
  /** `emit_cpi!` inner-instruction data, base58 as the RPC returns it. */
  cpiData?: Buffer[];
  accountKeys?: string[];
}

/**
 * A `SolanaIndexRpc` backed by an in-memory transaction list, matching the
 * real RPC's contract: newest-first, `before`/`until` exclusive, `limit`
 * honoured. `SolanaChainSource`'s paging is only correct if it respects those,
 * so the fake has to be strict about them.
 */
/**
 * A real RPC wraps a program's log lines in its `invoke [1]` / `success`
 * frame, and the indexer only trusts `Program data:` written inside the
 * launchpad's own frame. Fixtures that hand over bare data lines get that
 * frame here; a fixture that builds its own frames is left alone.
 */
function framedLogs(logs: string[]): string[] {
  if (logs.some((l) => / invoke \[\d+\]$/.test(l))) return logs;
  return [`Program ${PROGRAM_ID} invoke [1]`, ...logs, `Program ${PROGRAM_ID} success`];
}

export class FakeSolanaRpc implements SolanaIndexRpc {
  finalizedSlot: number;
  calls: { method: string; params: unknown }[] = [];
  blockhashes = new Map<number, string>();
  failNext: Error | null = null;

  constructor(
    private readonly txs: FakeTx[],
    finalizedSlot?: number,
  ) {
    this.finalizedSlot = finalizedSlot ?? Math.max(0, ...txs.map((t) => t.slot));
  }

  private get descending(): FakeTx[] {
    return [...this.txs].sort((a, b) =>
      a.slot !== b.slot ? b.slot - a.slot : a.signature < b.signature ? 1 : -1,
    );
  }

  async getSlot(commitment: Commitment): Promise<number> {
    this.calls.push({ method: 'getSlot', params: commitment });
    return this.finalizedSlot;
  }

  async getSignaturesForAddress(address: string, page: SignaturePage): Promise<SignatureInfo[]> {
    this.calls.push({ method: 'getSignaturesForAddress', params: { address, ...page } });
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    let list = this.descending;
    if (page.before) {
      const at = list.findIndex((t) => t.signature === page.before);
      list = at === -1 ? list : list.slice(at + 1);
    }
    if (page.until) {
      const at = list.findIndex((t) => t.signature === page.until);
      if (at !== -1) list = list.slice(0, at);
    }
    return list.slice(0, page.limit).map((t) => ({
      signature: t.signature,
      slot: t.slot,
      err: t.err ?? null,
      blockTime: t.blockTimeSecs,
      confirmationStatus: 'finalized',
    }));
  }

  async getTransaction(signature: string): Promise<SolanaTransaction | null> {
    this.calls.push({ method: 'getTransaction', params: signature });
    const tx = this.txs.find((t) => t.signature === signature);
    if (!tx) return null;
    return {
      slot: tx.slot,
      blockTime: tx.blockTimeSecs,
      meta: {
        err: tx.err ?? null,
        logMessages: framedLogs(tx.logs),
        innerInstructions: tx.cpiData
          ? [
              {
                index: 0,
                instructions: tx.cpiData.map((d) => ({ programIdIndex: 0, data: bs58.encode(d) })),
              },
            ]
          : null,
      },
      transaction: { message: { accountKeys: tx.accountKeys ?? [PROGRAM_ID] } },
    };
  }

  async getBlockhash(slot: number): Promise<string | null> {
    this.calls.push({ method: 'getBlockhash', params: slot });
    return this.blockhashes.get(slot) ?? null;
  }
}
