import type { NativeUnit, Net } from '@stonkz/shared';
import { RpcError, type ChainRpc, type ChainRpcs, type PriceOracle } from './types.js';

/**
 * The stand-in every test and the fixture producer run against. No real API
 * keys exist yet, so this is also what `pnpm dev` uses until they do.
 */
export class FakeChainRpc implements ChainRpc {
  private slot: number;
  private readonly balances = new Map<string, number>();
  private failing = false;

  constructor(
    readonly net: Net,
    readonly nativeUnit: NativeUnit,
    startHead = 1000,
  ) {
    this.slot = startHead;
  }

  setHead(value: number): void {
    this.slot = value;
  }

  advance(by = 1): number {
    this.slot += by;
    return this.slot;
  }

  setBalance(address: string, amount: number): void {
    this.balances.set(address, amount);
  }

  /** Simulates an RPC outage so `/health` and the error-rate metric can be tested. */
  setFailing(failing: boolean): void {
    this.failing = failing;
  }

  async head(): Promise<number> {
    if (this.failing) throw new RpcError(this.net, 'head', 'simulated outage');
    return this.slot;
  }

  async nativeBalance(address: string): Promise<number> {
    if (this.failing) throw new RpcError(this.net, 'nativeBalance', 'simulated outage');
    return this.balances.get(address) ?? 0;
  }

  async healthy(): Promise<boolean> {
    return !this.failing;
  }
}

export function createFakeRpcs(): ChainRpcs & { SOL: FakeChainRpc; RH: FakeChainRpc } {
  return { SOL: new FakeChainRpc('SOL', 'SOL', 250_000_000), RH: new FakeChainRpc('RH', 'ETH', 21_000_000) };
}

/** Frozen prices so USD assertions in tests are exact. */
export class FakePriceOracle implements PriceOracle {
  constructor(private readonly prices: Record<NativeUnit, number> = { SOL: 214.08, ETH: 4200 }) {}

  set(unit: NativeUnit, price: number): void {
    this.prices[unit] = price;
  }

  async nativeUsd(unit: NativeUnit): Promise<number> {
    return this.prices[unit];
  }
}
