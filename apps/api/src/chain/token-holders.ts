import type { FetchLike } from './types.js';

/**
 * Live holder lists for a launched token.
 *
 * Prefer an explorer/token-holders API (Blockscout) or RPC over
 * `holders_snapshot`. The snapshot is only a cache for when the chain /
 * explorer is unreachable — matching "DB mocks on-chain when RPC is down".
 *
 * What counts as a holder is decided by the *route* (`routes/tokens.ts`): this
 * module only reads balances and tags the program-owned accounts it is told
 * about (curve vault, LP reserve, stake escrow, creator bucket) so they are
 * never counted as wallets.
 */

/** What a program-owned balance is for; `wallet` is an ordinary holder. */
export type HolderKind = 'wallet' | 'curve' | 'lp' | 'stake' | 'bucket';

export interface ChainHolder {
  wallet: string;
  /** Whole-token units (not atoms). */
  amount: number;
  /** True when this address is the bonding-curve vault / launchpad. */
  curve: boolean;
  kind: HolderKind;
}

export interface ChainHoldersResult {
  holders: ChainHolder[];
  source: 'explorer' | 'rpc';
}

/** Account address (lower-cased for EVM) -> what that program-owned balance is. */
export type TaggedAccounts = Record<string, HolderKind>;

export interface FetchEvmHoldersOptions {
  mint: string;
  /** Launchpad / curve vault — tagged `curve` when present. */
  launchpad?: string;
  /** Other program-owned accounts to tag (LP reserve, stake escrow…). */
  tagged?: TaggedAccounts;
  /** Whole-token decimals (RH tokens are 18). */
  decimals?: number;
  limit?: number;
  /** The net's block explorer (may be an Etherscan-family host with no holders API). */
  explorerUrl: string;
  /** A Blockscout instance to read holders from when it differs from `explorerUrl`. */
  holdersApiUrl?: string | undefined;
  /** Picks the public Blockscout instance when `explorerUrl` has no holders API. */
  chainId?: number | undefined;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

function padAddr(a: string): string {
  return a.trim().toLowerCase();
}

export function fromAtoms(atoms: bigint, decimals: number): number {
  if (decimals <= 0) return Number(atoms);
  const base = 10n ** BigInt(decimals);
  const whole = atoms / base;
  const frac = atoms % base;
  return Number(whole) + Number(frac) / Number(base);
}

/**
 * Public Blockscout instances per EVM chain id, for nets whose configured
 * explorer is an Etherscan-family host (Basescan serves neither
 * `getTokenHolders` nor `/api/v2/tokens/:addr/holders`; its V1 API is retired
 * and V2 puts holder lists behind a paid key).
 */
const BLOCKSCOUT_BY_CHAIN: Record<number, string> = {
  8453: 'https://base.blockscout.com',
  84532: 'https://base-sepolia.blockscout.com',
  10: 'https://optimism.blockscout.com',
  11155420: 'https://optimism-sepolia.blockscout.com',
  42161: 'https://arbitrum.blockscout.com',
  421614: 'https://arbitrum-sepolia.blockscout.com',
  1: 'https://eth.blockscout.com',
  11155111: 'https://eth-sepolia.blockscout.com',
};

const ETHERSCAN_FAMILY =
  /(^|\.)(etherscan|basescan|arbiscan|polygonscan|optimistic\.etherscan|snowtrace|bscscan)\./i;

/** Which host to ask for holders: an explicit override, else the explorer unless it is Etherscan-family. */
export function holdersApiBase(
  explorerUrl: string,
  chainId?: number | undefined,
  override?: string | undefined,
): string {
  if (override && override.trim()) return override.trim().replace(/\/$/, '');
  const base = explorerUrl.trim().replace(/\/$/, '');
  let host = '';
  try {
    host = new URL(base).hostname;
  } catch {
    return base;
  }
  if (ETHERSCAN_FAMILY.test(host) && chainId !== undefined && BLOCKSCOUT_BY_CHAIN[chainId]) {
    return BLOCKSCOUT_BY_CHAIN[chainId] as string;
  }
  return base;
}

function tagOf(wallet: string, curve: string, tagged: TaggedAccounts | undefined): HolderKind {
  const key = padAddr(wallet);
  if (curve !== '' && key === curve) return 'curve';
  return tagged?.[key] ?? 'wallet';
}

function toHolder(
  wallet: string,
  atoms: bigint,
  decimals: number,
  curve: string,
  tagged: TaggedAccounts | undefined,
): ChainHolder | null {
  if (!wallet || atoms <= 0n) return null;
  const kind = tagOf(wallet, curve, tagged);
  return { wallet, amount: fromAtoms(atoms, decimals), curve: kind === 'curve', kind };
}

function parseAtoms(raw: string | undefined): bigint | null {
  try {
    return BigInt(raw ?? '0');
  } catch {
    return null;
  }
}

/**
 * Blockscout-compatible `?module=token&action=getTokenHolders` (RH testnet
 * explorer serves this). Falls back to `/api/v2/tokens/:addr/holders`,
 * following `next_page_params` until `limit` rows are in hand.
 */
export async function fetchEvmHoldersFromExplorer(
  opts: FetchEvmHoldersOptions,
): Promise<ChainHoldersResult> {
  const fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const decimals = opts.decimals ?? 18;
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const mint = opts.mint;
  const curve = opts.launchpad ? padAddr(opts.launchpad) : '';
  const tagged = opts.tagged;
  const base = holdersApiBase(opts.explorerUrl, opts.chainId, opts.holdersApiUrl);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const finish = (holders: ChainHolder[]): ChainHoldersResult => ({
    holders: holders.sort((a, b) => b.amount - a.amount).slice(0, limit),
    source: 'explorer',
  });
  try {
    const legacy = new URL(base + '/api');
    legacy.searchParams.set('module', 'token');
    legacy.searchParams.set('action', 'getTokenHolders');
    legacy.searchParams.set('contractaddress', mint);
    legacy.searchParams.set('page', '1');
    legacy.searchParams.set('offset', String(limit));

    const res = await fetchImpl(legacy.toString(), { signal: controller.signal }).catch(() => null);
    if (res && res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        status?: string;
        result?: Array<{ address?: string; value?: string }>;
      };
      if (body.status === '1' && Array.isArray(body.result) && body.result.length > 0) {
        const holders = body.result
          .map((r) => {
            const atoms = parseAtoms(r.value);
            return atoms === null
              ? null
              : toHolder((r.address ?? '').trim(), atoms, decimals, curve, tagged);
          })
          .filter((h): h is ChainHolder => h !== null);
        if (holders.length > 0) return finish(holders);
      }
    }

    // Blockscout v2, paginated 50 at a time.
    const holders: ChainHolder[] = [];
    let next: Record<string, unknown> | null = null;
    for (let page = 0; page < 4 && holders.length < limit; page++) {
      const v2 = new URL(`${base}/api/v2/tokens/${encodeURIComponent(mint)}/holders`);
      if (next) {
        for (const [k, v] of Object.entries(next)) {
          if (v !== null && v !== undefined) v2.searchParams.set(k, String(v));
        }
      }
      const res2 = await fetchImpl(v2.toString(), { signal: controller.signal });
      if (!res2.ok) throw new Error(`explorer holders HTTP ${res2.status}`);
      const body2 = (await res2.json().catch(() => ({}))) as {
        items?: Array<{ address?: { hash?: string }; value?: string }>;
        next_page_params?: Record<string, unknown> | null;
      };
      for (const item of body2.items ?? []) {
        const atoms = parseAtoms(item.value);
        if (atoms === null) continue;
        const h = toHolder((item.address?.hash ?? '').trim(), atoms, decimals, curve, tagged);
        if (h) holders.push(h);
      }
      next = body2.next_page_params ?? null;
      if (!next) break;
    }
    if (holders.length === 0) throw new Error('explorer returned no holders');
    return finish(holders);
  } finally {
    clearTimeout(timer);
  }
}

