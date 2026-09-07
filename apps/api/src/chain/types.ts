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
