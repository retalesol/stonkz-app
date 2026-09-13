import {
  createPublicClient,
  defineChain,
  formatEther,
  getAddress,
  hexToBigInt,
  http,
  type PublicClient,
} from 'viem';
import {
  RH_ADD_CHAIN_PARAMS,
  RH_CHAIN_ID,
  RH_CHAIN_ID_HEX,
  RH_EXPLORER_URL,
  RH_RPC_URL,
} from './chain.js';
import { WalletError, mapWalletError } from './errors.js';
import type { BroadcastResult, ConnectedWallet, SignPayload, WalletChoice, WalletKind } from './types.js';
import { WALLETCONNECT_PROJECT_ID, connectWalletConnect, walletConnectUnavailableReason } from './walletconnect.js';

/**
 * Real Robinhood Chain wallets.
 *
 * `viem` does the chain-side work (receipt waiting, balance reads, revert
 * decoding) and everything wallet-facing is plain EIP-1193, which keeps two
 * very different transports behind one implementation:
 *
 * - **Injected**, discovered over EIP-6963 with a `window.ethereum` fallback.
 *   This is the desktop-extension path (MetaMask / OKX / Rabby with chain
 *   4663 added), and it is also what Robinhood Wallet's own in-app web3
 *   browser injects.
 * - **WalletConnect**, which `docs/robinhood-chain.md` row 32 makes
 *   mandatory rather than optional: **Robinhood Wallet is mobile-only and has
 *   no browser extension**, so on desktop there is no `window.ethereum` for
 *   it and a QR pairing is the only way in.
 *
 * `wagmi` was considered and skipped. `wagmi/core` is framework-agnostic, but
 * everything this layer needs from it — connector discovery, a chain switch,
 * a typed-data signature — is a handful of `request()` calls, and its
 * connector set would have added the React-adjacent dependency surface this
 * app has none of. See the final report for the dependency tally.
 */

/* -------------------------------------------------------------------------- */
/* EIP-1193                                                                    */
/* -------------------------------------------------------------------------- */

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, listener: (...args: never[]) => void): void;
  removeListener?(event: string, listener: (...args: never[]) => void): void;
}

interface Eip6963ProviderInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}

interface Eip6963ProviderDetail {
  info: Eip6963ProviderInfo;
  provider: Eip1193Provider;
}

const injected = new Map<string, Eip6963ProviderDetail>();
const injectedListeners = new Set<() => void>();
let discoveryStarted = false;

/**
 * Start EIP-6963 discovery. Announcements are pushed by each extension in
 * response to our request event, and extensions that load after us announce
 * again, so this listens permanently rather than snapshotting once.
 */
export function initEvmDiscovery(): void {
  if (discoveryStarted || typeof window === 'undefined') return;
  discoveryStarted = true;
  window.addEventListener('eip6963:announceProvider', (ev: Event) => {
    const detail = (ev as CustomEvent<Eip6963ProviderDetail>).detail;
    if (!detail?.info?.rdns || typeof detail.provider?.request !== 'function') return;
    injected.set(detail.info.rdns, detail);
    for (const cb of injectedListeners) cb();
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}

/** Clears EIP-6963 state between unit tests. Not for production callers. */
export function resetEvmDiscoveryForTests(): void {
  injected.clear();
  discoveryStarted = false;
}

/** Injects an EIP-6963 announce without needing a browser `window`. */
export function announceEvmProviderForTests(detail: Eip6963ProviderDetail): void {
  if (!detail?.info?.rdns || typeof detail.provider?.request !== 'function') return;
  injected.set(detail.info.rdns, detail);
}

/** MetaMask rdns prefixes announced over EIP-6963. */
const METAMASK_RDNS = new Set(['io.metamask', 'io.metamask.flask', 'io.metamask.flask.dev']);

/** CSP only allows `data:` wallet icons (`img-src`); https CDN icons render blank. */
const METAMASK_ICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#1a1a1a"/><path fill="#E2761B" d="M26.2 5.2 17.4 11.8l1.6-3.8z"/><path fill="#E4761B" d="m5.7 5.2 8.7 6.7-1.5-3.9zm17.7 12.3-2.3 3.6 5 1.4 1.4-4.8zm-23.1.2 1.4 4.8 5-1.4-2.3-3.6z"/><path fill="#E4761B" d="m10.4 14.4-.9 2.9 4.6.2-.2-5zm11.1 0-3.7-2.1-.1 5.2 4.6-.2zM10.6 21.1l2.8 2.1 3.4-1.8v-2zm10.8 0-6.2-1.7v2l3.4 1.8z"/></svg>',
  );
const WALLETCONNECT_ICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#09090b"/><path fill="#3B99FC" d="M9.4 12.6a8.3 8.3 0 0 1 13.2 0l.4.5a.5.5 0 0 1 0 .6l-1.5 1.5a.4.4 0 0 1-.5 0l-.6-.6a5.7 5.7 0 0 0-9 0l-.6.6a.4.4 0 0 1-.5 0l-1.5-1.5a.5.5 0 0 1 0-.6zm16.3 3 1.3 1.4a.5.5 0 0 1 0 .6l-6 6a.9.9 0 0 1-1.2 0l-4.2-4.3a.2.2 0 0 0-.3 0l-4.2 4.3a.9.9 0 0 1-1.2 0l-6-6a.5.5 0 0 1 0-.6l1.3-1.4a.5.5 0 0 1 .6 0l4.3 4.3a.2.2 0 0 0 .3 0l4.2-4.3a.9.9 0 0 1 1.2 0l4.2 4.3a.2.2 0 0 0 .3 0l4.3-4.3a.5.5 0 0 1 .6 0z"/></svg>',
  );