/** The one EVM read this module needs: raw `eth_call` (what `EvmRpc` and the test fake both offer). */
export interface EthCaller {
  ethCall(to: string, data: string): Promise<string>;
}

export interface FetchEvmHoldersFromRpcOptions {
  mint: string;
  /** Candidate wallets: everyone the indexer has ever seen trade, plus the program accounts. */
  wallets: string[];
  launchpad?: string;
  tagged?: TaggedAccounts;
  decimals?: number;
  limit?: number;
  rpc: EthCaller;
  /** Parallel `eth_call` fan-out; the explorer path is preferred for large lists. */
  maxCalls?: number;
}

/**
 * `balanceOf()` per candidate wallet over plain `eth_call`.
 *
 * The explorer is the only cheap way to *discover* holders; this is the way
 * to *verify* the ones the indexer already knows about when the explorer is
 * down, so the tab shows chain balances rather than the snapshot's running
 * total (which drifts the moment someone stakes or transfers).
 */
export async function fetchEvmHoldersFromRpc(
  opts: FetchEvmHoldersFromRpcOptions,
): Promise<ChainHoldersResult> {
  const decimals = opts.decimals ?? 18;
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const curve = opts.launchpad ? padAddr(opts.launchpad) : '';
  const seen = new Set<string>();
  const wallets: string[] = [];
  for (const w of [...(opts.launchpad ? [opts.launchpad] : []), ...opts.wallets]) {
    const key = padAddr(w);
    if (!/^0x[0-9a-f]{40}$/.test(key) || seen.has(key)) continue;
    seen.add(key);
    wallets.push(w.trim());
    if (wallets.length >= (opts.maxCalls ?? 64)) break;
  }
  if (wallets.length === 0) throw new Error('no candidate wallets');
  let answered = 0;
  const results = await Promise.all(
    wallets.map(async (w) => {
      const data = '0x70a08231' + padAddr(w).slice(2).padStart(64, '0');
      const raw = await opts.rpc.ethCall(opts.mint, data);
      // A codeless address answers `0x`, not a zero word: that is "no such
      // token here", never "nobody holds it".
      if (!raw || raw === '0x') return null;
      answered++;
      return toHolder(w, BigInt(raw), decimals, curve, opts.tagged);
    }),
  );
  if (answered === 0) throw new Error('token returned no data for balanceOf (no code at address?)');
  const holders = results
    .filter((h): h is ChainHolder => h !== null)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, limit);
  return { holders, source: 'rpc' };
}

