import type { EvmNet, NativeUnit, Net } from './types.js';
import { ALL_NETS } from './types.js';

/**
 * The network registry.
 *
 * Everything the product needs to know about a chain that is *not* an
 * environment secret (RPC URLs, contract addresses and chain ids live in each
 * app's env / `chain.ts`). Adding a net means one entry here plus the `Net`
 * union in `types.ts`; TypeScript's exhaustive `Record<Net, …>` maps flag every
 * other place that needs a row.
 */

export type ChainKind = 'SVM' | 'EVM';

export interface NetInfo {
  readonly k: Net;
  /** Picker / chip label, terminal-cased. */
  readonly name: string;
  /** Short label for badges and lane chips. */
  readonly short: string;
  readonly kind: ChainKind;
  /** The gas token, which is also what every ticket is denominated in. */
  readonly unit: NativeUnit;
  /** Decimals of the native value on the wire (lamports, wei, Arc native USDC). */
  readonly nativeDecimals: number;
  /** Decimals to show a native amount with. */
  readonly displayDecimals: number;
  /** Brand colour for dots, badges and the picker mark. */
  readonly col: string;
  /** Where a graduated curve migrates. */
  readonly dex: string;
  /** What happens to the LP at graduation, for the curve note. */
  readonly lpNote: string;
  /** Minimum wall tip in `unit`. */
  readonly tipMin: number;
  /** The base symbol a launch defaults to on this net. */
  readonly defaultBase: string;
  /** Which tokenized-stock list, if any, this net offers as a base. */
  readonly stocks: 'xstocks' | 'rh' | null;
  /** Wallets the picker should mention when nothing is detected. */
  readonly walletHint: string;
  /**
   * Hard cap on a single trade in USD, enforced in UI, API and router. Only
   * set on nets where "testing" means real funds (Arc's public testnet closed
   * on 17 Sep 2026; mainnet is the only Arc there is).
   */
  readonly maxTradeUsd?: number;
  /** One-line warning shown on the connect sheet, if any. */
  readonly gasNote?: string;
}

export const NET_INFO: Record<Net, NetInfo> = {
  SOL: {
    k: 'SOL',
    name: 'SOLANA',
    short: 'SOL',
    kind: 'SVM',
    unit: 'SOL',
    nativeDecimals: 9,
    displayDecimals: 2,
    col: '#14f195',
    dex: 'METEORA DLMM',
    lpNote: 'THE LP POSITION IS LOCKED IN THE PROGRAM ESCROW',
    tipMin: 0.001,
    defaultBase: 'SOL',
    stocks: 'xstocks',
    walletHint: 'INSTALL PHANTOM, SOLFLARE OR BACKPACK AND RELOAD.',
  },
  BASE: {
    k: 'BASE',
    name: 'COINBASE BASE',
    short: 'BASE',
    kind: 'EVM',
    unit: 'ETH',
    nativeDecimals: 18,
    displayDecimals: 4,
    col: '#0052ff',
    dex: 'UNISWAP',
    lpNote: 'LP TOKENS WERE BURNED',
    tipMin: 0.0001,
    defaultBase: 'ETH',
    stocks: null,
    walletHint: 'INSTALL COINBASE WALLET OR METAMASK, OR USE WALLETCONNECT.',
  },
  ARC: {
    k: 'ARC',
    name: 'ARC',
    short: 'ARC',
    kind: 'EVM',
    unit: 'USDC',
    nativeDecimals: 18,
    displayDecimals: 2,
    col: '#3b82f6',
    dex: 'UNISWAP',
    lpNote: 'LP TOKENS WERE BURNED',
    tipMin: 0.25,
    defaultBase: 'USDC',
    stocks: null,
    walletHint: 'INSTALL METAMASK OR COINBASE WALLET, OR USE WALLETCONNECT.',
    maxTradeUsd: 25,
    gasNote: 'GAS IS PAID IN USDC. THIS IS ARC MAINNET: REAL FUNDS, CAPPED AT $25 PER TRADE.',
  },
  RH: {
    k: 'RH',
    name: 'ROBINHOOD',
    short: 'RH',
    kind: 'EVM',
    unit: 'ETH',
    nativeDecimals: 18,
    displayDecimals: 4,
    col: '#00c805',
    dex: 'UNISWAP',
    lpNote: 'LP TOKENS WERE BURNED',
    tipMin: 0.0001,
    defaultBase: 'ETH',
    stocks: 'rh',
    walletHint:
      'ROBINHOOD WALLET IS MOBILE-ONLY, SO DESKTOP NEEDS WALLETCONNECT (OR AN EXTENSION WITH THE CHAIN ADDED).',
  },
};

export function netInfo(net: Net): NetInfo {
  return NET_INFO[net] ?? NET_INFO.SOL;
}

/** True for every EVM net (ETH or USDC gas, EVM tooling). */
export function isEvmNet(net: Net): net is EvmNet {
  return NET_INFO[net]?.kind === 'EVM';
}

/** The EVM nets in picker order. */
export const EVM_NETS: readonly EvmNet[] = ALL_NETS.filter(isEvmNet);

/**
 * A native amount formatted the way that chain's users read it: 4 decimals of
 * ETH, 2 of SOL or USDC. Arc's 18-decimal native USDC is already divided down
 * by the caller (`formatEther` gives whole USDC), so only the display width
 * differs here.
 */
export function fmtNative(net: Net, amount: number): string {
  const d = NET_INFO[net]?.displayDecimals ?? 2;
  return amount.toFixed(d);
}
