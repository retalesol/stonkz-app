/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** REST base, e.g. https://api.ston.kz */
  readonly VITE_API_URL: string;
  /** WS base, e.g. wss://api.ston.kz */
  readonly VITE_WS_URL: string;
  /** Solana cluster: mainnet-beta | devnet | localnet */
  readonly VITE_CLUSTER: string;
  /** Helius RPC endpoint for Solana reads. */
  readonly VITE_HELIUS_RPC: string;
  /** Jupiter Swap API base. */
  readonly VITE_JUPITER: string;
  /** Robinhood Chain RPC endpoint. */
  readonly VITE_RH_RPC: string;
  /** Robinhood Chain id, decimal. */
  readonly VITE_RH_CHAIN_ID: string;
  /** Uniswap Trading API base, used for the ETH leg. */
  readonly VITE_UNISWAP: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
