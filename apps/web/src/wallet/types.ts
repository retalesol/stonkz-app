import type { EvmGasPreset, EvmNet, MevMode, Net } from '@stonkz/shared';

/**
 * The one interface every write path in the app signs through.
 *
 * Three implementations satisfy it: `wallet/solana.ts` (Wallet Standard),
 * `wallet/evm.ts` (EIP-1193 — an injected extension or WalletConnect), and
 * `wallet/practice.ts` (the hard-gated browser-local keypair that used to be
 * the *only* implementation). Nothing above this layer knows which one it
 * has, except for `practice`, which the UI is required to surface.
 */

export type WalletKind = 'solana-standard' | 'evm-injected' | 'evm-walletconnect' | 'practice';

/** An offer in the wallet picker — detected, not connected. */
export interface WalletChoice {
  /** Stable id for the picker's `data-` attribute and `connect()`. */
  readonly id: string;
  readonly net: Net;
  readonly kind: WalletKind;
  /** Display name, as the wallet reports it (`Phantom`, `MetaMask`, …). */
  readonly name: string;
  /** A `data:` URI the wallet supplied, if any. Never a remote URL. */
  readonly icon?: string;
  /**
   * Set when the choice cannot actually be used right now, with the reason —
   * e.g. WalletConnect with no project id configured. Rendered as a disabled
   * row with the reason visible, rather than silently omitted.
   */
  readonly unavailable?: string;
}

/** How a Solana transaction went out. `wallet` = the wallet's own RPC (the pre-MEV path). */
export type SolanaSendRoute = 'wallet' | 'jito' | 'private' | 'rpc';

/**
 * The MEV-protected send `apps/api`'s `POST /trade/broadcast` performs on
 * signed bytes. Supplied by `api/live.ts` on a Solana payload whose MEV mode
 * is `SHIELD`/`RELAY`; the wallet layer never imports the API client itself.
 */
export type SolanaBroadcastFn = (
  signedTransactionBase64: string,
) => Promise<{ signature: string; via: 'jito' | 'private' | 'rpc'; fallback?: string }>;

/** What a prepared transaction looks like by the time it reaches a signer. */
export type SignPayload =
  | {
      readonly net: 'SOL';
      /** Base64 of a serialised (legacy or v0) transaction, as `/trade/prepare` returns it. */
      readonly transaction: string;
      readonly lastValidBlockHeight?: number;
      /**
       * Settings MEV mode. With `SHIELD`/`RELAY` and a `broadcast` function
       * the wallet signs without sending and the bytes go through
       * `broadcast`; anything else is the wallet's own send.
       */
      readonly mev?: MevMode;
      readonly broadcast?: SolanaBroadcastFn;
    }
  | {
      readonly net: EvmNet;
      readonly to: string;
      /** `0x`-prefixed calldata. */
      readonly data: string;
      /** Decimal wei, as the API returns it. */
      readonly value: string;
      /** Settings gas preset; absent / `NORMAL` leaves fees to the wallet. */
      readonly gas?: EvmGasPreset;
    };

export interface BroadcastResult {
  /** Base58 signature on Solana, `0x…` transaction hash on Robinhood Chain. */
  readonly signature: string;
  readonly explorerUrl?: string;
  /** Solana: the route the transaction actually took (see `SolanaSendRoute`). */
  readonly route?: SolanaSendRoute;
  /** Solana: set when an MEV route was requested but the send fell back — the reason. */
  readonly routeFallback?: string;
  /** EVM: the EIP-1559 fields this layer set explicitly, if any (decimal wei strings). */
  readonly gasFields?: { maxFeePerGas: string; maxPriorityFeePerGas: string };
  /**
   * True only from `wallet/practice.ts`: nothing was broadcast and nothing
   * settled. Every caller that reports success to the user must say so.
   */
  readonly simulated?: boolean;
}

export interface ConnectedWallet {
  readonly net: Net;
  readonly kind: WalletKind;
  /** `PHANTOM`, `METAMASK`, `WALLETCONNECT`, `PRACTICE KEY` — already terminal-cased. */
  readonly label: string;
  /** Base58 pubkey (SOL) or `0x…` (RH). */
  readonly address: string;
  /** True only for `wallet/practice.ts`. The UI badge is driven off this. */
  readonly practice: boolean;

  /**
   * Sign the exact SIWS/SIWE challenge string `GET /auth/nonce` returned.
   * Returns the signature in the encoding the server's verifier wants:
   * base58 for `auth/siws.ts`, `0x`-hex 65 bytes for `auth/siwe.ts`.
   */
  signInMessage(message: string): Promise<string>;

  /** Sign, broadcast, and wait for a real confirmation. */
  signAndSend(payload: SignPayload): Promise<BroadcastResult>;

  /**
   * EIP-712. Present on EVM wallets only — the `StonkzRouter` sell permit
   * (`docs/rh-trade-atomicity-gap.md` §5) needs it, nothing on Solana does.
   */
  signTypedData?(typedData: unknown): Promise<string>;

  /**
   * Move the wallet onto this connection's chain now (EVM switch / add-chain
   * prompt), ahead of any prepare call. Optional: Solana and WalletConnect
   * sessions are pinned to their chain and have nothing to switch.
   */
  ensureChain?(): Promise<void>;

  /** Native balance in whole units (SOL / ETH), or null if it could not be read. */
  nativeBalance(): Promise<number | null>;

  disconnect(): Promise<void>;

  /**
   * Account/chain changes pushed by the wallet. Called with `null` when the
   * wallet locked or disconnected on its own.
   */
  onAccountChange(cb: (address: string | null) => void): () => void;

  /**
   * The wallet moved to another chain mid-session (EVM `chainChanged`). The
   * session stays up; the app warns and `enforceEvmChain` still guards every
   * transaction. Absent on wallets that pin their chain (Solana, WalletConnect).
   */
  onChainChange?(cb: (chainId: number) => void): () => void;
}
