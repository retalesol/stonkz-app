import type { Net } from '@stonkz/shared';
import { type Candle, type Timeframe } from '../lib/candles.js';

/**
 * The token page's own reads beyond what `api.watchToken()` hydrates: per
 * timeframe candles, the detail extras (`/tokens/:sym` — real volume,
 * liquidity, cap in the base asset, links), older trade pages and a holders
 * refresh. Plain `fetch` against the public read endpoints; nothing here
 * needs a session.
 */

const BASE = import.meta.env['VITE_API_URL'] ?? '';

export interface TokenIdentity {
  sym: string;
  net?: Net | undefined;
  mint?: string | undefined;
}

function qs(c: TokenIdentity, extra: Record<string, string | number | undefined> = {}): string {
  const p = new URLSearchParams();
  p.set('net', c.net ?? 'SOL');
  if (c.mint) p.set('mint', c.mint);
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) p.set(k, String(v));
  return '?' + p.toString();
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return (await res.json()) as T;
}

/** `GET /tokens/:sym` beyond the `Coin` shape — see `tokenDetailExtras` in the API. */
export interface TokenDetail {
  mc: number;
  chg: number;
  hold: number;
  reps: number;
  supply?: number;
  nativeUnit?: string;
  vol24Usd?: number;
  vol24Native?: number;
  trades24h?: number;
  volTotalUsd?: number;
  volTotalNative?: number;
  tradeCount?: number;
  graduationUsd?: number;
  mcBase?: number;
  liqBase?: number;
  liqUsd?: number;
  circulating?: number;
  curveTokens?: number;
  lpReserve?: number;
  baseUsdAtLaunch?: number;
  graduationBase?: number;
  curveFillPct?: number;
  web?: string;
  tg?: string;
  x?: string;
  launchedAt?: number;
  graduatedAt?: number | null;
}

export function fetchTokenDetail(c: TokenIdentity): Promise<TokenDetail> {
  return getJson<TokenDetail>('/tokens/' + encodeURIComponent(c.sym) + qs(c));
}

interface ApiCandlesResponse {
  bucketMs?: number;
  supply?: number;
  basis?: 'spot' | 'indexed';
  candles: Array<{
    t: number;
    o: number;
    h: number;
    l: number;
    c: number;
    v: number;
    trades?: number;
  }>;
}

export async function fetchTokenCandles(
  c: TokenIdentity,
  tf: Timeframe,
  limit = 400,
): Promise<{ candles: Candle[]; basis: 'spot' | 'indexed' }> {
  const res = await getJson<ApiCandlesResponse>(
    '/tokens/' + encodeURIComponent(c.sym) + '/candles' + qs(c, { tf, limit }),
  );
  return {
    basis: res.basis ?? 'indexed',
    candles: (res.candles ?? [])
      .filter((k) => Number.isFinite(k.t) && k.c > 0)
      .map((k) => ({ t: k.t, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v || 0, n: k.trades ?? 1 })),
  };
}

export interface ApiTradePage<Row> {
  trades: Row[];
  hasMore?: boolean;
  nextBefore?: number;
}

/** `GET /tokens/:sym/trades` — `before` is the oldest row id already shown. */
export function fetchTokenTrades<Row>(
  c: TokenIdentity,
  opts: { before?: number | undefined; limit?: number } = {},
): Promise<ApiTradePage<Row>> {
  return getJson<ApiTradePage<Row>>(
    '/tokens/' +
      encodeURIComponent(c.sym) +
      '/trades' +
      qs(c, { limit: opts.limit ?? 40, before: opts.before }),
  );
}

export interface ApiHoldersPage<Row> {
  holders: Row[];
  holderCount?: number;
  source?: 'explorer' | 'rpc' | 'db';
  curveWallet?: string;
  stakedTotal?: number;
  supply?: number;
}

export function fetchTokenHolders<Row>(
  c: TokenIdentity,
  limit = 100,
): Promise<ApiHoldersPage<Row>> {
  return getJson<ApiHoldersPage<Row>>(
    '/tokens/' + encodeURIComponent(c.sym) + '/holders' + qs(c, { limit }),
  );
}
