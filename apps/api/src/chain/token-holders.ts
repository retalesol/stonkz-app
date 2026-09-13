import type { FetchLike } from './types.js';

/**
 * Live holder lists for a launched token.
 *
 * Prefer an explorer/token-holders API (Blockscout) or RPC over
 * `holders_snapshot`. The snapshot is only a cache for when the chain /
 * explorer is unreachable — matching "DB mocks on-chain when RPC is down".
 */

export interface ChainHolder {
  wallet: string;
  /** Whole-token units (not atoms). */
  amount: number;
  /** True when this address is the bonding-curve vault / launchpad. */
  curve: boolean;
}

export interface ChainHoldersResult {
  holders: ChainHolder[];
  source: 'explorer' | 'rpc';
}

export interface FetchEvmHoldersOptions {
  mint: string;
  /** Launchpad / curve vault — tagged `curve: true` when present. */
  launchpad?: string;
  /** Whole-token decimals (RH tokens are 18). */
  decimals?: number;
  limit?: number;
  explorerUrl: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

function padAddr(a: string): string {
  return a.trim().toLowerCase();
}

function fromAtoms(atoms: bigint, decimals: number): number {
  if (decimals <= 0) return Number(atoms);
  const base = 10n ** BigInt(decimals);
  const whole = atoms / base;
  const frac = atoms % base;
  return Number(whole) + Number(frac) / Number(base);
}

/**
 * Blockscout-compatible `?module=token&action=getTokenHolders` (RH testnet
 * explorer serves this). Falls back to `/api/v2/tokens/:addr/holders`.
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
  const base = opts.explorerUrl.replace(/\/$/, '');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const legacy = new URL(base + '/api');
    legacy.searchParams.set('module', 'token');
    legacy.searchParams.set('action', 'getTokenHolders');
    legacy.searchParams.set('contractaddress', mint);
    legacy.searchParams.set('page', '1');
    legacy.searchParams.set('offset', String(limit));

    const res = await fetchImpl(legacy.toString(), { signal: controller.signal });
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        status?: string;
        result?: Array<{ address?: string; value?: string }>;
      };
      if (body.status === '1' && Array.isArray(body.result) && body.result.length > 0) {
        const holders = body.result
          .map((r) => {
            const wallet = (r.address ?? '').trim();
            if (!wallet) return null;
            let atoms = 0n;
            try {
              atoms = BigInt(r.value ?? '0');
            } catch {
              return null;
            }
            if (atoms <= 0n) return null;
            return {
              wallet,
              amount: fromAtoms(atoms, decimals),
              curve: curve !== '' && padAddr(wallet) === curve,
            } satisfies ChainHolder;
          })
          .filter((h): h is ChainHolder => h !== null)
          .sort((a, b) => b.amount - a.amount)
          .slice(0, limit);
        if (holders.length > 0) return { holders, source: 'explorer' };
      }
    }

    // Blockscout v2
    const v2 = `${base}/api/v2/tokens/${encodeURIComponent(mint)}/holders`;
    const res2 = await fetchImpl(v2, { signal: controller.signal });
    if (!res2.ok) throw new Error(`explorer holders HTTP ${res2.status}`);
    const body2 = (await res2.json().catch(() => ({}))) as {
      items?: Array<{ address?: { hash?: string }; value?: string }>;
    };
    const holders = (body2.items ?? [])
      .map((item) => {
        const wallet = (item.address?.hash ?? '').trim();
        if (!wallet) return null;
        let atoms = 0n;
        try {
          atoms = BigInt(item.value ?? '0');
        } catch {
          return null;
        }
        if (atoms <= 0n) return null;
        return {
          wallet,
          amount: fromAtoms(atoms, decimals),
          curve: curve !== '' && padAddr(wallet) === curve,
        } satisfies ChainHolder;
      })
      .filter((h): h is ChainHolder => h !== null)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, limit);
    if (holders.length === 0) throw new Error('explorer returned no holders');
    return { holders, source: 'explorer' };
  } finally {
    clearTimeout(timer);
  }
}

export interface FetchSolHoldersOptions {
  mint: string;
  /** Optional vault/curve ATA to tag. */
  curveWallet?: string;
  decimals?: number;
  limit?: number;
  rpcUrl: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/** Solana `getTokenLargestAccounts` — top holders by balance. */
export async function fetchSolHoldersFromRpc(
  opts: FetchSolHoldersOptions,
): Promise<ChainHoldersResult> {
  const fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const decimals = opts.decimals ?? 6;
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 20); // RPC caps at 20
  const curve = opts.curveWallet ? padAddr(opts.curveWallet) : '';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(opts.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTokenLargestAccounts',
        params: [opts.mint, { commitment: 'confirmed' }],
      }),
    });
    if (!res.ok) throw new Error(`sol holders HTTP ${res.status}`);
    const body = (await res.json()) as {
      result?: { value?: Array<{ address: string; amount: string; decimals?: number; uiAmount?: number | null }> };
      error?: { message?: string };
    };
    if (body.error) throw new Error(body.error.message ?? 'sol holders rpc error');
    const rows = body.result?.value ?? [];
    const holders = rows
      .slice(0, limit)
      .map((r) => {
        const amount =
          typeof r.uiAmount === 'number' && Number.isFinite(r.uiAmount)
            ? r.uiAmount
            : fromAtoms(BigInt(r.amount), r.decimals ?? decimals);
        if (amount <= 0) return null;
        return {
          wallet: r.address,
          amount,
          curve: curve !== '' && padAddr(r.address) === curve,
        } satisfies ChainHolder;
      })
      .filter((h): h is ChainHolder => h !== null);
    if (holders.length === 0) throw new Error('sol rpc returned no holders');
    return { holders, source: 'rpc' };
  } finally {
    clearTimeout(timer);
  }
}
