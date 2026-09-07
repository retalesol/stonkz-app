import type { NativeUnit, Net } from '@stonkz/shared';

/**
 * What the API needs from a chain. Deliberately tiny: no real keys exist yet,
 * so every consumer takes this interface and the test suite substitutes
 * `FakeChainRpc`. Program reads and transaction building arrive in Phase 2.
 */
export interface ChainRpc {
  readonly net: Net;
  readonly nativeUnit: NativeUnit;
  /** Solana slot, or EVM block number. */
  head(): Promise<number>;
  /** Native balance in whole units — SOL, not lamports; ETH, not wei. */
  nativeBalance(address: string): Promise<number>;
  /** Cheap reachability probe for `/health`. */
  healthy(): Promise<boolean>;
}

export interface PriceOracle {
  /**
   * Spot USD price of a native gas token. This is what replaces the hardcoded
   * `$214.08` in the footer; the connected net picks the unit.
   */
  nativeUsd(unit: NativeUnit): Promise<number>;
}

export type ChainRpcs = Record<Net, ChainRpc>;

/**
 * Extra capability only the Solana RPC implements — mirrors `EthCaller`'s
 * `ethCall` pattern (`app/deps.ts`'s `asEthCaller`). `router/solana-tx.ts`
 * needs a live blockhash to build a submittable (if still unsigned)
 * transaction; `FakeChainRpc` implements it too, with a deterministic fake
 * hash, so the composition path is exercised without a real RPC in tests.
 */
export interface SolanaBlockhashSource {
  latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
}

/**
 * `routes/launch.ts`'s `POST /launch/confirm` needs to read back the
 * transaction a signature names, to verify it matches what `/launch/prepare`
 * actually built rather than trusting client-reported params post-signature.
 * `getTransactionMessageBase64` returns just the compiled *message* bytes
 * (base64) — signatures excluded — since that is exactly what
 * `launch_intents.unsignedPayload` stores; `null` means not found or not yet
 * confirmed at the queried commitment.
 */
export interface SolanaTransactionSource {
  getTransactionMessageBase64(signature: string): Promise<string | null>;
}

/** A single decoded EVM log, the shape `routes/launch.ts` needs to find and decode `TokenCreated`. */
export interface EvmLog {
  address: string;
  topics: string[];
  data: string;
}

export interface EvmTransactionReceipt {
  status: 'success' | 'reverted';
  to: string | null;
  input: string;
  logs: EvmLog[];
}

/** `POST /launch/confirm` on Robinhood — mirrors `SolanaTransactionSource`'s job for EVM. */
export interface EvmTransactionSource {
  getTransactionReceipt(hash: string): Promise<EvmTransactionReceipt | null>;
}

export class RpcError extends Error {
  constructor(
    readonly net: Net,
    readonly method: string,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(`${net} ${method}: ${message}`);
    this.name = 'RpcError';
  }
}

/** Injected so tests never touch the network and prod can swap in a pooled agent. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
