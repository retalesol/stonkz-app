import type { NativeUnit, Net } from '@stonkz/shared';
import {
  RpcError,
  type ChainRpc,
  type ChainRpcs,
  type NativeTransferSource,
  type NativeTransferVerification,
  type PriceOracle,
  type SimulationResult,
} from './types.js';

/**
 * The stand-in every test and the fixture producer run against. No real API
 * keys exist yet, so this is also what `pnpm dev` uses until they do.
 */
export type FakeEthCallHandler = (data: string) => Promise<string> | string;

export interface FakeEvmReceipt {
  status: 'success' | 'reverted';
  /** Sender; `/launch/confirm` refuses a receipt another wallet sent. */
  from?: string | null;
  to: string | null;
  input: string;
  logs: { address: string; topics: string[]; data: string }[];
}

export class FakeChainRpc implements ChainRpc, NativeTransferSource {
  private slot: number;
  private readonly balances = new Map<string, number>();
  private readonly contracts = new Map<string, FakeEthCallHandler>();
  private readonly solanaMessages = new Map<string, { messageBase64: string; failed: boolean }>();
  private readonly accounts = new Map<string, string>();
  private simulation: (payload: {
    from?: string;
    to?: string;
    data: string;
  }) => SimulationResult | Promise<SimulationResult> = () => ({ ok: true });
  private simulationFailing = false;
  private readonly evmReceipts = new Map<string, FakeEvmReceipt>();
  private readonly transfers = new Map<string, NativeTransferVerification>();
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

  /**
   * Puts code at an address. Only the SIWE verifier's ERC-1271 fallback uses
   * this, so the handler takes raw calldata rather than an ABI.
   */
  setContract(address: string, handler: FakeEthCallHandler): void {
    this.contracts.set(address.toLowerCase(), handler);
  }

  /** `routes/launch.test.ts` seeds what a submitted, confirmed Solana signature "contains". */
  setSolanaTransactionMessage(
    signature: string,
    messageBase64: string,
    opts: { failed?: boolean } = {},
  ): void {
    this.solanaMessages.set(signature, { messageBase64, failed: opts.failed ?? false });
  }

  /** Raw account bytes (base64) `getAccountDataBase64` serves — e.g. a Solana BaseOracle. */
  setAccountData(address: string, base64: string | null): void {
    if (base64 === null) this.accounts.delete(address);
    else this.accounts.set(address, base64);
  }

  /**
   * What `/launch/prepare`'s preflight sees: a fixed result or a function of
   * the simulated payload (the calldata on EVM, the wire tx on Solana).
   */
  setSimulation(
    result:
      | SimulationResult
      | ((payload: { from?: string; to?: string; data: string }) => SimulationResult),
  ): void {
    this.simulation = typeof result === 'function' ? result : () => result;
  }

  /** Makes only the simulation call fail at the transport level (timeout, 5xx). */
  setSimulationFailing(failing: boolean): void {
    this.simulationFailing = failing;
  }

  async simulateCall(tx: { from: string; to: string; data: string }): Promise<SimulationResult> {
    if (this.failing || this.simulationFailing)
      throw new RpcError(this.net, 'eth_call', 'simulated outage');
    return this.simulation(tx);
  }

  async simulateTransaction(base64Tx: string): Promise<SimulationResult> {
    if (this.failing || this.simulationFailing)
      throw new RpcError(this.net, 'simulateTransaction', 'simulated outage');
    return this.simulation({ data: base64Tx });
  }

  async getAccountDataBase64(address: string): Promise<string | null> {
    if (this.failing) throw new RpcError(this.net, 'getAccountInfo', 'simulated outage');
    return this.accounts.get(address) ?? null;
  }

  /** `routes/launch.test.ts` seeds what an EVM tx hash "receipted" as. */
  setEvmReceipt(hash: string, receipt: FakeEvmReceipt): void {
    this.evmReceipts.set(hash.toLowerCase(), receipt);
  }

  async ethCall(to: string, data: string): Promise<string> {
    if (this.failing) throw new RpcError(this.net, 'eth_call', 'simulated outage');
    const handler = this.contracts.get(to.toLowerCase());
    // A real node returns empty data for a codeless address, and the caller
    // must read that as a refusal rather than a success.
    if (!handler) return '0x';
    return handler(data);
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

  /**
   * A deterministic fake base58 hash, so a test asserting on the composed
   * transaction's bytes is reproducible. Only meaningful for the `SOL` net —
   * nothing on `RH` calls this.
   */
  async latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    if (this.failing) throw new RpcError(this.net, 'getLatestBlockhash', 'simulated outage');
    // Base58 of 32 zero bytes — the same string `PublicKey.default.toBase58()`
    // produces, i.e. a value `bs58.decode` accepts as a real 32-byte hash.
    return { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: this.slot + 150 };
  }

  async getTransactionMessageBase64(signature: string): Promise<string | null> {
    if (this.failing) throw new RpcError(this.net, 'getTransaction', 'simulated outage');
    return this.solanaMessages.get(signature)?.messageBase64 ?? null;
  }

  async getTransactionOutcome(
    signature: string,
  ): Promise<{ messageBase64: string; failed: boolean } | null> {
    if (this.failing) throw new RpcError(this.net, 'getTransaction', 'simulated outage');
    return this.solanaMessages.get(signature) ?? null;
  }

  async getTransactionReceipt(hash: string): Promise<FakeEvmReceipt | null> {
    if (this.failing) throw new RpcError(this.net, 'eth_getTransactionReceipt', 'simulated outage');
    return this.evmReceipts.get(hash.toLowerCase()) ?? null;
  }

  /** `social/tips.test.ts` seeds what a signature "verified" as on-chain. */
  setNativeTransfer(signature: string, transfer: NativeTransferVerification): void {
    this.transfers.set(signature, transfer);
  }

  async getNativeTransfer(signature: string): Promise<NativeTransferVerification> {
    if (this.failing) throw new RpcError(this.net, 'getNativeTransfer', 'simulated outage');
    return (
      this.transfers.get(signature) ?? {
        found: false,
        status: 'failed',
        from: null,
        to: null,
        amountNative: null,
        blockTimeMs: null,
      }
    );
  }
}

export function createFakeRpcs(): ChainRpcs & {
  SOL: FakeChainRpc;
  RH: FakeChainRpc;
  BASE: FakeChainRpc;
  ARC: FakeChainRpc;
} {
  return {
    SOL: new FakeChainRpc('SOL', 'SOL', 250_000_000),
    RH: new FakeChainRpc('RH', 'ETH', 21_000_000),
    BASE: new FakeChainRpc('BASE', 'ETH', 21_000_000),
    ARC: new FakeChainRpc('ARC', 'USDC', 1_000_000),
  };
}

/** Frozen prices so USD assertions in tests are exact. USDC is 1 by definition. */
export class FakePriceOracle implements PriceOracle {
  constructor(
    private readonly prices: Record<NativeUnit, number> = { SOL: 214.08, ETH: 4200, USDC: 1 },
  ) {}

  set(unit: NativeUnit, price: number): void {
    this.prices[unit] = price;
  }

  async nativeUsd(unit: NativeUnit): Promise<number> {
    return this.prices[unit];
  }
}
