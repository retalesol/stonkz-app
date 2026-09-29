import type { EvmNet, NativeUnit, Net } from '@stonkz/shared';
import { nativeUnit as unitForNet } from '@stonkz/shared';
import { decodeErrorResult, type Hex } from 'viem';
import { JsonRpcError, jsonRpc } from './jsonrpc.js';
import {
  RpcError,
  type ChainRpc,
  type FetchLike,
  type NativeTransferSource,
  type NativeTransferVerification,
} from './types.js';

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
/** Testnet (46630) public RPC — the default whenever the configured chain id is the testnet. */
export const RH_TESTNET_PUBLIC_RPC_URL = 'https://rpc.testnet.chain.robinhood.com';

/** `balanceOf(address)` selector — used to clamp max-sell amounts to the wallet. */
const BALANCE_OF_SELECTOR = '70a08231';

function encodeBalanceOfCall(owner: string): string {
  const addr = owner.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  return `0x${BALANCE_OF_SELECTOR}${addr}`;
}

/** Codes EVM clients use for "execution reverted" on `eth_call`. */
const REVERT_CODES = new Set([3, -32000, -32015]);

function isRevert(err: JsonRpcError): boolean {
  return (
    err.code === 3 || (REVERT_CODES.has(err.code) && /revert|insufficient funds/i.test(err.message))
  );
}

const ERROR_STRING_ABI = [
  { type: 'error', name: 'Error', inputs: [{ name: 'message', type: 'string' }] },
] as const;

/** `Error(string)` text when the node sent the payload; otherwise the node's own message. */
function revertReason(err: JsonRpcError): string {
  const data =
    typeof err.data === 'string'
      ? err.data
      : err.data &&
          typeof err.data === 'object' &&
          typeof (err.data as { data?: unknown }).data === 'string'
        ? (err.data as { data: string }).data
        : null;
  if (data && /^0x08c379a0/i.test(data)) {
    try {
      const decoded = decodeErrorResult({ abi: ERROR_STRING_ABI, data: data as Hex });
      const msg = decoded.args?.[0];
      if (typeof msg === 'string') return `execution reverted: ${msg}`;
    } catch {
      // Fall through to the node's message.
    }
  }
  if (data && /^0x[0-9a-f]{8}/i.test(data)) return `${err.message} (${data.slice(0, 10)})`;
  return err.message.replace(/^-?\d+\s+/, '');
}

export interface EvmRpcOptions {
  url: string;
  chainId: number;
  /** Which EVM product net this endpoint serves. Defaults to Robinhood Chain. */
  net?: EvmNet;
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
  readonly net: Net;
  readonly nativeUnit: NativeUnit;
  readonly chainId: number;

  private readonly url: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly onCall: (ok: boolean) => void;

