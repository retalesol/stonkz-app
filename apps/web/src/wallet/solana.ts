import {
  SolanaSignAndSendTransaction,
  SolanaSignMessage,
  SolanaSignTransaction,
  type SolanaSignAndSendTransactionMethod,
  type SolanaSignMessageMethod,
  type SolanaSignTransactionMethod,
  type SolanaTransactionVersion,
} from '@solana/wallet-standard-features';
import { Connection, LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import {
  StandardConnect,
  StandardDisconnect,
  StandardEvents,
  type StandardConnectMethod,
  type StandardDisconnectMethod,
  type StandardEventsOnMethod,
} from '@wallet-standard/features';
import bs58 from 'bs58';
import { SOLANA_RPC_URL, solanaWalletStandardChain } from './chain.js';
import { WalletError, mapWalletError } from './errors.js';
import type {
  BroadcastResult,
  ConnectedWallet,
  SignPayload,
  SolanaSendRoute,
  WalletChoice,
} from './types.js';

/**
 * Real Solana wallets, over the Wallet Standard registry.
 *
 * `@wallet-standard/app`'s `getWallets()` is the whole integration: wallets
 * announce themselves on the window, the registry collects them, and each one
 * exposes its capabilities as named features. That is deliberately used
 * directly rather than through `@solana/wallet-adapter-*` — the adapter's
 * useful half is the React context and hook set, and this app has no React
 * (see this module's counterpart in `wallet/evm.ts` for the same call on the
 * EVM side).
 *
 * Two signing paths are supported, in preference order:
 *
 * 1. `solana:signAndSendTransaction` — the wallet broadcasts through its own
 *    RPC, which is what a user's wallet is configured for and what handles
 *    priority fees and retries best.
 * 2. `solana:signTransaction` + our own `sendRawTransaction` against
 *    `VITE_HELIUS_RPC`, for wallets that only sign.
 *
 * With MEV protection on (`payload.mev` is `SHIELD`/`RELAY` and the payload
 * carries a `broadcast` function) the order flips: the wallet only *signs*,
 * and the signed bytes go through `broadcast` — `apps/api`'s
 * `POST /trade/broadcast`, which submits to the Jito block engine or the
 * private RPC. A wallet's own `signAndSendTransaction` would send over its
 * own public RPC and silently discard the protection the trader paid a tip
 * for. If the relay is unreachable the bytes are sent over our RPC instead
 * and the result says so (`route: 'rpc'`, `routeFallback`), so the UI can
 * tell the trader the order went out unprotected.
 *
 * Either way this module then polls for a *real* confirmation before
 * resolving, so a caller that awaits `signAndSend()` knows the transaction
 * landed rather than merely that a wallet accepted it.
 *
 * The API hands over legacy transactions for plain launches and trades and
 * v0 (`VersionedTransaction`, address lookup tables) whenever a Jupiter hop
 * is in the route. Both go to the wallet as the same raw bytes — Wallet
 * Standard's transaction features take serialized bytes of either version —
 * but a wallet that declares it cannot sign v0 is refused up front with a
 * clear message rather than failing inside its own popup.
 */

/** The transaction confirmation poll gives up after this long. */
const CONFIRM_TIMEOUT_MS = 90_000;
const CONFIRM_POLL_MS = 900;

interface SolanaWalletFeatures {
  connect: StandardConnectMethod;
  disconnect: StandardDisconnectMethod | undefined;
  on: StandardEventsOnMethod | undefined;
  signMessage: SolanaSignMessageMethod;
  signAndSendTransaction: SolanaSignAndSendTransactionMethod | undefined;
  signTransaction: SolanaSignTransactionMethod | undefined;
  /** Each method's declared `supportedTransactionVersions`; `null` when the wallet does not say. */
  signAndSendVersions: readonly SolanaTransactionVersion[] | null;
  signTransactionVersions: readonly SolanaTransactionVersion[] | null;
}

function declaredVersions(
  wallet: Wallet,
  name: string,
): readonly SolanaTransactionVersion[] | null {
  const f = (wallet.features as Record<string, unknown>)[name] as
    { supportedTransactionVersions?: unknown } | undefined;
  const v = f?.supportedTransactionVersions;
  return Array.isArray(v) ? (v as SolanaTransactionVersion[]) : null;
}

function feature<T>(wallet: Wallet, name: string, method: string): T | undefined {
  const f = (wallet.features as Record<string, unknown>)[name] as
    Record<string, unknown> | undefined;
  const fn = f?.[method];
  return typeof fn === 'function' ? (fn.bind(f) as T) : undefined;
}

/**
 * A wallet is usable when it can sign for our cluster, can be connected, can
 * sign a message (for SIWS) and can get a transaction onto the chain one way
 * or another. Anything short of that is not offered, so the picker never
 * shows a row that would fail on click.
 */
function readFeatures(wallet: Wallet): SolanaWalletFeatures | null {
  const chain = solanaWalletStandardChain();
  if (!wallet.chains.includes(chain as `${string}:${string}`)) return null;
  const connect = feature<StandardConnectMethod>(wallet, StandardConnect, 'connect');
  const signMessage = feature<SolanaSignMessageMethod>(wallet, SolanaSignMessage, 'signMessage');
  const signAndSendTransaction = feature<SolanaSignAndSendTransactionMethod>(
    wallet,
    SolanaSignAndSendTransaction,
    'signAndSendTransaction',
  );
  const signTransaction = feature<SolanaSignTransactionMethod>(
    wallet,
    SolanaSignTransaction,
    'signTransaction',
  );
  if (!connect || !signMessage) return null;
  if (!signAndSendTransaction && !signTransaction) return null;
  return {
    connect,
    signMessage,
    disconnect: feature<StandardDisconnectMethod>(wallet, StandardDisconnect, 'disconnect'),
    on: feature<StandardEventsOnMethod>(wallet, StandardEvents, 'on'),
    signAndSendTransaction,
    signTransaction,
    signAndSendVersions: declaredVersions(wallet, SolanaSignAndSendTransaction),
    signTransactionVersions: declaredVersions(wallet, SolanaSignTransaction),
  };
}

function registeredWallets(): Wallet[] {
  try {
    return [...getWallets().get()];
  } catch {
    // No `window` (unit tests) or a registry that refused to initialise.
    return [];
  }
}

/**
 * The picker row for one registered wallet, or null if it cannot do the job.
 *
 * Split out from `listSolanaWallets()` so the selection rule — right cluster,
 * connectable, can sign a message, can get a transaction on chain — is
 * testable against hand-built `Wallet` objects with no browser registry.
 */
export function solanaWalletChoice(wallet: Wallet): WalletChoice | null {
  if (readFeatures(wallet) === null) return null;
  return {
    id: wallet.name,
    net: 'SOL',
    kind: 'solana-standard',
    name: wallet.name,
    // Wallet Standard icons are `data:` URIs by spec, so this never reaches
    // out to a third-party host from the wallet picker.
    ...(wallet.icon ? { icon: wallet.icon } : {}),
  };
}

/** Every installed wallet that can actually sign for the configured cluster. */
export function listSolanaWallets(): WalletChoice[] {
  return registeredWallets()
    .map(solanaWalletChoice)
    .filter((c): c is WalletChoice => c !== null);
}

/** Fires when a wallet registers or unregisters, so an open picker can re-render. */
export function onSolanaWalletsChange(cb: () => void): () => void {
  try {
    const wallets = getWallets();
    const offRegister = wallets.on('register', cb);
    const offUnregister = wallets.on('unregister', cb);
    return () => {
      offRegister();
      offUnregister();
    };
  } catch {
    return () => undefined;
  }
}

function toBytes(base64: string): Uint8Array {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

/**
 * The message version of a serialized transaction: after the compact-u16
 * signature count and the signatures, a legacy message starts with its
 * header's signer count (< 0x80); a versioned one with `0x80 | version`.
 * The bytes are then fully deserialized, so a truncated or corrupt payload
 * fails here with a readable error instead of inside the wallet.
 */
export function solanaTransactionVersion(bytes: Uint8Array): SolanaTransactionVersion {
  let offset = 0;
  let sigCount = 0;
  for (let shift = 0; offset < bytes.length; shift += 7) {
    const b = bytes[offset++]!;
    sigCount |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
  }
  const prefix = bytes[offset + sigCount * 64];
  if (prefix === undefined) {
    throw new WalletError('unknown', 'The prepared transaction is malformed. Prepare it again.');
  }
  if (prefix & 0x80 && (prefix & 0x7f) !== 0) {
    throw new WalletError(
      'unsupported_method',
      `Transaction version ${prefix & 0x7f} is not supported. Prepare it again.`,
    );
  }
  try {
    VersionedTransaction.deserialize(bytes);
  } catch {
    throw new WalletError('unknown', 'The prepared transaction is malformed. Prepare it again.');
  }
  return prefix & 0x80 ? 0 : 'legacy';
}

let connection: Connection | null = null;
function rpc(): Connection {
  connection ??= new Connection(SOLANA_RPC_URL, 'confirmed');
  return connection;
}

/**
 * Wait for a real confirmation.
 *
 * Two exit conditions beyond success: the transaction's own error (mapped so a
 * slippage revert reads differently from a lamport shortfall), and the block
 * height passing `lastValidBlockHeight`, which is the only way to know a
 * transaction can never land rather than merely has not yet.
 */
async function awaitConfirmation(signature: string, lastValidBlockHeight?: number): Promise<void> {
  const conn = rpc();
  const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
  for (;;) {
    let status;
    try {
      status = (await conn.getSignatureStatuses([signature])).value[0];
    } catch (err) {
      const mapped = mapWalletError(
        err,
        'Could not reach the Solana RPC to confirm this transaction.',
      );
      // Already broadcast: it may still land, so hand the signature up.
      mapped.signature = signature;
      throw mapped;
    }
    if (status) {
      if (status.err) {
        throw mapWalletError(
          new Error('Transaction failed on chain: ' + JSON.stringify(status.err)),
          'The transaction failed on chain.',
        );
      }
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')
        return;
    }
    if (lastValidBlockHeight !== undefined) {
      const height = await conn.getBlockHeight('confirmed').catch(() => null);
      if (height !== null && height > lastValidBlockHeight) {
        throw new WalletError(
          'timeout',
          'The transaction expired before it landed — the quote block height passed. Try again.',
        );
      }
    }
    if (Date.now() > deadline) {
      throw new WalletError(
        'timeout',
        'No confirmation after 90s. The transaction may still land; check the explorer.',
        { signature },
      );
    }
    await new Promise((r) => setTimeout(r, CONFIRM_POLL_MS));
  }
}

function explorerUrl(signature: string): string {
  const cluster = solanaWalletStandardChain();
  const suffix = cluster === 'solana:mainnet' ? '' : '?cluster=' + cluster.slice('solana:'.length);
  return 'https://explorer.solana.com/tx/' + signature + suffix;
}

class SolanaStandardWallet implements ConnectedWallet {
  readonly net = 'SOL' as const;
  readonly kind = 'solana-standard' as const;
  readonly practice = false;

  constructor(
    private readonly wallet: Wallet,
    private readonly features: SolanaWalletFeatures,
    private account: WalletAccount,
  ) {}

  get label(): string {
    return this.wallet.name.toUpperCase();
  }

  get address(): string {
    return this.account.address;
  }

  async signInMessage(message: string): Promise<string> {
    try {
      const [out] = await this.features.signMessage({
        account: this.account,
        message: new TextEncoder().encode(message),
      });
      if (!out) throw new WalletError('unknown', 'The wallet returned no signature.');
      // `auth/siws.ts` decodes base58 and verifies against the base58 address.
      return bs58.encode(out.signature);
    } catch (err) {
      throw mapWalletError(err, 'The wallet would not sign the sign-in message.');
    }
  }

  async signAndSend(payload: SignPayload): Promise<BroadcastResult> {
    if (payload.net !== 'SOL') {
      throw new WalletError(
        'unsupported_method',
        'A Solana wallet cannot sign a Robinhood Chain transaction.',
      );
    }
    const bytes = toBytes(payload.transaction);
    const chain = solanaWalletStandardChain() as `${string}:${string}`;
    const version = solanaTransactionVersion(bytes);
    // MEV protection needs the bytes back unsent, so sign-only is preferred
    // whenever the wallet offers it; otherwise the wallet's own send wins.
    const relay = payload.mev && payload.mev !== 'OFF' ? (payload.broadcast ?? null) : null;
    const signOnly =
      !!this.features.signTransaction && (!!relay || !this.features.signAndSendTransaction);
    const declared = signOnly
      ? this.features.signTransactionVersions
      : this.features.signAndSendVersions;
    if (declared && !declared.includes(version)) {
      throw new WalletError(
        'unsupported_method',
        version === 0
          ? `${this.wallet.name} cannot sign versioned (v0) transactions, which this route needs. ` +
              'Update the wallet, or use Phantom, Solflare or Backpack.'
          : `${this.wallet.name} cannot sign legacy transactions.`,
      );
    }

    let signature: string;
    let route: SolanaSendRoute = 'wallet';
    let routeFallback: string | undefined;
    if (signOnly && this.features.signTransaction) {
      let signed: Uint8Array;
      try {
        const [out] = await this.features.signTransaction({
          account: this.account,
          transaction: bytes,
          chain,
        });
        if (!out) throw new WalletError('unknown', 'The wallet returned no signed transaction.');
        signed = out.signedTransaction;
      } catch (err) {
        throw mapWalletError(err, 'The wallet would not sign this transaction.');
      }
      let relayed: Awaited<ReturnType<NonNullable<typeof relay>>> | null = null;
      if (relay) {
        try {
          relayed = await relay(toBase64(signed));
        } catch (err) {
          // The API relay is down or refused: the order still goes out, just
          // over the public RPC, and the caller is told so.
          routeFallback = 'relay: ' + (err instanceof Error ? err.message : String(err));
        }
      }
      if (relayed) {
        signature = relayed.signature;
        route = relayed.via;
        if (relayed.fallback) routeFallback = relayed.fallback;
      } else {
        try {
          signature = await rpc().sendRawTransaction(signed, {
            skipPreflight: false,
            preflightCommitment: 'confirmed',
          });
          route = 'rpc';
        } catch (err) {
          throw mapWalletError(err, 'The RPC refused this transaction.');
        }
      }
    } else if (this.features.signAndSendTransaction) {
      try {
        const [out] = await this.features.signAndSendTransaction({
          account: this.account,
          transaction: bytes,
          chain,
        });
        if (!out) throw new WalletError('unknown', 'The wallet returned no signature.');
        signature = bs58.encode(out.signature);
      } catch (err) {
        throw mapWalletError(err, 'The wallet would not send this transaction.');
      }
      if (relay) routeFallback = `${this.wallet.name} can only sign-and-send through its own RPC`;
    } else {
      throw new WalletError('unsupported_method', 'This wallet cannot send transactions.');
    }

    await awaitConfirmation(signature, payload.lastValidBlockHeight);
    return {
      signature,
      explorerUrl: explorerUrl(signature),
      route,
      ...(routeFallback ? { routeFallback } : {}),
    };
  }

  async nativeBalance(): Promise<number | null> {
    try {
      const lamports = await rpc().getBalance(new PublicKey(this.address), 'confirmed');
      return lamports / LAMPORTS_PER_SOL;
    } catch {
      return null;
    }
  }

  async disconnect(): Promise<void> {
    await this.features.disconnect?.().catch(() => undefined);
  }

  onAccountChange(cb: (address: string | null) => void): () => void {
    const on = this.features.on;
    if (!on) return () => undefined;
    return on('change', (props) => {
      if (!props.accounts) return;
      const next = props.accounts[0];
      if (!next) {
        cb(null);
        return;
      }
      this.account = next;
      cb(next.address);
    });
  }
}

/** Connect the named wallet and authorise one account. */
export async function connectSolanaWallet(
  id: string,
  opts: { silent?: boolean } = {},
): Promise<ConnectedWallet> {
  const wallet = registeredWallets().find((w) => w.name === id);
  if (!wallet) {
    throw new WalletError(
      'no_wallet',
      `${id} is no longer available. Is the extension still enabled?`,
    );
  }
  return openSolanaWallet(wallet, opts);
}

/** The connect half, against an already-resolved registry entry. */
export async function openSolanaWallet(
  wallet: Wallet,
  opts: { silent?: boolean } = {},
): Promise<ConnectedWallet> {
  const features = readFeatures(wallet);
  if (!features) {
    throw new WalletError(
      'unsupported_method',
      `${wallet.name} cannot sign for ${solanaWalletStandardChain()}. Switch its network, or use another wallet.`,
    );
  }
  // Already authorised accounts stay on the Wallet Standard entry across
  // reloads — reuse them on restore so we do not re-prompt.
  if (opts.silent && wallet.accounts.length > 0) {
    return new SolanaStandardWallet(wallet, features, wallet.accounts[0]!);
  }
  let accounts: readonly WalletAccount[];
  try {
    accounts = (await features.connect()).accounts;
  } catch (err) {
    throw mapWalletError(err, `${wallet.name} did not authorise this site.`);
  }
  const account = accounts[0];
  if (!account) {
    throw new WalletError('rejected', `${wallet.name} authorised no accounts.`);
  }
  return new SolanaStandardWallet(wallet, features, account);
}
