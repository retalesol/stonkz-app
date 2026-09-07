import { jsonRpc } from '@stonkz/api/chain/jsonrpc';
import type { FetchLike } from '@stonkz/api/chain/types';
import { RpcError } from '@stonkz/api/chain/types';
import type { RawEvmLog } from './evm-events.js';

/**
 * The Robinhood Chain RPC surface the indexer needs.
 *
 * Kept as an interface for the same reason `SolanaIndexRpc` is: the source has
 * to be drivable from captured payloads, because there is no funded RH access
 * to test against. See `chain/evm-source.test.ts`.
 *
 * The calls are raw `eth_*` JSON-RPC rather than a viem `PublicClient`. viem
 * is still what *decodes* — `decodeEventLog` in `evm-events.ts` does the
 * topic0 match and the indexed/non-indexed split — but the transport stays on
 * `apps/api`'s `jsonRpc`, which already carries this stack's timeout, error
 * wrapping and `FetchLike` seam. Wrapping a viem client in a fake for tests
 * would mean faking a much larger surface than four methods.
 */
export interface EvmBlockRef {
  number: number;
  hash: string;
  timestampMs: number;
}

export interface EvmLogFilter {
  fromBlock: number;
  toBlock: number;
  /** Launchpad + router. Providers OR these, so one call covers both. */
  addresses: readonly string[];
}

export interface EvmIndexRpc {
  blockNumber(): Promise<number>;
  /** `null` when the block does not exist (yet, or any more). */
  getBlock(number: number): Promise<EvmBlockRef | null>;
  getLogs(filter: EvmLogFilter): Promise<RawEvmLog[]>;
}

export interface HttpEvmIndexRpcOptions {
  url: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  onCall?: (ok: boolean) => void;
}

function hex(n: number): string {
  return `0x${n.toString(16)}`;
}

function toNumber(value: unknown, what: string): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.length > 0) {
    const n = Number(value.startsWith('0x') ? BigInt(value) : value);
    if (Number.isFinite(n)) return n;
  }
  throw new Error(`RH ${what} is not a number: ${JSON.stringify(value)}`);
}

export class HttpEvmIndexRpc implements EvmIndexRpc {
  private readonly url: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly onCall: (ok: boolean) => void;

  constructor(opts: HttpEvmIndexRpcOptions) {
    this.url = opts.url;
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    this.timeoutMs = opts.timeoutMs ?? 20_000;
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

  async blockNumber(): Promise<number> {
    return toNumber(await this.call<string>('eth_blockNumber', []), 'eth_blockNumber');
  }

  async getBlock(number: number): Promise<EvmBlockRef | null> {
    const block = await this.call<{ number: string; hash: string; timestamp: string } | null>(
      'eth_getBlockByNumber',
      [hex(number), false],
    );
    if (!block) return null;
    return {
      number: toNumber(block.number, 'block.number'),
      hash: block.hash,
      timestampMs: toNumber(block.timestamp, 'block.timestamp') * 1000,
    };
  }

  async getLogs(filter: EvmLogFilter): Promise<RawEvmLog[]> {
    return this.call<RawEvmLog[]>('eth_getLogs', [
      {
        fromBlock: hex(filter.fromBlock),
        toBlock: hex(filter.toBlock),
        address: [...filter.addresses],
      },
    ]);
  }
}