  constructor(opts: EvmRpcOptions) {
    this.net = opts.net ?? 'RH';
    this.nativeUnit = unitForNet(this.net);
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
      throw new RpcError(this.net, method, err instanceof Error ? err.message : String(err), err);
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
   * `eth_call` at head. Used by the SIWE verifier's ERC-1271 fallback and by
   * `erc20BalanceAtoms` — read-only, raw calldata.
   */
  async ethCall(to: string, data: string): Promise<string> {
    return this.call<string>('eth_call', [{ to, data }, 'latest']);
  }

  /**
   * ERC-20 `balanceOf(owner)` in atoms. Used to clamp max-sell prepares so a
   * float-rounded client amount cannot exceed the wallet and revert `"balance"`.
   */
  async erc20BalanceAtoms(token: string, owner: string): Promise<bigint> {
    const data = encodeBalanceOfCall(owner);
    const raw = await this.ethCall(token, data);
    if (!raw || raw === '0x') return 0n;
    return BigInt(raw);
  }

  /**
   * `eth_call` as `from`, for `/launch/prepare`'s pre-sign preflight. A node
   * reports a revert as a JSON-RPC error (code 3 / -32000 / -32015, with the
   * ABI-encoded `Error(string)` in `data` on most clients); that is a result
   * here, not an exception. Anything else — timeout, HTTP failure, a
   * malformed response — still throws `RpcError` so the caller can decide
   * not to block on a flaky RPC.
   */
  async simulateCall(tx: {
    from: string;
    to: string;
    data: string;
    value?: string;
  }): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await jsonRpc<string>(
        this.fetchImpl,
        this.url,
        'eth_call',
        [
          { from: tx.from, to: tx.to, data: tx.data, ...(tx.value ? { value: tx.value } : {}) },
          'latest',
        ],
        { timeoutMs: this.timeoutMs },
      );
      this.onCall(true);
      return { ok: true };
    } catch (err) {
      if (err instanceof JsonRpcError && isRevert(err)) {
        this.onCall(true);
        return { ok: false, reason: revertReason(err) };
      }
      this.onCall(false);
      throw new RpcError(
        this.net,
        'eth_call',
        err instanceof Error ? err.message : String(err),
        err,
      );
    }
  }

  /** `routes/launch.ts`'s `/launch/confirm` — status + calldata + logs, to verify and to find the `TokenCreated` address. */
  async getTransactionReceipt(hash: string): Promise<{
    status: 'success' | 'reverted';
    from: string | null;
    to: string | null;
    input: string;
    logs: { address: string; topics: string[]; data: string; logIndex?: string | null }[];
    blockNumber: number | null;
  } | null> {
    const [receipt, tx] = await Promise.all([
      this.call<{
        status: string;
        from?: string | null;
        to: string | null;
        blockNumber?: string | null;
        logs: { address: string; topics: string[]; data: string; logIndex?: string | null }[];
      } | null>('eth_getTransactionReceipt', [hash]),
      this.call<{ input?: string; data?: string } | null>('eth_getTransactionByHash', [hash]),
    ]);
    if (!receipt || !tx) return null;
    return {
      status: receipt.status === '0x1' ? 'success' : 'reverted',
      from: receipt.from ?? null,
      to: receipt.to,
      // `input` on older nodes, `data` is the ethers-style alias some RPCs use.
      input: tx.input ?? tx.data ?? '0x',
      logs: receipt.logs,
      blockNumber: receipt.blockNumber ? Number.parseInt(receipt.blockNumber, 16) : null,
    };
  }

  /** `/trade/confirm`'s provisional fill timestamp — the same block time the indexer stamps. */
  async getBlockTimestampMs(blockNumber: number): Promise<number | null> {
    const block = await this.call<{ timestamp?: string } | null>('eth_getBlockByNumber', [
      `0x${blockNumber.toString(16)}`,
      false,
    ]);
    if (!block?.timestamp) return null;
    const seconds = Number.parseInt(block.timestamp, 16);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
  }

  /**
   * `social/tips.ts`'s only chain-facing call. A plain native transfer's
   * `value` is on the transaction itself, not derivable from the receipt
   * alone, so both are fetched — mirroring `getTransactionReceipt`'s own
   * two-call shape above.
   */
  async getNativeTransfer(hash: string): Promise<NativeTransferVerification> {
    const [receipt, tx] = await Promise.all([
      this.call<{ status: string; blockNumber: string } | null>('eth_getTransactionReceipt', [
        hash,
      ]),
      this.call<{ from?: string; to?: string | null; value?: string } | null>(
        'eth_getTransactionByHash',
        [hash],
      ),
    ]);
    if (!receipt || !tx) {
      return {
        found: false,
        status: 'failed',
        from: null,
        to: null,
        amountNative: null,
        blockTimeMs: null,
      };
    }

    let blockTimeMs: number | null = null;
    try {
      const block = await this.call<{ timestamp: string } | null>('eth_getBlockByNumber', [
        receipt.blockNumber,
        false,
      ]);
      if (block) blockTimeMs = Number.parseInt(block.timestamp, 16) * 1000;
    } catch {
      // Left null on failure. `verifyTip` treats a null block time as
      // `unknown_age` and refuses the tip (security review L1), so a
      // transient failure here costs the user a retry rather than letting an
      // arbitrarily old transfer pass the recency check. Deliberately the
      // safer direction: the sender/recipient/amount checks are unaffected,
      // so this only ever rejects, never accepts.
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
      throw new RpcError(
        this.net,
        'eth_chainId',
        `expected ${this.chainId}, endpoint reports ${actual}`,
      );
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
