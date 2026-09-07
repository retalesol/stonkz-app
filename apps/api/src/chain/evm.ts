import type { NativeUnit, Net } from '@stonkz/shared';
import { jsonRpc } from './jsonrpc.js';
import { RpcError, type ChainRpc, type FetchLike } from './types.js';

export const WEI_PER_ETH = 1e18;

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
 * Plan step 51 is still open: the chain id, gas token and token standard are
 * unconfirmed. `RH_RPC_URL` therefore points at a documented test chain by
 * default and `verifyChainId()` refuses to run against the wrong network
 * rather than silently indexing someone else's blocks.
 */
export class EvmRpc implements ChainRpc {
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
