import { jsonRpc } from '@stonkz/api/chain/jsonrpc';
import type { FetchLike } from '@stonkz/api/chain/types';
import { RpcError } from '@stonkz/api/chain/types';

/**
 * The Solana RPC surface the indexer needs, which is a different set from
 * `apps/api`'s `SolanaRpc` (balances, blockhashes, tip verification). Kept as
 * an interface so the source can be driven from captured RPC payloads in
 * tests without a network — see `chain/solana-source.test.ts`.
 *
 * Commitment is `finalized` everywhere on purpose. `apps/api`'s `head()` uses
 * `confirmed` because it only reports lag; ingestion writes durable rows and
 * pays XP, so it reads the view the cluster has agreed cannot be rolled back.
 */
export type Commitment = 'processed' | 'confirmed' | 'finalized';

export interface SignatureInfo {
  signature: string;
  slot: number;
  err: unknown;
  blockTime: number | null;
  confirmationStatus?: string;
}

export interface SignaturePage {
  limit: number;
  /** Walk backwards from (exclusive) this signature. */
  before?: string | undefined;
  /** Stop when this signature is reached (exclusive) — the cursor bookmark. */
  until?: string | undefined;
}

export interface SolanaTransactionMeta {
  err: unknown;
  logMessages?: string[] | null;
  innerInstructions?:
    { index: number; instructions: { programIdIndex?: number; data?: string }[] }[] | null;
  /** Keys a v0 message loaded from address lookup tables, in index order after the static keys. */
  loadedAddresses?: { writable?: string[]; readonly?: string[] } | null;
}

export interface SolanaTransaction {
  slot: number;
  blockTime: number | null;
  meta: SolanaTransactionMeta | null;
  transaction: { message: { accountKeys: (string | { pubkey: string })[] } };
}

export interface SolanaIndexRpc {
  /** Highest slot at the given commitment. */
  getSlot(commitment: Commitment): Promise<number>;
  getSignaturesForAddress(address: string, page: SignaturePage): Promise<SignatureInfo[]>;
  getTransaction(signature: string): Promise<SolanaTransaction | null>;
  /** The slot's blockhash, or `null` when the slot was skipped or pruned. */
  getBlockhash(slot: number): Promise<string | null>;
}

export interface HttpSolanaIndexRpcOptions {
  url: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  commitment?: Commitment;
  onCall?: (ok: boolean) => void;
}

/** A slot with no block: skipped by the leader, or below the node's first available slot. */
const SLOT_NOT_AVAILABLE = /skipped|not available|was not found|cleaned up|first available block/i;

export class HttpSolanaIndexRpc implements SolanaIndexRpc {
  private readonly url: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly commitment: Commitment;
  private readonly onCall: (ok: boolean) => void;

  constructor(opts: HttpSolanaIndexRpcOptions) {
    this.url = opts.url;
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    // Signature paging and transaction fetches are heavier than a balance
    // read, so the default here is looser than `SolanaRpc`'s 5s.
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.commitment = opts.commitment ?? 'finalized';
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

  async getSlot(commitment: Commitment = this.commitment): Promise<number> {
    return this.call<number>('getSlot', [{ commitment }]);
  }

  async getSignaturesForAddress(address: string, page: SignaturePage): Promise<SignatureInfo[]> {
    return this.call<SignatureInfo[]>('getSignaturesForAddress', [
      address,
      {
        limit: page.limit,
        commitment: this.commitment,
        ...(page.before ? { before: page.before } : {}),
        ...(page.until ? { until: page.until } : {}),
      },
    ]);
  }

  async getTransaction(signature: string): Promise<SolanaTransaction | null> {
    return this.call<SolanaTransaction | null>('getTransaction', [
      signature,
      {
        encoding: 'json',
        commitment: this.commitment,
        // Versioned transactions are normal on mainnet; refusing them would
        // silently drop any fill routed through a lookup table.
        maxSupportedTransactionVersion: 0,
      },
    ]);
  }

  async getBlockhash(slot: number): Promise<string | null> {
    try {
      const block = await this.call<{ blockhash: string } | null>('getBlock', [
        slot,
        {
          encoding: 'json',
          commitment: this.commitment === 'processed' ? 'confirmed' : this.commitment,
          transactionDetails: 'none',
          rewards: false,
          maxSupportedTransactionVersion: 0,
        },
      ]);
      return block?.blockhash ?? null;
    } catch (err) {
      // A skipped slot is a normal, expected answer, not a failure: Solana
      // leaders miss slots routinely. Anything else is a real RPC problem.
      if (err instanceof Error && SLOT_NOT_AVAILABLE.test(err.message)) return null;
      throw err;
    }
  }
}
