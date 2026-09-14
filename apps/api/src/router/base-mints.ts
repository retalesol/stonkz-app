import type { Net } from '@stonkz/shared';

/**
 * Symbol -> mint/contract address, per net.
 *
 * Solana majors are permanent mainnet mints unless `SOLANA_CLUSTER` is not
 * mainnet-beta — then only SOL/WSOL are allowed unless overridden.
 * Robinhood defaults below are the **testnet (46630)** pins Robinhood documents.
 * Base defaults target **Base Sepolia** canonical WETH.
 */
const BASE_MINTS: Record<Net, Record<string, string>> = {
  SOL: {
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
  },
  RH: {
    ETH: '0x0000000000000000000000000000000000000000',
    WETH: '0x7943e237c7F95DA44E0301572D358911207852Fa',
    USDG: '0x7E955252E15c84f5768B83c41a71F9eba181802F',
    TSLA: '0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E',
    AMZN: '0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02',
    PLTR: '0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0',
    NFLX: '0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93',
    AMD: '0x71178BAc73cBeb415514eB542a8995b82669778d',
  },
  BASE: {
    ETH: '0x0000000000000000000000000000000000000000',
    WETH: '0x4200000000000000000000000000000000000006',
    // Base Sepolia USDC — override via BASE_MINT_OVERRIDES_BASE if your deployment differs.
    USDC: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  },
};

const DEVNET_SOL_ONLY: Record<string, string> = {
  SOL: BASE_MINTS.SOL['SOL'],
  WSOL: BASE_MINTS.SOL['WSOL'],
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
}

export interface BaseMintRegistry {
  /** `null` when the symbol is a known major/stock but has no configured address yet. */
  mintFor(net: Net, symbol: string): string | null;
  /** The reverse lookup `/launch/prepare` needs to re-derive a symbol from a client-supplied mint. */
  symbolFor(net: Net, mint: string): string | null;
}

export function createBaseMintRegistry(
  overrides: Partial<Record<Net, Record<string, string>>> & BaseMintRegistryOptions = {},
): BaseMintRegistry {
  const cluster = overrides.solanaCluster ?? 'mainnet-beta';
  const solTable =
    cluster === 'mainnet-beta'
      ? { ...BASE_MINTS.SOL, ...overrides.SOL }
      : { ...DEVNET_SOL_ONLY, ...overrides.SOL };

  const merged: Record<Net, Record<string, string>> = {
    SOL: solTable,
    RH: { ...BASE_MINTS.RH, ...overrides.RH },
    BASE: { ...BASE_MINTS.BASE, ...overrides.BASE },
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
