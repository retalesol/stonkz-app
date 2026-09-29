import { wireMessageBase64 } from '../router/solana-alt.js';
import type { NativeUnit, Net } from '@stonkz/shared';
import { jsonRpc } from './jsonrpc.js';
import {
  RpcError,
  type ChainRpc,
  type FetchLike,
  type NativeTransferSource,
  type NativeTransferVerification,
  type SolanaTransactionLogs,
} from './types.js';

export const LAMPORTS_PER_SOL = 1_000_000_000;

export interface SolanaRpcOptions {
  url: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  onCall?: (ok: boolean) => void;
}

/** Helius or any Solana JSON-RPC endpoint. Read-only for Phases 1 and 3. */
export class SolanaRpc implements ChainRpc, NativeTransferSource {
  readonly net: Net = 'SOL';
  readonly nativeUnit: NativeUnit = 'SOL';

  private readonly url: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly onCall: (ok: boolean) => void;

  constructor(opts: SolanaRpcOptions) {
    this.url = opts.url;
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.onCall = opts.onCall ?? (() => {});
  }

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    try {
      const result = await jsonRpc<T>(this.fetchImpl, this.url, method, params, {
        timeoutMs: this.timeoutMs,
      });
      this.onCall(true);
      return result;
    } catch (err) {
      this.onCall(false);
      throw new RpcError('SOL', method, err instanceof Error ? err.message : String(err), err);
    }
  }

  async head(): Promise<number> {
    // `confirmed` matches what the indexer commits at; `finalized` would make
    // lag look permanently ~32 slots worse than it is.
    return this.call<number>('getSlot', [{ commitment: 'confirmed' }]);
  }

  async nativeBalance(address: string): Promise<number> {
    const res = await this.call<{ value: number }>('getBalance', [
      address,
      { commitment: 'confirmed' },
    ]);
    return res.value / LAMPORTS_PER_SOL;
  }

  /**
   * SPL token balances for an owner, keyed by mint address.
   * Used by public profiles so holdings are chain-truth when RPC is up.
   */
  async splTokenBalances(owner: string): Promise<Map<string, number>> {
    const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    const res = await this.call<{
      value: Array<{
        account: {
          data: {
            parsed?: {
              info?: {
                mint?: string;
                tokenAmount?: { uiAmount: number | null; uiAmountString?: string };
              };
            };
          };
        };
      }>;
    }>('getTokenAccountsByOwner', [
      owner,
      { programId: TOKEN_PROGRAM },
      { encoding: 'jsonParsed', commitment: 'confirmed' },
    ]);
    const out = new Map<string, number>();
    for (const row of res.value ?? []) {
      const info = row.account?.data?.parsed?.info;
      const mint = info?.mint;
      if (!mint) continue;
      const amt = info?.tokenAmount?.uiAmount;
      const n = typeof amt === 'number' ? amt : Number(info?.tokenAmount?.uiAmountString ?? 0);
      if (!Number.isFinite(n) || n <= 0) continue;
      out.set(mint, (out.get(mint) ?? 0) + n);
    }
    return out;
  }

  async healthy(): Promise<boolean> {
    try {
      await this.head();
      return true;
    } catch {
      return false;
    }
  }

  /** Raw account data (base64) for curve/PDA reads — `null` when missing. */
  async getAccountDataBase64(address: string): Promise<string | null> {
    const res = await this.call<{
      value: { data: [string, string] } | null;
    }>('getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }]);
    const data = res.value?.data?.[0];
    return typeof data === 'string' && data.length > 0 ? data : null;
  }

  /** `getLatestBlockhash` — what `router/solana-tx.ts` stamps onto every composed transaction. */
  async latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    const res = await this.call<{
      value: { blockhash: string; lastValidBlockHeight: number };
    }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    return res.value;
  }

  /** `routes/launch.ts` / a future `/trade/confirm`'s verification read — the compiled message only, signatures stripped. */
  async getTransactionMessageBase64(signature: string): Promise<string | null> {
    return (await this.getTransactionOutcome(signature))?.messageBase64 ?? null;
  }

  /**
   * The compiled message plus whether the transaction executed. `null` when
   * the signature is unknown at `confirmed`. Legacy and v0 transactions both
   * read back in the encoding `router/solana-alt.ts` stores at prepare time
   * (a v0 message verbatim, lookup-table references included); bytes that
   * parse as neither read back as an empty message, which can never equal a
   * prepared payload.
   */
  async getTransactionOutcome(
    signature: string,
  ): Promise<{ messageBase64: string; failed: boolean } | null> {
    const res = await this.call<{
      transaction: [string, string];
      meta: { err: unknown } | null;
    } | null>('getTransaction', [
      signature,
      { encoding: 'base64', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
    ]);
    if (!res?.transaction) return null;
    const raw = Buffer.from(res.transaction[0], 'base64');
    // `maxSupportedTransactionVersion: 0` above makes the node return v0
    // transactions instead of erroring on them.
    let messageBase64 = '';
    try {
      messageBase64 = wireMessageBase64(raw);
    } catch {
      messageBase64 = '';
    }
    const failed = !res.meta || (res.meta.err !== null && res.meta.err !== undefined);
    return { messageBase64, failed };
  }

  /**
   * Pre-sign dry run of an unsigned wire-format transaction. The wallet has
   * not signed yet, so signature verification is off, and the blockhash is
   * replaced so a slow prepare cannot fail simulation on expiry alone.
   * Transport errors throw `RpcError`; an execution failure is a result.
   */
  async simulateTransaction(
    base64Tx: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const res = await this.call<{ value: { err: unknown; logs: string[] | null } }>(
      'simulateTransaction',
      [
        base64Tx,
        {
          encoding: 'base64',
          sigVerify: false,
          replaceRecentBlockhash: true,
          commitment: 'confirmed',
        },
      ],
    );
    const err = res.value?.err;
    if (err === null || err === undefined) return { ok: true };
    const logs = (res.value.logs ?? []).slice(-20).join('\n');
    return { ok: false, reason: `${JSON.stringify(err)}\n${logs}` };
  }

  /**
   * `social/tips.ts`'s only chain-facing call. Reads `preBalances`/
   * `postBalances` rather than trying to decode a `SystemProgram.transfer`
   * instruction, so it verifies the actual lamport movement regardless of
   * how the transfer was composed (direct transfer, transfer-with-seed,
   * memo + transfer, etc.) — the largest balance increase is the recipient,
   * the largest decrease is the payer, which is exactly right for a plain
   * wallet-to-wallet tip and cannot be spoofed by padding the transaction
   * with unrelated instructions that move smaller amounts.
   */
  async getNativeTransfer(signature: string): Promise<NativeTransferVerification> {
    const res = await this.call<{
      transaction: { message: { accountKeys: (string | { pubkey: string })[] } };
      meta: { err: unknown; preBalances: number[]; postBalances: number[] } | null;
      blockTime: number | null;
    } | null>('getTransaction', [
      signature,
      { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
    ]);

    if (!res || !res.meta) {
      return {
        found: false,
        status: 'failed',
        from: null,
        to: null,
        amountNative: null,
        blockTimeMs: null,
      };
    }

    const keys = res.transaction.message.accountKeys.map((k) =>
      typeof k === 'string' ? k : k.pubkey,
    );
    const { preBalances, postBalances, err } = res.meta;

    let bestTo: { addr: string; delta: number } | null = null;
    let bestFrom: { addr: string; delta: number } | null = null;
    for (let i = 0; i < keys.length; i++) {
      const delta = (postBalances[i] ?? 0) - (preBalances[i] ?? 0);
      if (delta > 0 && (!bestTo || delta > bestTo.delta))
        bestTo = { addr: keys[i] as string, delta };
      if (delta < 0 && (!bestFrom || delta < bestFrom.delta))
        bestFrom = { addr: keys[i] as string, delta };
    }

    return {
      found: true,
      status: err ? 'failed' : 'success',
      from: bestFrom?.addr ?? null,
      to: bestTo?.addr ?? null,
      amountNative: bestTo ? bestTo.delta / LAMPORTS_PER_SOL : null,
      blockTimeMs: res.blockTime !== null ? res.blockTime * 1000 : null,
    };
  }
  /**
   * `/trade/confirm`'s read: logs and inner instructions at `confirmed`, the
   * same `json` encoding the indexer fetches at `finalized`, so both decode
   * the launchpad's `Trade` events from identical inputs.
   */
  async getTransactionLogs(signature: string): Promise<SolanaTransactionLogs | null> {
    const res = await this.call<{
      slot: number;
      blockTime: number | null;
      transaction: { message: { accountKeys: (string | { pubkey: string })[] } };
      meta: {
        err: unknown;
        logMessages?: string[] | null;
        innerInstructions?: { instructions: { programIdIndex?: number; data?: string }[] }[] | null;
        loadedAddresses?: { writable?: string[]; readonly?: string[] } | null;
      } | null;
    } | null>('getTransaction', [
      signature,
      { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
    ]);
    if (!res?.transaction) return null;
    const meta = res.meta;
    return {
      slot: res.slot,
      blockTimeMs: res.blockTime !== null ? res.blockTime * 1000 : null,
      failed: !meta || (meta.err !== null && meta.err !== undefined),
      logMessages: meta?.logMessages ?? [],
      innerInstructions: meta?.innerInstructions ?? [],
      accountKeys: [
        ...res.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey)),
        ...(meta?.loadedAddresses?.writable ?? []),
        ...(meta?.loadedAddresses?.readonly ?? []),
      ],
    };
  }
}
