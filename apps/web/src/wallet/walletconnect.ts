import type { UniversalProvider } from '@walletconnect/universal-provider';
import type { Net } from '@stonkz/shared';
import { BASE_RPC_URL, RH_RPC_URL, evmChainIdForNet } from './chain.js';
import { WalletError, mapWalletError } from './errors.js';
import type { Eip1193Provider } from './evm.js';

/**
 * WalletConnect pairing for Robinhood Chain.
 *
 * This is not an optional convenience connector. `docs/robinhood-chain.md`
 * row 32 / §6.1: **Robinhood Wallet is mobile-only and ships no browser
 * extension**, so a desktop user has no `window.ethereum` for it and
 * WalletConnect's QR pairing is the only path. Row 33 confirms Robinhood
 * Chain is in the WalletConnect network set.
 *
 * `@walletconnect/universal-provider` is used rather than
 * `@walletconnect/ethereum-provider` for one concrete reason: the latter
 * depends on `@reown/appkit`, a 200-package lit-based QR modal that would
 * both bloat the bundle and drop a foreign design system into a terminal UI
 * built from DOM string templates. The pairing URI is emitted as a
 * `display_uri` event, and `modals/walletpicker.ts` renders it as a QR and a
 * deep link in this app's own chrome.
 */

/**
 * Required operator credential. There is no fallback and no default: a
 * WalletConnect relay connection genuinely cannot be opened without a project
 * id, so an unset value degrades to a disabled picker row carrying the reason
 * — never to a fake signer.
 */
export const WALLETCONNECT_PROJECT_ID: string = (
  (import.meta.env['VITE_WALLETCONNECT_PROJECT_ID'] as string | undefined) ?? ''
).trim();

/** Null when WalletConnect can be used; otherwise the reason it cannot. */
export function walletConnectUnavailableReason(projectId: string = WALLETCONNECT_PROJECT_ID): string | null {
  if (projectId === '') {
    return 'VITE_WALLETCONNECT_PROJECT_ID is not set for this deployment, so WalletConnect cannot open a relay session. Robinhood Wallet is mobile-only and needs it.';
  }
  return null;
}

function caipForNet(net: Net): string {
  return 'eip155:' + evmChainIdForNet(net);
}

function rpcForNet(net: Net): string {
  return net === 'BASE' ? BASE_RPC_URL : RH_RPC_URL;
}

/**
 * `personal_sign` for SIWE, `eth_signTypedData_v4` for the `StonkzRouter`
 * sell permit, `eth_sendTransaction` for the trade itself, and the two chain
 * methods for wallets that support them. Requested as *optional* namespaces
 * as well so a wallet that cannot do all of them still pairs, and fails at
 * the specific call instead of refusing to connect at all.
 */
const METHODS = [
  'eth_sendTransaction',
  'personal_sign',
  'eth_signTypedData',
  'eth_signTypedData_v4',
  'eth_accounts',
  'eth_chainId',
  'wallet_switchEthereumChain',
  'wallet_addEthereumChain',
];

const EVENTS = ['chainChanged', 'accountsChanged'];

export interface WalletConnectSession {
  provider: Eip1193Provider;
  address: string;
  disconnect: () => Promise<void>;
}

interface ConnectOpts {
  onUri?: (uri: string) => void;
  /** Abort the pairing wait — the picker's cancel button. */
  signal?: AbortSignal;
  /**
   * Boot restore: only reuse a relay session UniversalProvider already loaded
   * from storage. Never open a new QR pairing.
   */
  resumeOnly?: boolean;
}

function appMetadata(): { name: string; description: string; url: string; icons: string[] } {
  const origin = typeof window === 'undefined' ? 'https://ston.kz' : window.location.origin;
  return {
    name: 'Stonkz',
    description: 'Stonkz launchpad — fair-launch memecoins on a bonding curve.',
    // Must match the serving origin exactly: a mismatch surfaces to the user
    // as a domain-mismatch phishing warning in Robinhood Wallet
    // (`docs/robinhood-chain.md` §6.2).
    url: origin,
    icons: [origin + '/favicon.ico'],
  };
}

