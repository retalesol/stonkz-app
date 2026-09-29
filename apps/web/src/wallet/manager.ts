import type { Net } from '@stonkz/shared';
import { NET_INFO, isEvm } from '@stonkz/shared';
import { WalletError } from './errors.js';
import {
  connectEvmWallet,
  initEvmDiscovery,
  listEvmWallets,
  onEvmWalletsChange,
  type EvmConnectHooks,
} from './evm.js';
import {
  PRACTICE_WALLET_ID,
  connectPracticeWallet,
  practiceWalletChoice,
  practiceWalletEnabled,
} from './practice.js';
import { clearLastWallet, rememberLastWallet } from './persist.js';
import { connectSolanaWallet, listSolanaWallets, onSolanaWalletsChange } from './solana.js';
import type { ConnectedWallet, WalletChoice } from './types.js';

/**
 * Which wallet is connected, and which ones could be.
 *
 * One connection at a time, keyed by net: switching chains disconnects the
 * previous wallet rather than holding two live sessions, which matches what
 * the header chip has always shown and keeps `app/session.ts`'s one-JWT model
 * honest.
 */

let active: ConnectedWallet | null = null;
let unbindAccountChange: (() => void) | null = null;
const changeListeners = new Set<() => void>();

/**
 * Practice mode never outranks a real wallet.
 *
 * This is the ordering half of the "real wallet wins" rule: the picker
 * renders in this order and `preferRealWallet()` reads from the top, so a
 * build with `VITE_PRACTICE_WALLET=1` *and* Phantom installed offers Phantom
 * first and never auto-selects the practice key. Pure, so the property is a
 * unit test.
 */
export function sortChoices(choices: readonly WalletChoice[]): WalletChoice[] {
  const rank = (c: WalletChoice): number => {
    if (c.kind === 'practice') return 3;
    if (c.unavailable) return 2;
    return 1;
  };
  return [...choices].sort((a, b) => rank(a) - rank(b));
}

/** The wallet to use when the user has expressed no preference, or null. */
export function preferRealWallet(choices: readonly WalletChoice[]): WalletChoice | null {
  const usable = sortChoices(choices).filter((c) => !c.unavailable);
  return usable.find((c) => c.kind !== 'practice') ?? usable[0] ?? null;
}

/** Everything this browser could connect for `net`, best-first. */
export function availableWallets(net: Net): WalletChoice[] {
  const detected = isEvm(net) ? listEvmWallets(net) : listSolanaWallets();
  const practice = practiceWalletChoice(net);
  return sortChoices(practice ? [...detected, practice] : detected);
}

/** Fires when the set of installed wallets changes, so an open picker re-renders. */
export function onAvailableWalletsChange(cb: () => void): () => void {
  const offSol = onSolanaWalletsChange(cb);
  const offEvm = onEvmWalletsChange(cb);
  return () => {
    offSol();
    offEvm();
  };
}

export function activeWallet(): ConnectedWallet | null {
  return active;
}

/** The connected wallet for `net`, or a `not_connected` error naming what to do. */
export function requireWallet(net: Net): ConnectedWallet {
  if (!active) {
    throw new WalletError('not_connected', 'Connect a wallet before signing.');
  }
  if (active.net !== net) {
    const label = (n: Net) => NET_INFO[n].name;
    throw new WalletError(
      'not_connected',
      `The connected wallet is on ${label(active.net)}; this action needs ${label(net)}. Switch networks and reconnect.`,
    );
  }
  return active;
}

/** True when the session is running on the hard-gated practice key. */
export function isPracticeSession(): boolean {
  return active?.practice === true;
}

export function onActiveWalletChange(cb: () => void): () => void {
  changeListeners.add(cb);
  return () => changeListeners.delete(cb);
}

function announce(): void {
  for (const cb of changeListeners) cb();
}

const chainListeners = new Set<(chainId: number) => void>();
let unbindChainChange: (() => void) | undefined;

/** Fires when the active EVM wallet switches chain on its own; the app decides what to say. */
export function onChainChange(cb: (chainId: number) => void): () => void {
  chainListeners.add(cb);
  return () => chainListeners.delete(cb);
}

