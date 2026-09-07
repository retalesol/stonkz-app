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

/** Legacy single-provider injection, for extensions with no EIP-6963 support. */
function legacyInjected(): Eip6963ProviderDetail | null {
  const eth = (globalThis as { ethereum?: Eip1193Provider & { isMetaMask?: boolean } }).ethereum;
  if (!eth || typeof eth.request !== 'function') return null;
  if ([...injected.values()].some((d) => d.provider === eth)) return null;
  return {
    info: {
      uuid: 'window.ethereum',
      rdns: 'window.ethereum',
      name: eth.isMetaMask ? 'MetaMask' : 'Browser Wallet',
      icon: '',
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
 * Every way onto chain 4663 from this browser.
 *
 * WalletConnect is always listed, even with no project id configured — as an
 * explicitly disabled row carrying the reason. Hiding it would leave a
 * desktop Robinhood Wallet user with an empty picker and no explanation,
 * which is the failure mode this whole phase exists to remove.
 */
export function listEvmWallets(): WalletChoice[] {
  const out: WalletChoice[] = injectedDetails().map((d) => ({
    id: 'injected:' + d.info.rdns,
    net: 'RH' as const,
    kind: 'evm-injected' as const,
    name: d.info.name,
    ...(d.info.icon.startsWith('data:') ? { icon: d.info.icon } : {}),
  }));
  const reason = walletConnectUnavailableReason();
  out.push({
    id: 'walletconnect',
    net: 'RH',
    kind: 'evm-walletconnect',
    name: 'WalletConnect (Robinhood Wallet)',
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

function toHexWei(decimalWei: string): string {
  const trimmed = decimalWei.trim();
  if (trimmed === '' || trimmed === '0') return '0x0';
  if (trimmed.startsWith('0x')) return trimmed;
  if (!/^\d+$/.test(trimmed)) {
    throw new WalletError('unknown', 'The API returned a transaction value this wallet cannot encode: ' + decimalWei);
  }
  return '0x' + BigInt(trimmed).toString(16);
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

  async chainId(): Promise<number> {
    const raw = await this.request<string>('eth_chainId');
    return typeof raw === 'string' ? Number(hexToBigInt(raw as `0x${string}`)) : Number(raw);
  }

  /**
   * Get the wallet onto chain 4663, or fail with copy that says what to do.
   *
   * Deliberately *not* called before signing in: `docs/robinhood-chain.md`
   * §6.1 is explicit that `personal_sign` is chain-agnostic and that gating
   * connect on a chain switch breaks mobile wallets which have no switch
   * method at all. The chain is enforced here, at transaction time, which is
   * the only point it actually matters.
   */
  async ensureChain(): Promise<void> {
    if (this.chainPinnedBySession) return;
    let current: number;
    try {
      current = await this.chainId();
    } catch (err) {
      throw mapWalletError(err, 'Could not read the wallet\u2019s current chain.');
    }
    if (current === RH_CHAIN_ID) return;

    try {
      await this.request('wallet_switchEthereumChain', [{ chainId: RH_CHAIN_ID_HEX }]);
    } catch (err) {
      const mapped = mapWalletError(err);
      if (mapped.kind === 'chain_unsupported') {
        // The wallet has never seen 4663. Add it from the documented config,
        // then switch again — `docs/robinhood-chain.md` §2.2.
        try {
          await this.request('wallet_addEthereumChain', [RH_ADD_CHAIN_PARAMS]);
          await this.request('wallet_switchEthereumChain', [{ chainId: RH_CHAIN_ID_HEX }]);
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

    const after = await this.chainId().catch(() => -1);
    if (after !== RH_CHAIN_ID) {
      throw new WalletError(
        'wrong_chain',
        `The wallet is still on chain ${after === -1 ? 'unknown' : after}. ` +
          `Switch it to ${RH_ADD_CHAIN_PARAMS.chainName} (${RH_CHAIN_ID}) to trade.`,
      );
    }
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

async function accountsOf(provider: Eip1193Provider): Promise<string[]> {
  const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as unknown;
  return Array.isArray(accounts) ? accounts.filter((a): a is string => typeof a === 'string') : [];
}

export interface EvmConnectHooks {
  /** Called with the `wc:` pairing URI, for the QR/deep-link panel. */
  onWalletConnectUri?: (uri: string) => void;
}

export async function connectEvmWallet(id: string, hooks: EvmConnectHooks = {}): Promise<ConnectedWallet> {
  if (id === 'walletconnect') {
    const reason = walletConnectUnavailableReason();
    if (reason) throw new WalletError('unconfigured', reason);
    const { provider, address, disconnect } = await connectWalletConnect({
      ...(hooks.onWalletConnectUri ? { onUri: hooks.onWalletConnectUri } : {}),
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
    accounts = await accountsOf(detail.provider);
  } catch (err) {
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
