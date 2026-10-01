import type { Net } from '@stonkz/shared';
import { BASE_CHAIN_ID, BASE_SEPOLIA_CHAIN_ID } from '../chain/base.js';
import { RH_CHAIN_ID, RH_TESTNET_CHAIN_ID } from '../chain/evm.js';

/**
 * Symbol -> mint/contract address, per net.
 *
 * Solana majors are permanent mainnet mints unless `SOLANA_CLUSTER` is not
 * mainnet-beta — then only SOL/WSOL are allowed unless overridden.
 *
 * EVM tables are keyed by **chain id**, never by net alone, so a mainnet id
 * can never inherit a testnet address: RH 46630 / 4663 and Base 84532 / 8453
 * each carry their own pins (the same addresses `programs/evm/src/config/*.sol`
 * deploy against; the mainnet ones were read on chain on 2026-10-01). A chain
 * id with no table here fails closed at boot unless `BASE_MINT_OVERRIDES_<NET>`
 * supplies the addresses. Stock tokens exist only on RH testnet; mainnet v1
 * ships no stock bases, so none are listed for 4663.
 *
 * Arc has only its native marker: USDC *is* the gas token there, so the zero
 * address plays the role `ETH` plays on RH/Base. No canonical Arc ERC-20
 * addresses (wrapped USDC, EURC, USYC, …) are confirmed yet, so every other
 * `MAJORS.ARC` symbol resolves to `null` until pinned via
 * `BASE_MINT_OVERRIDES_ARC`.
 */
const NATIVE = '0x0000000000000000000000000000000000000000';

const SOL_MINTS: Record<string, string> = {
  SOL: 'So11111111111111111111111111111111111111112',
  WSOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  JITOSOL: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  WIF: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  JTO: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',
  RAY: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
  PYTH: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
};

/** EVM chain id -> symbol -> address. Mirrors `programs/evm/src/config/*.sol`. */
export const EVM_BASE_MINTS: Readonly<Record<number, Readonly<Record<string, string>>>> = {
  // Robinhood Chain testnet (`RobinhoodChainTestnet.sol`, `StockBases.sol`).
  [RH_TESTNET_CHAIN_ID]: {
    ETH: NATIVE,
    WETH: '0x7943e237c7F95DA44E0301572D358911207852Fa',
    USDG: '0x7E955252E15c84f5768B83c41a71F9eba181802F',
    TSLA: '0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E',
    AMZN: '0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02',
    PLTR: '0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0',
    NFLX: '0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93',
    AMD: '0x71178BAc73cBeb415514eB542a8995b82669778d',
  },
  // Robinhood Chain mainnet (`RobinhoodChain.sol`): WETH9 and Paxos USDG
  // (6 decimals), both verified on chain 2026-10-01. No stock bases in v1.
  [RH_CHAIN_ID]: {
    ETH: NATIVE,
    WETH: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
    USDG: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  },
  // Base Sepolia (`BaseSepolia.sol`).
  [BASE_SEPOLIA_CHAIN_ID]: {
    ETH: NATIVE,
    WETH: '0x4200000000000000000000000000000000000006',
    USDC: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  },
  // Base mainnet (`Base.sol`): the WETH predeploy and Circle native USDC
  // (6 decimals), both verified on chain 2026-10-01.
  [BASE_CHAIN_ID]: {
    ETH: NATIVE,
    WETH: '0x4200000000000000000000000000000000000006',
    USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  },
};

const ARC_MINTS: Record<string, string> = {
  USDC: NATIVE,
};

const DEVNET_SOL_ONLY: Record<string, string> = {
  SOL: SOL_MINTS['SOL'] as string,
  WSOL: SOL_MINTS['WSOL'] as string,
};

/** Any `BASE_MINT_OVERRIDES_*` env var: `SYM:mint,SYM:mint`. */
export function parseBaseMintOverrides(raw: string | undefined): Record<string, string> {
  if (!raw || !raw.trim()) return {};
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const [sym, mint] = pair.split(':').map((s) => s.trim());
    if (sym && mint) out[sym.toUpperCase()] = mint;
  }
  return out;
}

export interface BaseMintRegistryOptions {
  solanaCluster?: 'mainnet-beta' | 'devnet' | 'testnet' | 'localnet';
  /**
   * The configured EVM chain ids (`RH_CHAIN_ID`, `BASE_CHAIN_ID`). Default:
   * the same env vars, else the testnets — so a boot with `RH_CHAIN_ID=4663`
   * resolves mainnet pins without every caller threading the id through.
   */
  rhChainId?: number;
  baseChainId?: number;
}

export interface BaseMintRegistry {
  /** `null` when the symbol is a known major/stock but has no configured address yet. */
  mintFor(net: Net, symbol: string): string | null;
  /** The reverse lookup `/launch/prepare` needs to re-derive a symbol from a client-supplied mint. */
  symbolFor(net: Net, mint: string): string | null;
}

function chainIdFromEnv(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * The table for an EVM net on `chainId`, merged with the operator's
 * overrides. A chain id this file has no pins for is refused unless the
 * overrides name at least the wrapped native token: better a boot error than
 * a mainnet quoting testnet addresses.
 */
export function evmBaseMintTable(
  net: 'RH' | 'BASE',
  chainId: number,
  overrides: Record<string, string> = {},
): Record<string, string> {
  const pinned = EVM_BASE_MINTS[chainId];
  if (pinned) return { ...pinned, ...overrides };
  if (overrides['WETH']) return { ETH: NATIVE, ...overrides };
  throw new Error(
    `base-mints: no base-mint table for ${net} chain id ${chainId}; set BASE_MINT_OVERRIDES_${net} (at least WETH:<address>) or a supported ${net}_CHAIN_ID`,
  );
}

export function createBaseMintRegistry(
  overrides: Partial<Record<Net, Record<string, string>>> & BaseMintRegistryOptions = {},
): BaseMintRegistry {
  const cluster = overrides.solanaCluster ?? 'mainnet-beta';
  const solTable =
    cluster === 'mainnet-beta'
      ? { ...SOL_MINTS, ...overrides.SOL }
      : { ...DEVNET_SOL_ONLY, ...overrides.SOL };
  const rhChainId = overrides.rhChainId ?? chainIdFromEnv('RH_CHAIN_ID', RH_TESTNET_CHAIN_ID);
  const baseChainId =
    overrides.baseChainId ?? chainIdFromEnv('BASE_CHAIN_ID', BASE_SEPOLIA_CHAIN_ID);

  const merged: Record<Net, Record<string, string>> = {
    SOL: solTable,
    RH: evmBaseMintTable('RH', rhChainId, overrides.RH),
    BASE: evmBaseMintTable('BASE', baseChainId, overrides.BASE),
    ARC: { ...ARC_MINTS, ...overrides.ARC },
  };

  return {
    mintFor(net, symbol) {
      return merged[net][symbol.toUpperCase()] ?? null;
    },
    symbolFor(net, mint) {
      const table = merged[net];
      const lowerMint = mint.toLowerCase();
      for (const [sym, addr] of Object.entries(table)) {
        if (addr.toLowerCase() === lowerMint) return sym;
      }
      return null;
    },
  };
}