type WcProvider = InstanceType<typeof UniversalProvider>;

let cached: WcProvider | null = null;

/**
 * Loaded on demand, not at boot.
 *
 * The relay client, its crypto and its storage layer are the single largest
 * thing this phase added to the bundle, and most sessions never touch them —
 * a Solana trader never does, and a desktop user with an extension does not
 * either. A dynamic import keeps it in its own chunk, fetched the moment
 * someone actually picks WalletConnect, which is also the moment they are
 * already waiting on a relay round-trip.
 */
async function providerInstance(): Promise<WcProvider> {
  if (cached) return cached;
  try {
    const { UniversalProvider: Provider } = await import('@walletconnect/universal-provider');
    cached = await Provider.init({
      projectId: WALLETCONNECT_PROJECT_ID,
      metadata: appMetadata(),
    });
  } catch (err) {
    throw mapWalletError(err, 'Could not reach the WalletConnect relay.');
  }
  return cached;
}

/**
 * Open (or resume) a WalletConnect session pinned to chain 4663.
 *
 * The chain is pinned in the session namespace rather than switched after the
 * fact, which is why `wallet/evm.ts` skips `wallet_switchEthereumChain` for
 * this transport: a wallet that agreed to the session agreed to the chain.
 */
export async function connectWalletConnect(opts: ConnectOpts & { net?: Net } = {}): Promise<WalletConnectSession> {
  const net = opts.net ?? 'RH';
  const chainId = evmChainIdForNet(net);
  const caip = caipForNet(net);
  const rpcUrl = rpcForNet(net);
  const reason = walletConnectUnavailableReason();
  if (reason) throw new WalletError('unconfigured', reason);

  const provider = await providerInstance();

  const onDisplayUri = (uri: string): void => opts.onUri?.(uri);
  provider.on('display_uri', onDisplayUri);

  try {
    if (!provider.session) {
      if (opts.resumeOnly) {
        throw new WalletError('not_connected', 'No WalletConnect session to resume.');
      }
      const connecting = provider.connect({
        optionalNamespaces: {
          eip155: {
            chains: [caip],
            methods: METHODS,
            events: EVENTS,
            rpcMap: { [String(chainId)]: rpcUrl },
          },
        },
      });
      if (opts.signal) {
        await Promise.race([
          connecting,
          new Promise((_resolve, reject) => {
            opts.signal?.addEventListener('abort', () => {
              provider.abortPairingAttempt();
              reject(new WalletError('rejected', 'Pairing cancelled.'));
            });
          }),
        ]);
      } else {
        await connecting;
      }
    }
  } catch (err) {
    if (err instanceof WalletError) throw err;
    throw mapWalletError(err, 'The WalletConnect pairing did not complete.');
  } finally {
    provider.removeListener('display_uri', onDisplayUri);
  }

  const session = provider.session;
  if (!session) throw new WalletError('rejected', 'The wallet did not approve the session.');

  const namespaces = session.namespaces as Record<string, { accounts?: string[] }>;
  const accounts = Object.values(namespaces)
    .flatMap((ns) => ns.accounts ?? [])
    .filter((caip) => caip.startsWith('eip155:'))
    .map((caip) => caip.split(':')[2] ?? '')
    .filter((a) => a !== '');
  const address = accounts[0];
  if (!address) {
    throw new WalletError('rejected', 'The wallet approved a session with no Ethereum-family account in it.');
  }

  provider.setDefaultChain(caip, rpcUrl);

  // `UniversalProvider.request(args, chain)` needs the CAIP chain; the rest of
  // the app speaks plain EIP-1193, so bind it here.
  const eip1193: Eip1193Provider = {
    request: (args) => provider.request(args, caip),
    on: (event, listener) => provider.on(event, listener),
    removeListener: (event, listener) => provider.removeListener(event, listener),
  };

  return {
    provider: eip1193,
    address,
    disconnect: async () => {
      await provider.disconnect().catch(() => undefined);
      cached = null;
    },
  };
}
