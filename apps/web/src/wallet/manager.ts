import type { Net } from '@stonkz/shared';
import { WalletError } from './errors.js';
import { connectEvmWallet, initEvmDiscovery, listEvmWallets, onEvmWalletsChange, type EvmConnectHooks } from './evm.js';
import { PRACTICE_WALLET_ID, connectPracticeWallet, practiceWalletChoice, practiceWalletEnabled } from './practice.js';
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
  const detected = net === 'SOL' ? listSolanaWallets() : listEvmWallets();
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
    throw new WalletError(
      'not_connected',
      `The connected wallet is on ${active.net === 'SOL' ? 'Solana' : 'Robinhood Chain'}; this action needs ` +
        `${net === 'SOL' ? 'Solana' : 'Robinhood Chain'}. Switch networks and reconnect.`,
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

function adopt(wallet: ConnectedWallet): ConnectedWallet {
  unbindAccountChange?.();
  active = wallet;
  unbindAccountChange = wallet.onAccountChange((address) => {
    if (address === null) {
      // The wallet locked or revoked us. Drop the session rather than keep
      // rendering an address that can no longer sign.
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

export async function connectWalletFor(net: Net, opts: ConnectOptions = {}): Promise<ConnectedWallet> {
  const choices = availableWallets(net);
  const id = opts.id ?? preferRealWallet(choices)?.id;
  if (id === undefined) {
    throw new WalletError('no_wallet', noWalletMessage(net));
  }
  const choice = choices.find((c) => c.id === id);
  if (choice?.unavailable) throw new WalletError('unconfigured', choice.unavailable);

  // Only one live session, so drop the previous one first — otherwise a net
  // switch leaves an authorised extension listening for account changes it
  // will never be asked about again.
  if (active) await disconnectActive();

  if (id === PRACTICE_WALLET_ID) return adopt(connectPracticeWallet(net));
  if (net === 'SOL') return adopt(await connectSolanaWallet(id));
  return adopt(
    await connectEvmWallet(id, opts.onWalletConnectUri ? { onWalletConnectUri: opts.onWalletConnectUri } : {}),
  );
}

function noWalletMessage(net: Net): string {
  if (net === 'SOL') {
    return (
      'No Solana wallet detected. Install a Wallet Standard wallet (Phantom, Solflare, Backpack) and reload' +
      (practiceWalletEnabled() ? ', or pick the practice key.' : '.')
    );
  }
  return (
    'No Robinhood Chain wallet available. Robinhood Wallet is mobile-only, so desktop needs WalletConnect ' +
    '(or an extension with chain 4663 added).'
  );
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