export interface FetchSolHoldersOptions {
  mint: string;
  /** Optional vault/curve token account to tag. */
  curveWallet?: string;
  /** Program-owned token accounts (curve vault, LP vault, stake escrow, bucket) by address. */
  tagged?: TaggedAccounts;
  decimals?: number;
  limit?: number;
  rpcUrl: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

interface SolRpcResponse<T> {
  result?: T;
  error?: { message?: string };
}

/**
 * Solana `getTokenLargestAccounts` — top holders by balance.
 *
 * The RPC returns token *accounts*; the wallet shown is the account's owner
 * (`getMultipleAccounts` with `jsonParsed`), except for the program-owned
 * vaults, which are reported under their own address and tagged.
 */
export async function fetchSolHoldersFromRpc(
  opts: FetchSolHoldersOptions,
): Promise<ChainHoldersResult> {
  const fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const decimals = opts.decimals ?? 6;
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 20); // RPC caps at 20
  const tagged: TaggedAccounts = { ...(opts.tagged ?? {}) };
  if (opts.curveWallet) tagged[opts.curveWallet.trim()] = 'curve';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const rpc = async <T>(method: string, params: unknown[]): Promise<T> => {
    const res = await fetchImpl(opts.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!res.ok) throw new Error(`sol holders HTTP ${res.status}`);
    const body = (await res.json()) as SolRpcResponse<T>;
    if (body.error) throw new Error(body.error.message ?? 'sol holders rpc error');
    return body.result as T;
  };
  try {
    const largest = await rpc<{
      value?: Array<{
        address: string;
        amount: string;
        decimals?: number;
        uiAmount?: number | null;
      }>;
    }>('getTokenLargestAccounts', [opts.mint, { commitment: 'confirmed' }]);
    const rows = (largest?.value ?? []).slice(0, limit);
    const accounts = rows
      .map((r) => {
        const amount =
          typeof r.uiAmount === 'number' && Number.isFinite(r.uiAmount)
            ? r.uiAmount
            : fromAtoms(BigInt(r.amount), r.decimals ?? decimals);
        return { account: r.address, amount };
      })
      .filter((r) => r.amount > 0);
    if (accounts.length === 0) throw new Error('sol rpc returned no holders');

    // Token account -> owner wallet for everything that is not a known vault.
    const owners = new Map<string, string>();
    const untagged = accounts.filter((a) => !tagged[a.account]).map((a) => a.account);
    if (untagged.length > 0) {
      try {
        const info = await rpc<{
          value?: Array<{
            data?: { parsed?: { info?: { owner?: string } } } | string[] | null;
          } | null>;
        }>('getMultipleAccounts', [untagged, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
        (info?.value ?? []).forEach((acc, i) => {
          const data = acc?.data;
          const owner =
            data && !Array.isArray(data) && typeof data === 'object'
              ? data.parsed?.info?.owner
              : undefined;
          const account = untagged[i];
          if (owner && account) owners.set(account, owner);
        });
      } catch {
        // Owners unknown: fall back to the token-account address below.
      }
    }

    // Several token accounts can share an owner (an ATA plus a legacy
    // account); fold them so a wallet is one row.
    const byWallet = new Map<string, ChainHolder>();
    for (const a of accounts) {
      const kind = tagged[a.account] ?? 'wallet';
      const wallet = kind === 'wallet' ? (owners.get(a.account) ?? a.account) : a.account;
      const prev = byWallet.get(wallet);
      if (prev) prev.amount += a.amount;
      else byWallet.set(wallet, { wallet, amount: a.amount, curve: kind === 'curve', kind });
    }
    const holders = [...byWallet.values()].sort((a, b) => b.amount - a.amount);
    return { holders, source: 'rpc' };
  } finally {
    clearTimeout(timer);
  }
}
