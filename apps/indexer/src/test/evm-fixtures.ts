import { encodeEventTopics, encodeAbiParameters, type AbiEvent } from 'viem';
import type { RawEvmLog } from '../chain/evm-events.js';
import { STONKZ_EVENTS_ABI, type EvmEventName } from '../chain/evm-events.js';
import type { EvmBlockRef, EvmIndexRpc, EvmLogFilter } from '../chain/evm-rpc.js';

/**
 * Synthetic-but-real Robinhood Chain log payloads.
 *
 * "Real" in the only sense available without a deployment: the topics and the
 * data blob are produced by viem's own `encodeEventTopics` /
 * `encodeAbiParameters` from the same ABI the decoder consumes, so a log here
 * is byte-identical to what a node would return for that event. What is
 * synthetic is the *transaction* — there is no deployed `StonkzLaunchpad` and
 * no funded RH access (`docs/real-vs-simulated.md`), so the block numbers,
 * hashes and gas story are invented.
 *
 * Encoding through viem rather than hand-writing hex is deliberate: a
 * hand-written fixture that agreed with a mis-transcribed ABI would make the
 * decoder tests pass against the wrong shape. Going through the encoder means
 * the fixtures agree with the ABI, and the ABI was checked against
 * `programs/evm/src/*.sol` by eye.
 */
export const LAUNCHPAD = '0x000000000000000000000000000000000000dec0';
export const ROUTER = '0x0000000000000000000000000000000000000d0e5';
/** aeWETH, the configured RH native wrapper — `router/base-mints.ts`. */
export const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
export const USDC_RH = '0x00000000000000000000000000000000000005dc0';
export const CREATOR = '0x000000000000000000000000000000000000c4ea7';
export const TRADER = '0x000000000000000000000000000000000000f4ade';
export const DOGGO = '0x0000000000000000000000000000000000d066001';

function eventAbi(name: EvmEventName): AbiEvent {
  const found = STONKZ_EVENTS_ABI.find((e) => e.name === name);
  if (!found) throw new Error(`no ABI entry for ${name}`);
  return found as AbiEvent;
}

/**
 * Encodes one event into a `RawEvmLog`, splitting the arguments across topics
 * and data the way the EVM does.
 */
export function encodeLog(
  name: EvmEventName,
  args: Record<string, unknown>,
  placement: { address: string; blockNumber: number; blockHash: string; txHash: string; logIndex: number },
): RawEvmLog {
  const abi = eventAbi(name);
  const topics = encodeEventTopics({
    abi: [abi],
    eventName: name,
    args: Object.fromEntries(
      abi.inputs.filter((i) => i.indexed).map((i) => [i.name as string, args[i.name as string]]),
    ) as never,
  });
  const unindexed = abi.inputs.filter((i) => !i.indexed);
  const data =
    unindexed.length === 0
      ? '0x'
      : encodeAbiParameters(
          unindexed,
          unindexed.map((i) => args[i.name as string]) as never,
        );

  return {
    address: placement.address.toLowerCase(),
    topics: topics as string[],
    data,
    blockNumber: `0x${placement.blockNumber.toString(16)}`,
    blockHash: placement.blockHash,
    transactionHash: placement.txHash,
    logIndex: `0x${placement.logIndex.toString(16)}`,
  };
}

export interface FakeBlock {
  number: number;
  hash: string;
  timestampMs: number;
}

/**
 * An in-memory `EvmIndexRpc` that honours the real `eth_getLogs` contract:
 * inclusive `fromBlock`/`toBlock`, address filtering, and no ordering promise
 * beyond what a node gives (so the fixtures return logs unsorted on purpose,
 * to prove `groupByTransaction` orders them).
 */
export class FakeEvmRpc implements EvmIndexRpc {
  readonly calls: { method: string; params: unknown }[] = [];
  /** Set to make the next `getLogs` throw, for the poison-batch tests. */
  failGetLogs: Error | null = null;
  /** Emulates a provider that refuses a wide window. */
  maxLogsPerCall = Number.POSITIVE_INFINITY;

  constructor(
    private head: number,
    private readonly logs: RawEvmLog[],
    private readonly blocks: Map<number, FakeBlock>,
  ) {}

  setHead(n: number): void {
    this.head = n;
  }

  /** Rewrites a block's hash, the way a reorg would. */
  reorgAt(number: number, hash: string): void {
    const block = this.blocks.get(number);
    if (block) this.blocks.set(number, { ...block, hash });
  }

  async blockNumber(): Promise<number> {
    this.calls.push({ method: 'eth_blockNumber', params: null });
    return this.head;
  }

  async getBlock(number: number): Promise<EvmBlockRef | null> {
    this.calls.push({ method: 'eth_getBlockByNumber', params: number });
    return this.blocks.get(number) ?? null;
  }

  async getLogs(filter: EvmLogFilter): Promise<RawEvmLog[]> {
    this.calls.push({ method: 'eth_getLogs', params: filter });
    if (this.failGetLogs) throw this.failGetLogs;
    const wanted = new Set(filter.addresses.map((a) => a.toLowerCase()));
    const hits = this.logs.filter((log) => {
      const n = Number(BigInt(log.blockNumber));
      return n >= filter.fromBlock && n <= filter.toBlock && wanted.has(log.address.toLowerCase());
    });
    if (hits.length > this.maxLogsPerCall) {
      throw new Error(`query returned more than ${this.maxLogsPerCall} results`);
    }
    return hits;
  }
}

export function blockMap(entries: readonly FakeBlock[]): Map<number, FakeBlock> {
  return new Map(entries.map((b) => [b.number, b]));
}
