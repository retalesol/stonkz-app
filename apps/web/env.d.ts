/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Data source: `sim` (default) keeps every number local; `live` swaps in
   * `src/api/live.ts`, which is unimplemented until Phase 1.
   */
  readonly VITE_API_MODE: 'sim' | 'live';
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
  /** Robinhood Chain id, decimal. Defaults to 4663 (mainnet). */
  readonly VITE_RH_CHAIN_ID: string;
  /** Robinhood Chain block explorer base, for share/verify links. */
  readonly VITE_RH_EXPLORER: string;
  /** Uniswap Trading API base, used for the ETH leg. */
  readonly VITE_UNISWAP: string;
  /**
   * WalletConnect project id. **Required** for Robinhood Chain: the Robinhood
   * Wallet is mobile-only, so desktop can only pair over WalletConnect
   * (`docs/robinhood-chain.md` row 32). With this unset, the WalletConnect
   * row in the wallet picker renders disabled with the reason shown — it
   * never falls back to a fake signer.
   */
  readonly VITE_WALLETCONNECT_PROJECT_ID: string;
  /**
   * `1` enables the browser-local practice keypair (`app/keys.ts`) as a
   * selectable wallet. Off by default, never on in a production build unless
   * `VITE_PRACTICE_WALLET_ACK=1` is also set — `vite.config.ts` fails the
   * build otherwise. Nothing signed by it settles.
   */
  readonly VITE_PRACTICE_WALLET: string;
  /** Deliberate acknowledgement required to build with `VITE_PRACTICE_WALLET=1`. */
  readonly VITE_PRACTICE_WALLET_ACK: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
