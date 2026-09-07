import type { Net } from '@stonkz/shared';

/**
 * Symbol -> mint/contract address, per net. Plan step 90's "base mint
 * allow-list from `/base-tokens`" needs actual addresses; `MAJORS`/`STOCKS`
 * in `packages/shared` (reused here, not duplicated — see that import) only
 * carry `[symbol, name]`, because the read path never needed to resolve one
 * to an address.
 *
 * **Solana majors are the canonical, permanent mainnet mint addresses** —
 * these do not change and are safe to hardcode. **Robinhood Chain entries are
 * deliberately sparse.** `docs/robinhood-chain.md` §row 43 could not confirm
 * canonical USDC/USDT contract addresses on chain 4663, and this phase does
 * not invent them. Only `ETH` (native, no ERC-20 address — see
 * `router/compose.ts`'s `NATIVE_ETH_MINT`) and `WETH` are configured for RH;
 * every other RH major/stock in `packages/shared` is present in
 * `/base-tokens` for display but rejected by `/launch/prepare`'s allow-list
 * until a real address is added here or via `BASE_MINT_OVERRIDES_<NET>`.
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
    WETH: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', // aeWETH — docs/robinhood-chain.md row 25
  },
};

/** Any `BASE_MINT_OVERRIDES_SOL` / `BASE_MINT_OVERRIDES_RH` env var: `SYM:mint,SYM:mint`. */
export function parseBaseMintOverrides(raw: string | undefined): Record<string, string> {
  if (!raw || !raw.trim()) return {};
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const [sym, mint] = pair.split(':').map((s) => s.trim());
    if (sym && mint) out[sym.toUpperCase()] = mint;
  }
  return out;
}

export interface BaseMintRegistry {
  /** `null` when the symbol is a known major/stock but has no configured address yet. */
  mintFor(net: Net, symbol: string): string | null;
  /** The reverse lookup `/launch/prepare` needs to re-derive a symbol from a client-supplied mint. */
  symbolFor(net: Net, mint: string): string | null;
}

export function createBaseMintRegistry(overrides: Partial<Record<Net, Record<string, string>>> = {}): BaseMintRegistry {
  const merged: Record<Net, Record<string, string>> = {
    SOL: { ...BASE_MINTS.SOL, ...overrides.SOL },
    RH: { ...BASE_MINTS.RH, ...overrides.RH },
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
