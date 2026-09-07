import { Transaction } from '@solana/web3.js';
import type { NativeUnit, Net } from '@stonkz/shared';
import { jsonRpc } from './jsonrpc.js';
import { RpcError, type ChainRpc, type FetchLike } from './types.js';

export const LAMPORTS_PER_SOL = 1_000_000_000;

export interface SolanaRpcOptions {
  url: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  onCall?: (ok: boolean) => void;
}

/** Helius or any Solana JSON-RPC endpoint. Read-only for Phases 1 and 3. */
export class SolanaRpc implements ChainRpc {
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

  async healthy(): Promise<boolean> {
    try {
      await this.head();
      return true;
    } catch {
      return false;
    }
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
    const res = await this.call<{ transaction: [string, string] } | null>('getTransaction', [
      signature,
      { encoding: 'base64', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
    ]);
    if (!res?.transaction) return null;
    const raw = Buffer.from(res.transaction[0], 'base64');
    // Every transaction this router builds is a legacy `Transaction`
    // (`solana-tx.ts`/`solana-launch-tx.ts` both refuse to emit versioned
    // ones — see their address-lookup-table guard), so parsing as legacy is
    // exactly what a real submitted tx is expected to be.
    const tx = Transaction.from(raw);
    return tx.compileMessage().serialize().toString('base64');
  }
}