function isMetaMaskDetail(d: Eip6963ProviderDetail): boolean {
  const rdns = d.info.rdns.toLowerCase();
  if (METAMASK_RDNS.has(rdns) || rdns.startsWith('io.metamask.')) return true;
  if (rdns === 'window.ethereum') {
    return !!(d.provider as Eip1193Provider & { isMetaMask?: boolean }).isMetaMask;
  }
  return /metamask/i.test(d.info.name);
}

function safeIcon(icon: string | undefined, fallback: string): string {
  return icon && icon.startsWith('data:') ? icon : fallback;
}

/**
 * Legacy `window.ethereum` — MetaMask only, and only when EIP-6963 has not
 * already announced MetaMask. Multi-provider pages often set both; listing
 * both produced two MetaMask rows. Non-MetaMask injections (Phantom's EVM
 * shim, etc.) are ignored here — RH offers MetaMask + WalletConnect only.
 */
function legacyInjected(): Eip6963ProviderDetail | null {
  if ([...injected.values()].some(isMetaMaskDetail)) return null;
  const eth = (globalThis as { ethereum?: Eip1193Provider & { isMetaMask?: boolean } }).ethereum;
  if (!eth || typeof eth.request !== 'function' || !eth.isMetaMask) return null;
  if ([...injected.values()].some((d) => d.provider === eth)) return null;
  return {
    info: {
      uuid: 'window.ethereum',
      rdns: 'window.ethereum',
      name: 'MetaMask',
      icon: METAMASK_ICON,
    },
    provider: eth,
  };
}

function injectedDetails(): Eip6963ProviderDetail[] {
  const list = [...injected.values()];
  const legacy = legacyInjected();
  if (legacy) list.push(legacy);
  return list;
}

/**
 * Robinhood Chain wallets: MetaMask (desktop extension) + WalletConnect
 * (Robinhood Wallet / mobile). Multi-chain Solana wallets that also announce
 * an EVM provider (Phantom) are intentionally omitted — RH is EVM-only here.
 *
 * WalletConnect is always listed, even with no project id configured — as an
 * explicitly disabled row carrying the reason.
 */
export function listEvmWallets(): WalletChoice[] {
  const metamasks = injectedDetails().filter(isMetaMaskDetail);
  // One MetaMask row: prefer a real EIP-6963 announce over the legacy shim.
  const preferred =
    metamasks.find((d) => METAMASK_RDNS.has(d.info.rdns.toLowerCase()) || d.info.rdns.toLowerCase().startsWith('io.metamask.')) ??
    metamasks[0];
  const out: WalletChoice[] = [];
  if (preferred) {
    out.push({
      id: 'injected:' + preferred.info.rdns,
      net: 'RH',
      kind: 'evm-injected',
      name: 'MetaMask',
      icon: safeIcon(preferred.info.icon, METAMASK_ICON),
    });
  }
  const reason = walletConnectUnavailableReason();
  out.push({
    id: 'walletconnect',
    net: 'RH',
    kind: 'evm-walletconnect',
    name: 'WalletConnect (Robinhood Wallet)',
    icon: WALLETCONNECT_ICON,
    ...(reason ? { unavailable: reason } : {}),
  });
  return out;
}

export function onEvmWalletsChange(cb: () => void): () => void {
  injectedListeners.add(cb);
  return () => injectedListeners.delete(cb);
}

