import type { NativeUnit, Net } from '@stonkz/shared';
import { jsonRpc } from './jsonrpc.js';
import { RpcError, type ChainRpc, type FetchLike, type NativeTransferSource, type NativeTransferVerification } from './types.js';

export const WEI_PER_ETH = 1e18;

/**
 * Confirmed in `docs/robinhood-chain.md`: mainnet is 4663 (`0x1237`), testnet
 * is 46630, and the gas token is ETH with the usual 18 decimals.
 */
export const RH_CHAIN_ID = 4663;
export const RH_TESTNET_CHAIN_ID = 46630;

/**
 * Robinhood documents the public RPC as rate-limited and explicitly not for
 * production; a balance read on every wallet render will hit those limits.
 * It is the default only so a fresh checkout works — set `RH_RPC_URL` to a
 * provider endpoint for anything real.
 */
export const RH_PUBLIC_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';

export interface EvmRpcOptions {
  url: string;
  chainId: number;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  onCall?: (ok: boolean) => void;
}

/**
 * Robinhood Chain, treated as a standard EVM.
 *
 * `verifyChainId()` refuses to run against the wrong network rather than
 * silently indexing someone else's blocks — worth keeping now that the id is
 * confirmed, because 4663 and testnet 46630 are a plausible typo apart.
 */
export class EvmRpc implements ChainRpc, NativeTransferSource {
  readonly net: Net = 'RH';
  readonly nativeUnit: NativeUnit = 'ETH';
  readonly chainId: number;

  private readonly url: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly onCall: (ok: boolean) => void;

  constructor(opts: EvmRpcOptions) {
    this.url = opts.url;
    this.chainId = opts.chainId;
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
      throw new RpcError('RH', method, err instanceof Error ? err.message : String(err), err);
    }
  }

  async head(): Promise<number> {
    return Number.parseInt(await this.call<string>('eth_blockNumber', []), 16);
  }

  async nativeBalance(address: string): Promise<number> {
    const hex = await this.call<string>('eth_getBalance', [address, 'latest']);
    // Parse as BigInt first: 1e18 wei overflows float precision on the way in.
    return Number(BigInt(hex)) / WEI_PER_ETH;
  }

  /**
   * `eth_call` at head. Used by the SIWE verifier's ERC-1271 fallback, which
   * is why it is read-only and takes raw calldata rather than an ABI.
   */
  async ethCall(to: string, data: string): Promise<string> {
    return this.call<string>('eth_call', [{ to, data }, 'latest']);
  }

  /** `routes/launch.ts`'s `/launch/confirm` — status + calldata + logs, to verify and to find the `TokenCreated` address. */
  async getTransactionReceipt(hash: string): Promise<{
    status: 'success' | 'reverted';
    to: string | null;
    input: string;
    logs: { address: string; topics: string[]; data: string }[];
  } | null> {
    const [receipt, tx] = await Promise.all([
      this.call<{
        status: string;
        to: string | null;
        logs: { address: string; topics: string[]; data: string }[];
      } | null>('eth_getTransactionReceipt', [hash]),
      this.call<{ input?: string; data?: string } | null>('eth_getTransactionByHash', [hash]),
    ]);
    if (!receipt || !tx) return null;
    return {
      status: receipt.status === '0x1' ? 'success' : 'reverted',
      to: receipt.to,
      // `input` on older nodes, `data` is the ethers-style alias some RPCs use.
      input: tx.input ?? tx.data ?? '0x',
      logs: receipt.logs,
    };
  }

  /**
   * `social/tips.ts`'s only chain-facing call. A plain native transfer's
   * `value` is on the transaction itself, not derivable from the receipt
   * alone, so both are fetched — mirroring `getTransactionReceipt`'s own
   * two-call shape above.
   */
  async getNativeTransfer(hash: string): Promise<NativeTransferVerification> {
    const [receipt, tx] = await Promise.all([
      this.call<{ status: string; blockNumber: string } | null>('eth_getTransactionReceipt', [hash]),
      this.call<{ from?: string; to?: string | null; value?: string } | null>('eth_getTransactionByHash', [hash]),
    ]);
    if (!receipt || !tx) {
      return { found: false, status: 'failed', from: null, to: null, amountNative: null, blockTimeMs: null };
    }

    let blockTimeMs: number | null = null;
    try {
      const block = await this.call<{ timestamp: string } | null>('eth_getBlockByNumber', [
        receipt.blockNumber,
        false,
      ]);
      if (block) blockTimeMs = Number.parseInt(block.timestamp, 16) * 1000;
    } catch {
      // Best-effort only; the caller does not depend on this to verify the transfer.
    }

    return {
      found: true,
      status: receipt.status === '0x1' ? 'success' : 'failed',
      from: tx.from ?? null,
      to: tx.to ?? null,
      amountNative: tx.value ? Number(BigInt(tx.value)) / WEI_PER_ETH : null,
      blockTimeMs,
    };
  }

  /** Guards against pointing the indexer at the wrong EVM network. */
  async verifyChainId(): Promise<void> {
    const actual = Number.parseInt(await this.call<string>('eth_chainId', []), 16);
    if (actual !== this.chainId) {
      throw new RpcError('RH', 'eth_chainId', `expected ${this.chainId}, endpoint reports ${actual}`);
    }
  }

  async healthy(): Promise<boolean> {
    try {
      await this.head();
      return true;
    } catch {
      return false;
    }
  }
}