function adopt(wallet: ConnectedWallet): ConnectedWallet {
  unbindAccountChange?.();
  unbindChainChange?.();
  unbindChainChange = wallet.onChainChange?.((chainId) => {
    for (const cb of chainListeners) cb(chainId);
  });
  active = wallet;
  unbindAccountChange = wallet.onAccountChange((address) => {
    if (address === null) {
      // The wallet locked or revoked us. Drop the session rather than keep
      // rendering an address that can no longer sign.
      clearLastWallet();
      void disconnectActive();
      return;
    }
    announce();
  });
  announce();
  return wallet;
}

export interface ConnectOptions extends EvmConnectHooks {
  /** Explicit picker choice; omitted means "whatever `preferRealWallet` picks". */
  id?: string;
}

/**
 * Wait until EIP-6963 / Wallet Standard has announced `id`, or time out.
 * Extensions often inject a tick after first paint.
 *
 * Also resolves MetaMask id drift (`injected:io.metamask` ↔ `injected:window.ethereum`)
 * and case-insensitive Solana wallet names.
 */
export function resolveWalletChoice(net: Net, walletId: string): WalletChoice | undefined {
  const choices = availableWallets(net).filter((c) => !c.unavailable);
  const exact = choices.find((c) => c.id === walletId);
  if (exact) return exact;
  const lower = walletId.toLowerCase();
  const byCase = choices.find((c) => c.id.toLowerCase() === lower);
  if (byCase) return byCase;
  // MetaMask can announce as EIP-6963 or legacy window.ethereum across reloads.
  if (
    lower.includes('metamask') ||
    lower === 'injected:window.ethereum' ||
    lower.startsWith('injected:io.metamask')
  ) {
    return choices.find((c) => c.kind === 'evm-injected' && /metamask/i.test(c.name));
  }
  return undefined;
}

export function waitForWalletChoice(
  net: Net,
  id: string,
  timeoutMs = 5000,
): Promise<WalletChoice | null> {
  const found = (): WalletChoice | undefined => resolveWalletChoice(net, id);
  const hit = found();
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off();
      resolve(found() ?? null);
    }, timeoutMs);
    const off = onAvailableWalletsChange(() => {
      const next = found();
      if (!next) return;
      clearTimeout(timer);
      off();
      resolve(next);
    });
  });
}

export async function connectWalletFor(
  net: Net,
  opts: ConnectOptions = {},
): Promise<ConnectedWallet> {
  const choices = availableWallets(net);
  const id = opts.id ?? preferRealWallet(choices)?.id;
  if (id === undefined) {
    throw new WalletError('no_wallet', noWalletMessage(net));
  }
  const choice = resolveWalletChoice(net, id) ?? choices.find((c) => c.id === id);
  if (!choice) {
    throw new WalletError('no_wallet', noWalletMessage(net));
  }
  if (choice.unavailable) throw new WalletError('unconfigured', choice.unavailable);

  // Only one live session, so drop the previous one first — otherwise a net
  // switch leaves an authorised extension listening for account changes it
  // will never be asked about again.
  if (active) await disconnectActive();

  let wallet: ConnectedWallet;
  if (choice.id === PRACTICE_WALLET_ID) wallet = connectPracticeWallet(net);
  else if (net === 'SOL') wallet = await connectSolanaWallet(choice.id, { silent: !!opts.silent });
  else {
    wallet = await connectEvmWallet(choice.id, {
      net,
      ...(opts.onWalletConnectUri ? { onWalletConnectUri: opts.onWalletConnectUri } : {}),
      ...(opts.silent ? { silent: true } : {}),
    });
  }

  rememberLastWallet({ net, walletId: choice.id, address: wallet.address });
  return adopt(wallet);
}

function noWalletMessage(net: Net): string {
  if (net === 'SOL') {
    return (
      'No Solana wallet detected. Install a Wallet Standard wallet (Phantom, Solflare, Backpack) and reload' +
      (practiceWalletEnabled() ? ', or pick the practice key.' : '.')
    );
  }
  return 'No ' + NET_INFO[net].name + ' wallet available. ' + NET_INFO[net].walletHint;
}

export async function disconnectActive(): Promise<void> {
  const wallet = active;
  unbindAccountChange?.();
  unbindAccountChange = null;
  active = null;
  if (wallet) await wallet.disconnect().catch(() => undefined);
  announce();
}

/** Called once at boot: EIP-6963 announcements only arrive after we ask. */
export function initWalletDiscovery(): void {
  initEvmDiscovery();
}