/* -------------------------------------------------------------------------- */
/* Chain client                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Chain 4663 is not in `viem/chains` (it postdates the published set, the
 * same reason `docs/robinhood-chain.md` §3.1 warns that `@uniswap/sdk-core`
 * has no address map for it), so it is defined here from config.
 */
export const robinhoodChain = defineChain({
  id: RH_CHAIN_ID,
  name: RH_ADD_CHAIN_PARAMS.chainName,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RH_RPC_URL] } },
  blockExplorers: { default: { name: 'Blockscout', url: RH_EXPLORER_URL } },
});

let publicClient: PublicClient | null = null;
function rpc(): PublicClient {
  publicClient ??= createPublicClient({ chain: robinhoodChain, transport: http(RH_RPC_URL) });
  return publicClient;
}

function utf8ToHex(text: string): string {
  let out = '0x';
  for (const byte of new TextEncoder().encode(text)) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function toHexWei(decimalWei: string): string {
  const trimmed = decimalWei.trim();
  if (trimmed === '' || trimmed === '0') return '0x0';
  if (trimmed.startsWith('0x')) return trimmed;
  if (!/^\d+$/.test(trimmed)) {
    throw new WalletError('unknown', 'The API returned a transaction value this wallet cannot encode: ' + decimalWei);
  }
  return '0x' + BigInt(trimmed).toString(16);
}

/* -------------------------------------------------------------------------- */
/* Chain enforcement                                                           */
/* -------------------------------------------------------------------------- */

/** The three EIP-1193 calls chain enforcement needs, and nothing else. */
export type ChainRequest = (method: string, params?: unknown[]) => Promise<unknown>;

function toChainId(raw: unknown): number {
  if (typeof raw === 'string') return raw.startsWith('0x') ? Number(hexToBigInt(raw as `0x${string}`)) : Number(raw);
  return Number(raw);
}

/**
 * Get a wallet onto chain 4663, or fail with copy that says what to do next.
 *
 * Sequence, and why each step is there:
 *
 * 1. Read `eth_chainId`. Already on 4663 and there is nothing to do — no
 *    prompt, which matters because a needless switch prompt on every trade
 *    trains people to click through them.
 * 2. `wallet_switchEthereumChain`. The normal case for an extension that has
 *    4663 configured.
 * 3. On `4902` / "unrecognized chain", `wallet_addEthereumChain` with the
 *    parameters from `docs/robinhood-chain.md` §2.2, then switch again.
 * 4. On `4200` (method not supported — many mobile wallets), stop and say
 *    *switch it yourself in the wallet*, because retrying cannot help.
 * 5. Re-read `eth_chainId` and refuse to continue unless it is really 4663.
 *    A wallet answering the switch with a silent no-op is a real behaviour,
 *    and signing after it would broadcast to the wrong chain.
 *
 * Taking a bare `request` rather than a provider keeps this unit-testable
 * against scripted responses, with no browser and no extension.
 */
export async function enforceRhChain(request: ChainRequest): Promise<void> {
  let current: number;
  try {
    current = toChainId(await request('eth_chainId'));
  } catch (err) {
    throw mapWalletError(err, 'Could not read the wallet\u2019s current chain.');
  }
  if (current === RH_CHAIN_ID) return;

  try {
    await request('wallet_switchEthereumChain', [{ chainId: RH_CHAIN_ID_HEX }]);
  } catch (err) {
    const mapped = mapWalletError(err);
    if (mapped.kind === 'chain_unsupported') {
      try {
        await request('wallet_addEthereumChain', [RH_ADD_CHAIN_PARAMS]);
        await request('wallet_switchEthereumChain', [{ chainId: RH_CHAIN_ID_HEX }]);
      } catch (addErr) {
        throw mapWalletError(addErr, `Could not add ${RH_ADD_CHAIN_PARAMS.chainName} to this wallet.`);
      }
    } else if (mapped.kind === 'unsupported_method') {
      throw new WalletError(
        'wrong_chain',
        `This wallet is on chain ${current} and cannot be switched from a site. Select ` +
          `${RH_ADD_CHAIN_PARAMS.chainName} (${RH_CHAIN_ID}) in the wallet itself, then try again.`,
        { cause: err },
      );
    } else {
      throw mapped;
    }
  }

  const after = await request('eth_chainId').then(toChainId, () => -1);
  if (after !== RH_CHAIN_ID) {
    throw new WalletError(
      'wrong_chain',
      `The wallet is still on chain ${after === -1 ? 'unknown' : after}. ` +
        `Switch it to ${RH_ADD_CHAIN_PARAMS.chainName} (${RH_CHAIN_ID}) to trade.`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* The wallet                                                                  */
/* -------------------------------------------------------------------------- */

class EvmWallet implements ConnectedWallet {
  readonly net = 'RH' as const;
  readonly practice = false;
  private listeners = new Set<(address: string | null) => void>();
  private bound = false;

  constructor(
    readonly kind: WalletKind,
    readonly label: string,
    private account: string,
    private readonly provider: Eip1193Provider,
    /** WalletConnect pins the chain in its session namespace, so it never needs a switch. */
    private readonly chainPinnedBySession: boolean,
    private readonly teardown: () => Promise<void>,
  ) {}

  get address(): string {
    return this.account;
  }

  private async request<T>(method: string, params?: unknown[] | object): Promise<T> {
    return (await this.provider.request(params === undefined ? { method } : { method, params })) as T;
  }

  /**
   * Get the wallet onto chain 4663 — see `enforceRhChain`.
   *
   * Deliberately *not* called before signing in: `docs/robinhood-chain.md`
   * §6.1 is explicit that `personal_sign` is chain-agnostic and that gating
   * connect on a chain switch breaks mobile wallets which have no switch
   * method at all. The chain is enforced at transaction time, which is the
   * only point it actually matters.
   */
  async ensureChain(): Promise<void> {
    // WalletConnect pins `eip155:4663` in the session namespace, so the
    // wallet cannot be anywhere else and the switch prompt is pure noise.
    if (this.chainPinnedBySession) return;
    await enforceRhChain((method, params) => this.request(method, params));
  }

  async signInMessage(message: string): Promise<string> {
    try {
      // Hex-encoded UTF-8 bytes, not the raw string: a message that happens to
      // start with `0x` is otherwise ambiguous, and some wallets guess wrong.
      return await this.request<string>('personal_sign', [utf8ToHex(message), this.account]);
    } catch (err) {
      const mapped = mapWalletError(err, 'The wallet would not sign the sign-in message.');
      if (mapped.kind === 'unsupported_method') {
        // `docs/robinhood-chain.md` row 34 marks `personal_sign` support as
        // Likely-not-Confirmed for Robinhood Wallet and names this exact
        // fallback. Surfacing it as its own message beats a generic failure.
        throw new WalletError(
          'unsupported_method',
          'This wallet refused `personal_sign`, which Stonkz needs for sign-in. ' +
            'Report this — the EIP-712 sign-in fallback is not built yet.',
          { cause: err },
        );
      }
      throw mapped;
    }
  }

  async signTypedData(typedData: unknown): Promise<string> {
    try {
      return await this.request<string>('eth_signTypedData_v4', [this.account, JSON.stringify(typedData)]);
    } catch (err) {
      throw mapWalletError(err, 'The wallet would not sign the permit.');
    }
  }

  /**
   * Simulate before prompting.
   *
   * A revert found here costs the trader nothing and, crucially, still
   * carries its reason string — which is how a missed `min_out` gets reported
   * as SLIPPAGE EXCEEDED instead of as an opaque post-hoc failed receipt.
   */
  private async preflight(to: string, data: string, value: string): Promise<void> {
    try {
      await rpc().call({
        account: this.account as `0x${string}`,
        to: to as `0x${string}`,
        data: data as `0x${string}`,
        value: BigInt(value === '' ? '0' : value),
      });
    } catch (err) {
      const mapped = mapWalletError(err);
      // A simulation that failed only because we could not reach the RPC is
      // not a reason to refuse to sign — let the wallet try.
      if (mapped.kind === 'network' || mapped.kind === 'unknown') return;
      throw mapped;
    }
  }

  async signAndSend(payload: SignPayload): Promise<BroadcastResult> {
    if (payload.net !== 'RH') {
      throw new WalletError('unsupported_method', 'A Robinhood Chain wallet cannot sign a Solana transaction.');
    }
    await this.ensureChain();
    await this.preflight(payload.to, payload.data, payload.value);

    let hash: string;
    try {
      hash = await this.request<string>('eth_sendTransaction', [
        {
          from: this.account,
          to: payload.to,
          data: payload.data,
          value: toHexWei(payload.value),
        },
      ]);
    } catch (err) {
      throw mapWalletError(err, 'The wallet would not send this transaction.');
    }

    let receipt;
    try {
      receipt = await rpc().waitForTransactionReceipt({ hash: hash as `0x${string}`, timeout: 120_000 });
    } catch (err) {
      const mapped = mapWalletError(err);
      if (mapped.kind === 'unknown' || mapped.kind === 'network') {
        throw new WalletError(
          'timeout',
          'Sent, but no receipt yet. The sequencer usually confirms in under a second \u2014 check the explorer.',
          { cause: err },
        );
      }
      throw mapped;
    }
    if (receipt.status === 'reverted') {
      // `preflight` catches most reverts with a reason attached; a revert that
      // only shows up here means state moved between simulation and inclusion.
      throw new WalletError(
        'reverted',
        'The transaction reverted on chain after it was included \u2014 the price most likely moved. Nothing settled.',
      );
    }
    return { signature: hash, explorerUrl: RH_EXPLORER_URL.replace(/\/+$/, '') + '/tx/' + hash };
  }

  async nativeBalance(): Promise<number | null> {
    try {
      const wei = await rpc().getBalance({ address: this.account as `0x${string}` });
      return Number(formatEther(wei));
    } catch {
      return null;
    }
  }

  async disconnect(): Promise<void> {
    this.listeners.clear();
    await this.teardown().catch(() => undefined);
  }

  onAccountChange(cb: (address: string | null) => void): () => void {
    this.listeners.add(cb);
    if (!this.bound && this.provider.on) {
      this.bound = true;
      this.provider.on('accountsChanged', ((accounts: string[]) => {
        const next = accounts[0];
        if (!next) {
          for (const l of this.listeners) l(null);
          return;
        }
        this.account = normalise(next);
        for (const l of this.listeners) l(this.account);
      }) as (...args: never[]) => void);
      this.provider.on('disconnect', (() => {
        for (const l of this.listeners) l(null);
      }) as (...args: never[]) => void);
    }
    return () => this.listeners.delete(cb);
  }
}

/** EIP-55, so the address in the SIWE message matches what the API echoes back. */
function normalise(address: string): string {
  try {
    return getAddress(address);
  } catch {
    return address;
  }
}

async function accountsOf(provider: Eip1193Provider, mode: 'prompt' | 'reconnect'): Promise<string[]> {
  // Reconnect: prefer eth_accounts (no popup). Many injected wallets still
  // return [] here even when the site is already authorised — fall through to
  // eth_requestAccounts, which MetaMask/Rabby approve silently when unlocked.
  if (mode === 'reconnect') {
    try {
      const existing = (await provider.request({ method: 'eth_accounts' })) as unknown;
      const list = Array.isArray(existing) ? existing.filter((a): a is string => typeof a === 'string') : [];
      if (list.length > 0) return list;
    } catch {
      /* fall through */
    }
  }
  const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as unknown;
  return Array.isArray(accounts) ? accounts.filter((a): a is string => typeof a === 'string') : [];
}

export interface EvmConnectHooks {
  /** Called with the `wc:` pairing URI, for the QR/deep-link panel. */
  onWalletConnectUri?: (uri: string) => void;
  /**
   * Boot restore: resume without a picker. Injected wallets try `eth_accounts`
   * then `eth_requestAccounts`; WalletConnect only resumes an existing session.
   */
  silent?: boolean;
}

export async function connectEvmWallet(id: string, hooks: EvmConnectHooks = {}): Promise<ConnectedWallet> {
  if (id === 'walletconnect') {
    const reason = walletConnectUnavailableReason();
    if (reason) throw new WalletError('unconfigured', reason);
    const { provider, address, disconnect } = await connectWalletConnect({
      ...(hooks.onWalletConnectUri ? { onUri: hooks.onWalletConnectUri } : {}),
      ...(hooks.silent ? { resumeOnly: true } : {}),
    });
    return new EvmWallet('evm-walletconnect', 'WALLETCONNECT', normalise(address), provider, true, disconnect);
  }

  const rdns = id.startsWith('injected:') ? id.slice('injected:'.length) : id;
  const detail = injectedDetails().find((d) => d.info.rdns === rdns);
  if (!detail) {
    throw new WalletError('no_wallet', `${rdns} is no longer available. Is the extension still enabled?`);
  }
  let accounts: string[];
  try {
    accounts = await accountsOf(detail.provider, hooks.silent ? 'reconnect' : 'prompt');
  } catch (err) {
    if (err instanceof WalletError) throw err;
    throw mapWalletError(err, `${detail.info.name} did not authorise this site.`);
  }
  const account = accounts[0];
  if (!account) throw new WalletError('rejected', `${detail.info.name} authorised no accounts.`);

  return new EvmWallet(
    'evm-injected',
    detail.info.name.toUpperCase(),
    normalise(account),
    detail.provider,
    false,
    async () => undefined,
  );
}

export { WALLETCONNECT_PROJECT_ID };
