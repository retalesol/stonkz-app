/**
 * Atomic, Pyth-priced EVM launches through `StonkzRouter`
 * (`programs/evm/src/StonkzRouter.sol`, `script/UpgradeAtomicLaunch.s.sol`).
 *
 * The launchpad now prices a launch through `PythPriceSource`, whose ETH/USD
 * read must be seconds old. The router takes a signed Hermes update, pays
 * Pyth's fee out of `msg.value`, creates the coin with the caller as creator
 * (`createTokenFor`), and — for a WETH curve — dev-buys it in the same
 * transaction:
 *
 * - `createAndBuyWithEth(p, priceUpdate, minTokenOut, deadline)`: WETH base,
 *   `msg.value = fee + devBuy`.
 * - `createWithPriceUpdate(p, priceUpdate, deadline)`: any base, no dev buy,
 *   `msg.value = fee` (anything above it is refunded).
 * - `createAndBuyViaV3(p, priceUpdate, poolFee, minBaseOut, minTokenOut,
 *   deadline)`: a stock-token base (priced by `StockPriceSource` off the
 *   WETH/stock V3 pool's TWAP), `msg.value = fee + devBuy`; the router swaps
 *   ETH → WETH → stock on V3 (`minBaseOut`), creates the coin and buys it
 *   (`minTokenOut`). Only newer routers have it — probed per router
 *   (`readRouterViaV3Support`); without it a stock dev buy stays two steps.
 *
 * Everything here is new-file logic `routes/launch.ts`'s EVM branch calls;
 * `router/launch-preflight.ts`'s shared mapper is wrapped, not edited.
 *
 * **Rollout safety.** The router address comes from `*_ROUTER_ADDRESS`, which
 * also serves trades. A router that does not answer `pyth()` (the previous
 * deployment) cannot launch, so the caller falls back to the legacy direct
 * `launchpad.createToken` — the app keeps launching whichever order the
 * operator deploys and re-points env in.
 */
import {
  decodeEventLog,
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  toFunctionSelector,
  type Address,
  type Hex,
} from 'viem';
import { buyQuote, freshState } from '@stonkz/curve-sim';
import type { EvmNet, NativeUnit } from '@stonkz/shared';
import { JsonRpcError } from '../chain/jsonrpc.js';
import { RpcError, type ChainRpc, type EvmCallSimulator, type EvmLog } from '../chain/types.js';
import { isStockBase } from '@stonkz/shared';
import { ZERO_EVM_ADDRESS } from '../env.js';
import type { Logger } from '../observability/logger.js';
import { deriveCurveColumns } from './curve-state.js';
import { mapLaunchFailure, type PreflightRefusal } from './launch-preflight.js';
import { quoteWethToToken } from './v3-pool-reads.js';

/* ------------------------------------------------------------------ ABIs */

const CREATE_PARAMS_TUPLE = {
  name: 'p',
  type: 'tuple',
  components: [
    { name: 'name', type: 'string' },
    { name: 'ticker', type: 'string' },
    { name: 'uri', type: 'string' },
    { name: 'supply', type: 'uint256' },
    { name: 'baseToken', type: 'address' },
    { name: 'feeBps', type: 'uint16' },
    { name: 'cashback', type: 'bool' },
  ],
} as const;

/** `StonkzRouter.sol`'s launch entry points, `pyth()` and `AtomicBuy`. Hand-written like `evm-abi.ts`. */
export const ROUTER_LAUNCH_ABI = [
  {
    type: 'function',
    name: 'createAndBuyWithEth',
    stateMutability: 'payable',
    inputs: [
      CREATE_PARAMS_TUPLE,
      { name: 'priceUpdate', type: 'bytes[]' },
      { name: 'minTokenOut', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [
      { name: 'token', type: 'address' },
      { name: 'tokensOut', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'createWithPriceUpdate',
    stateMutability: 'payable',
    inputs: [
      CREATE_PARAMS_TUPLE,
      { name: 'priceUpdate', type: 'bytes[]' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'token', type: 'address' }],
  },
  {
    type: 'function',
    name: 'createAndBuyViaV3',
    stateMutability: 'payable',
    inputs: [
      CREATE_PARAMS_TUPLE,
      { name: 'priceUpdate', type: 'bytes[]' },
      { name: 'poolFee', type: 'uint24' },
      { name: 'minBaseOut', type: 'uint256' },
      { name: 'minTokenOut', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [
      { name: 'token', type: 'address' },
      { name: 'tokensOut', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'pyth',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'event',
    name: 'AtomicBuy',
    inputs: [
      { name: 'trader', type: 'address', indexed: true },
      { name: 'token', type: 'address', indexed: true },
      { name: 'ethIn', type: 'uint256', indexed: false },
      { name: 'baseFromAggregator', type: 'uint256', indexed: false },
      { name: 'tokensOut', type: 'uint256', indexed: false },
    ],
  },
] as const;

export const PYTH_ABI = [
  {
    type: 'function',
    name: 'getUpdateFee',
    stateMutability: 'view',
    inputs: [{ name: 'updateData', type: 'bytes[]' }],
    outputs: [{ name: 'feeAmount', type: 'uint256' }],
  },
] as const;

export type RouterLaunchFunction =
  'createAndBuyWithEth' | 'createWithPriceUpdate' | 'createAndBuyViaV3';

const ROUTER_LAUNCH_FUNCTIONS: ReadonlySet<string> = new Set<RouterLaunchFunction>([
  'createAndBuyWithEth',
  'createWithPriceUpdate',
  'createAndBuyViaV3',
]);

/**
 * `createAndBuyViaV3((string,string,string,uint256,address,uint16,bool),bytes[],uint24,uint256,uint256,uint256)`,
 * computed from the ABI above (`evm-pyth.test.ts` pins it).
 */
export const CREATE_AND_BUY_VIA_V3_SELECTOR: Hex = toFunctionSelector(
  'createAndBuyViaV3((string,string,string,uint256,address,uint16,bool),bytes[],uint24,uint256,uint256,uint256)',
);

/* ----------------------------------------------------------------- feeds */

/** Pyth Core ETH/USD — the feed `UpgradeAtomicLaunch.s.sol` wires to WETH. */
export const PYTH_ETH_USD_FEED_ID: Hex =
  '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace';

/**
 * Pyth equity feeds for the stock-token bases, by ticker. Chain-agnostic: a
 * stock base on any net (`STOCK_BASES` in `@stonkz/shared`) uses its ticker's
 * feed. These publish during US market hours only; outside them the update
 * is stale, `StockPriceSource` ignores it, and the pool TWAP × ETH/USD prices
 * the base — so a stale equity update in `priceUpdate` is harmless.
 */
export const PYTH_EQUITY_FEED_IDS: Readonly<Record<string, Hex>> = {
  TSLA: '0x16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1',
  AMZN: '0xb5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a',
  PLTR: '0x11a70634863ddffb71f2b11f2cff29f73f3db8f6d0b78c49f2b5f4ad36e885f0',
  NFLX: '0x8376cfd7ca8bcdf372ced05307b24dced1f15b1afafdeff715664598f15a3dd2',
  AMD: '0x3622e381dbca2efd1859253763b1adc63f7f9abb8e76da1aa8e638a57ccde93e',
};

export function pythEquityFeedFor(symbol: string): Hex | null {
  return PYTH_EQUITY_FEED_IDS[symbol.trim().toUpperCase()] ?? null;
}

/**
 * Which Pyth feeds a launch on this base needs updated in-transaction, in one
 * Hermes call (`ids[]` repeated), ETH/USD first:
 *
 * - ETH / WETH: `[ETH/USD]` — the only feed `PythPriceSource` reads.
 * - A stock base: `[ETH/USD, <equity>]` — `StockPriceSource` prices the pool
 *   TWAP in ETH × ETH/USD and cross-checks the equity feed while it is fresh.
 * - USD stables and everything else: none (`$1.00` pins / the push source).
 */
export function pythFeedsForBase(net: EvmNet, baseSymbol: string): Hex[] {
  const s = baseSymbol.trim().toUpperCase();
  if (s === 'ETH' || s === 'WETH') return [PYTH_ETH_USD_FEED_ID];
  if (isStockBase(net, s)) {
    const equity = pythEquityFeedFor(s);
    return equity ? [PYTH_ETH_USD_FEED_ID, equity] : [PYTH_ETH_USD_FEED_ID];
  }
  return [];
}

/* ---------------------------------------------------------------- Hermes */

export interface HermesPriceUpdate {
  feedId: Hex;
  /** `binary.data`, 0x-prefixed — exactly what `priceUpdate` takes. */
  updateData: Hex[];
  /** Scaled to 1e6 the way `PythPriceSource._to1e6` does (truncating). */
  price1e6: bigint;
  publishTime: number;
}

export interface HermesFeedPrice {
  feedId: Hex;
  price1e6: bigint;
  publishTime: number;
}

/**
 * One Hermes answer for several feeds: a single signed `updateData` (it
 * carries every requested feed, so `priceUpdate` updates them all) and the
 * parsed price of each feed Hermes returned. `prices[0]` is always the first
 * feed asked for.
 */
export interface HermesMultiUpdate {
  updateData: Hex[];
  prices: HermesFeedPrice[];
}

export interface HermesSource {
  latest(feedId: Hex): Promise<HermesPriceUpdate | null>;
  /** Several feeds in one request (`ids[]` repeated). Optional for test fakes. */
  latestMany?(feedIds: readonly Hex[]): Promise<HermesMultiUpdate | null>;
}

/**
 * The update for `feeds` — one Hermes call even for several — or `null`. A
 * source without `latestMany` (a test fake) answers for the first feed only.
 */
export async function hermesUpdateFor(
  hermes: HermesSource,
  feeds: readonly Hex[],
): Promise<HermesMultiUpdate | null> {
  if (feeds.length === 0) return null;
  if (feeds.length > 1 && hermes.latestMany) return hermes.latestMany(feeds);
  const one = await hermes.latest(feeds[0]!);
  return one
    ? {
        updateData: one.updateData,
        prices: [{ feedId: one.feedId, price1e6: one.price1e6, publishTime: one.publishTime }],
      }
    : null;
}

/** The parsed price for `feedId` in `update`, if Hermes returned it. */
export function hermesPriceOf(
  update: HermesMultiUpdate | null,
  feedId: Hex,
): HermesFeedPrice | null {
  if (!update) return null;
  const id = feedId.toLowerCase();
  return update.prices.find((p) => p.feedId.toLowerCase() === id) ?? null;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface HermesClientOptions {
  baseUrl: string;
  apiKey?: string | undefined;
  fetchImpl?: FetchLike;
  now?: () => number;
  /** Serve a cached update this long (default 5 s). */
  cacheTtlMs?: number;
  /** Abort Hermes after this long (default 4 s) and send no update. */
  timeoutMs?: number;
  logger?: Logger;
}

/** `raw · 10^(expo + 6)`, integer, as `PythPriceSource._to1e6`. */
export function pythPriceTo1e6(raw: bigint, expo: number): bigint {
  const e = expo + 6;
  if (e >= 0) return e > 30 ? 0n : raw * 10n ** BigInt(e);
  return e < -38 ? 0n : raw / 10n ** BigInt(-e);
}

interface HermesLatestBody {
  binary?: { encoding?: string; data?: unknown };
  parsed?: { id?: string; price?: { price?: unknown; expo?: unknown; publish_time?: unknown } }[];
}

function bareId(feedId: string): string {
  return feedId.toLowerCase().replace(/^0x/, '');
}

/**
 * `GET {baseUrl}/v2/updates/price/latest?ids[]=<feed>[&ids[]=<feed>…]` with
 * `Authorization: Bearer <key>` (the only header style the hosted endpoint
 * accepts). Cached ~5 s per feed set so a burst of prepares shares one
 * update, and bounded at 4 s: a slow Hermes means *no* update, never a slow
 * prepare — the chain's own price may still be fresh, and if it is not the
 * preflight says `oracle_stale`.
 */
export class HermesClient implements HermesSource {
  private readonly cache = new Map<string, { at: number; value: HermesMultiUpdate }>();
  private readonly inflight = new Map<string, Promise<HermesMultiUpdate | null>>();
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;

  constructor(private readonly opts: HermesClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.cacheTtlMs ?? 5_000;
    this.timeoutMs = opts.timeoutMs ?? 4_000;
  }

  async latest(feedId: Hex): Promise<HermesPriceUpdate | null> {
    const many = await this.latestMany([feedId]);
    const price = many?.prices[0];
    return many && price ? { ...price, updateData: many.updateData } : null;
  }

  async latestMany(feedIds: readonly Hex[]): Promise<HermesMultiUpdate | null> {
    const ids = [...new Set(feedIds.map(bareId))];
    if (ids.length === 0) return null;
    const key = ids.join(',');
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value;
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.fetchLatest(ids, key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async fetchLatest(ids: string[], key: string): Promise<HermesMultiUpdate | null> {
    const query = ids.map((id) => `ids[]=${id}`).join('&');
    const url = `${this.opts.baseUrl.replace(/\/+$/, '')}/v2/updates/price/latest?${query}`;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`hermes timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
    });
    try {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (this.opts.apiKey) headers['authorization'] = `Bearer ${this.opts.apiKey}`;
      const res = await Promise.race([
        this.fetchImpl(url, { headers, signal: controller.signal }),
        timeout,
      ]);
      if (!res.ok) throw new Error(`hermes HTTP ${res.status}`);
      const body = (await Promise.race([res.json(), timeout])) as HermesLatestBody;
      const value = parseHermesLatestMany(body, ids);
      if (!value) throw new Error('hermes response carried no update for the feed');
      this.cache.set(key, { at: this.now(), value });
      return value;
    } catch (err) {
      // Never log the key or the URL's auth; the URL itself carries none.
      this.opts.logger?.warn('hermes: no price update; launching without one', {
        feed: ids.map((id) => `0x${id.slice(0, 8)}`).join(','),
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseFeedPrice(body: HermesLatestBody, id: string): HermesFeedPrice | null {
  const parsed = body.parsed?.find((p) => bareId(p.id ?? '') === id);
  const priceRaw = parsed?.price?.price;
  const expo = parsed?.price?.expo;
  const publishTime = parsed?.price?.publish_time;
  if (
    (typeof priceRaw !== 'string' && typeof priceRaw !== 'number') ||
    typeof expo !== 'number' ||
    typeof publishTime !== 'number'
  ) {
    return null;
  }
  let raw: bigint;
  try {
    raw = BigInt(priceRaw);
  } catch {
    return null;
  }
  if (raw <= 0n) return null;
  return { feedId: `0x${id}` as Hex, price1e6: pythPriceTo1e6(raw, expo), publishTime };
}

/**
 * Parses a Hermes `/v2/updates/price/latest` body for `ids` (no 0x). `null`
 * when the binary update is unusable or the first (primary) feed is missing;
 * a later feed Hermes did not price is simply left out of `prices`.
 */
export function parseHermesLatestMany(
  body: HermesLatestBody,
  ids: readonly string[],
): HermesMultiUpdate | null {
  const data = body.binary?.data;
  if (!Array.isArray(data) || data.length === 0) return null;
  const updateData: Hex[] = [];
  for (const d of data) {
    if (typeof d !== 'string' || !/^(0x)?[0-9a-fA-F]+$/.test(d) || d.length % 2 !== 0) return null;
    updateData.push((d.startsWith('0x') ? d : `0x${d}`) as Hex);
  }
  const prices: HermesFeedPrice[] = [];
  for (const [i, id] of ids.entries()) {
    const price = parseFeedPrice(body, bareId(id));
    if (price) prices.push(price);
    else if (i === 0) return null;
  }
  return { updateData, prices };
}

/** Parses a Hermes `/v2/updates/price/latest` body for `id` (no 0x). `null` if unusable. */
export function parseHermesLatest(body: HermesLatestBody, id: string): HermesPriceUpdate | null {
  const many = parseHermesLatestMany(body, [id]);
  const price = many?.prices[0];
  return many && price ? { ...price, updateData: many.updateData } : null;
}

const hermesClients = new Map<string, HermesClient>();

/** One cached client per Hermes endpoint + key; `null` when `PYTH_HERMES_URL` is unset. */
export function hermesClientFor(
  env: { pythHermesUrl: string | undefined; pythHermesApiKey: string | undefined },
  logger?: Logger,
): HermesClient | null {
  if (!env.pythHermesUrl) return null;
  const key = `${env.pythHermesUrl}\u0000${env.pythHermesApiKey ?? ''}`;
  let client = hermesClients.get(key);
  if (!client) {
    client = new HermesClient({
      baseUrl: env.pythHermesUrl,
      apiKey: env.pythHermesApiKey,
      ...(logger ? { logger } : {}),
    });
    hermesClients.set(key, client);
  }
  return client;
}

/* ------------------------------------------------------- router + Pyth reads */

export interface EthCallSource {
  ethCall(to: string, data: string): Promise<string>;
}

export function asEthCallSource(rpc: ChainRpc): EthCallSource | undefined {
  const c = rpc as Partial<EthCallSource>;
  return typeof c.ethCall === 'function' ? (c as EthCallSource) : undefined;
}

export type RouterLaunchSupport = { supported: true; pyth: Address | null } | { supported: false };

/** How long "this router cannot launch" is believed before asking again. */
const UNSUPPORTED_TTL_MS = 60_000;
let supportCache = new WeakMap<object, Map<string, { at: number; value: RouterLaunchSupport }>>();
let viaV3Cache = new WeakMap<object, Map<string, { at: number; value: boolean }>>();

/** Tests: forget every cached router answer and Hermes client. */
export function resetEvmPythCaches(): void {
  hermesClients.clear();
  supportCache = new WeakMap();
  viaV3Cache = new WeakMap();
}

/** The node-reported error inside `err` (an `RpcError` wraps it), if any. */
function nodeError(err: unknown): JsonRpcError | null {
  if (err instanceof JsonRpcError) return err;
  if (err instanceof RpcError && err.cause instanceof JsonRpcError) return err.cause;
  return null;
}

/** A revert's payload as a node reports it (`data`, or `data.data`); `null` if none. */
function revertData(err: JsonRpcError): string | null {
  const d = err.data;
  if (typeof d === 'string') return d;
  if (d && typeof d === 'object' && typeof (d as { data?: unknown }).data === 'string') {
    return (d as { data: string }).data;
  }
  return null;
}

/** True when `err` is a revert the node reported (an answer), not an outage. */
export function isNodeRevert(err: unknown): boolean {
  return nodeError(err) !== null;
}

/**
 * Does `router` have `createAndBuyViaV3`? Probed by calling it with an
 * already-expired deadline: a router that has it reverts with
 * `DeadlineExpired()` (or any other error of its own — the revert carries
 * data), while one that lacks it hits no function at all (no `fallback`;
 * `receive` needs empty calldata) and reverts with **no** data.
 *
 * Cached like `readRouterLaunchSupport`: "yes" for the process, "no" for a
 * minute. A transport failure answers `false` *uncached* — the launch then
 * falls back to the two-step dev buy rather than failing.
 */
export async function readRouterViaV3Support(
  caller: EthCallSource,
  router: string,
  nowMs: number,
  logger?: Logger,
): Promise<boolean> {
  if (!router || router.toLowerCase() === ZERO_EVM_ADDRESS) return false;
  let perRpc = viaV3Cache.get(caller);
  if (!perRpc) {
    perRpc = new Map();
    viaV3Cache.set(caller, perRpc);
  }
  const key = router.toLowerCase();
  const hit = perRpc.get(key);
  if (hit && (hit.value || nowMs - hit.at < UNSUPPORTED_TTL_MS)) return hit.value;

  const probe = encodeFunctionData({
    abi: ROUTER_LAUNCH_ABI,
    functionName: 'createAndBuyViaV3',
    args: [
      {
        name: '',
        ticker: '',
        uri: '',
        supply: 0n,
        baseToken: ZERO_EVM_ADDRESS as Address,
        feeBps: 0,
        cashback: false,
      },
      [],
      0,
      0n,
      0n,
      0n,
    ],
  });
  let value: boolean;
  try {
    await caller.ethCall(router, probe);
    // Nothing a real router does returns from this; a stub that does has it.
    value = true;
  } catch (err) {
    const node = nodeError(err);
    if (!node) {
      logger?.warn('launch/prepare: createAndBuyViaV3 probe failed; assuming unsupported', {
        router,
        err: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    const data = revertData(node);
    value =
      (data !== null && /^0x[0-9a-fA-F]{8}/.test(data)) ||
      /DeadlineExpired|0x1ab7da6b/i.test(node.message);
  }
  perRpc.set(key, { at: nowMs, value });
  return value;
}

/**
 * Does `router` have the atomic launch entry points? Asked through `pyth()`,
 * which only the atomic-launch router has: the previous deployment reverts
 * (no fallback, and `receive` needs empty calldata) or returns nothing.
 *
 * A router is immutable, so a "yes" is cached for the life of the process; a
 * "no" for a minute, so re-pointing `*_ROUTER_ADDRESS` needs no restart to
 * pick up. A transport failure is thrown (`RpcError`) — the caller answers
 * `chain_unavailable` rather than guessing.
 */
export async function readRouterLaunchSupport(
  caller: EthCallSource,
  router: string,
  nowMs: number,
): Promise<RouterLaunchSupport> {
  if (!router || router.toLowerCase() === ZERO_EVM_ADDRESS) return { supported: false };
  let perRpc = supportCache.get(caller);
  if (!perRpc) {
    perRpc = new Map();
    supportCache.set(caller, perRpc);
  }
  const key = router.toLowerCase();
  const hit = perRpc.get(key);
  if (hit && (hit.value.supported || nowMs - hit.at < UNSUPPORTED_TTL_MS)) return hit.value;

  let value: RouterLaunchSupport;
  try {
    const raw = await caller.ethCall(
      router,
      encodeFunctionData({ abi: ROUTER_LAUNCH_ABI, functionName: 'pyth', args: [] }),
    );
    if (!raw || raw.length < 66) {
      value = { supported: false };
    } else {
      const pyth = decodeFunctionResult({
        abi: ROUTER_LAUNCH_ABI,
        functionName: 'pyth',
        data: raw as Hex,
      });
      value = {
        supported: true,
        pyth: pyth.toLowerCase() === ZERO_EVM_ADDRESS ? null : pyth,
      };
    }
  } catch (err) {
    // The node answered with an error — `execution reverted` on a router
    // without `pyth()`. Anything else (timeout, HTTP) is not an answer.
    if (err instanceof RpcError && err.cause instanceof JsonRpcError) value = { supported: false };
    else if (err instanceof JsonRpcError) value = { supported: false };
    else throw err;
  }
  perRpc.set(key, { at: nowMs, value });
  return value;
}

/** `pyth.getUpdateFee(update)` in wei. Throws on any failure. */
export async function readPythUpdateFee(
  caller: EthCallSource,
  pyth: Address,
  updateData: readonly Hex[],
): Promise<bigint> {
  const raw = await caller.ethCall(
    pyth,
    encodeFunctionData({ abi: PYTH_ABI, functionName: 'getUpdateFee', args: [updateData] }),
  );
  if (!raw || raw.length < 66) throw new Error('getUpdateFee returned no data');
  return decodeFunctionResult({ abi: PYTH_ABI, functionName: 'getUpdateFee', data: raw as Hex });
}

/* ------------------------------------------------------------ the launch call */

export interface CreateParams {
  name: string;
  ticker: string;
  uri: string;
  /** Whole tokens — the launchpad multiplies by 1e18. */
  supply: bigint;
  baseToken: Address;
  feeBps: number;
  cashback: boolean;
}

export function encodeCreateAndBuyWithEth(
  p: CreateParams,
  priceUpdate: readonly Hex[],
  minTokenOut: bigint,
  deadline: bigint,
): Hex {
  return encodeFunctionData({
    abi: ROUTER_LAUNCH_ABI,
    functionName: 'createAndBuyWithEth',
    args: [p, priceUpdate, minTokenOut, deadline],
  });
}

export function encodeCreateWithPriceUpdate(
  p: CreateParams,
  priceUpdate: readonly Hex[],
  deadline: bigint,
): Hex {
  return encodeFunctionData({
    abi: ROUTER_LAUNCH_ABI,
    functionName: 'createWithPriceUpdate',
    args: [p, priceUpdate, deadline],
  });
}

export function encodeCreateAndBuyViaV3(
  p: CreateParams,
  priceUpdate: readonly Hex[],
  poolFee: number,
  minBaseOut: bigint,
  minTokenOut: bigint,
  deadline: bigint,
): Hex {
  return encodeFunctionData({
    abi: ROUTER_LAUNCH_ABI,
    functionName: 'createAndBuyViaV3',
    args: [p, priceUpdate, poolFee, minBaseOut, minTokenOut, deadline],
  });
}

/** How long a prepared launch stays signable on-chain (`deadline`). */
export const ROUTER_LAUNCH_DEADLINE_SECONDS = 600;

/** Default tolerance on the dev buy's ETH → stock swap (`minBaseOut`), bps. */
export const DEFAULT_STOCK_SWAP_SLIP_BPS = 100n;
/** Default ceiling on that swap's price impact vs pool spot, bps. */
export const DEFAULT_STOCK_MAX_IMPACT_BPS = 500n;

/** What a stock-base dev buy through `createAndBuyViaV3` needs. */
export interface StockLaunchContext {
  weth: Address;
  factory: string;
  /** Exact-input quoter; `null`/zero prices the swap off `slot0` instead. */
  quoter: string | null;
  /** The WETH/stock pool's fee tier (3000 on RH). */
  poolFee: number;
  /** `minBaseOut` tolerance, bps (default 1 %). */
  swapSlipBps: bigint;
  /** Refuse a dev buy whose swap would move the pool more than this, bps. */
  maxImpactBps: bigint;
}

export interface RouterLaunchPlanInput {
  net: EvmNet;
  caller: EthCallSource;
  router: Address;
  /** `router.pyth()`; `null` means the router cannot take an update. */
  pyth: Address | null;
  hermes: HermesSource | null;
  params: CreateParams;
  baseSymbol: string;
  /** `params.baseToken` is this net's WETH — the only base `createAndBuyWithEth` accepts. */
  isWethBase: boolean;
  /**
   * Set when the base is a stock token (`STOCK_BASES`): the dev buy may go
   * through `createAndBuyViaV3` if the router has it.
   */
  stock?: StockLaunchContext | null;
  /** Dev buy in wei; `0n` for none. */
  devBuyWei: bigint;
  supplyAtoms: bigint;
  baseDecimals: number;
  tokenDecimals: number;
  /**
   * The API's own USD price for the base: the quote price when Hermes has
   * none (WETH), and always for a stock base — the same inputs
   * `StockPriceSource` reads (`router/stock-price.ts`).
   */
  fallbackPrice1e6: bigint;
  /**
   * Stock base: the lowest USD price among its inputs (`BasePriceInfo.
   * floorPrice1e6`), which `minTokenOut` is quoted at so the floor holds
   * whichever input `StockPriceSource` settles on. Defaults to
   * `fallbackPrice1e6`.
   */
  floorPrice1e6?: bigint;
  /** Dev-buy tolerance, bps. */
  slipBps: bigint;
  nowMs: number;
  logger: Logger;
  /** Signed stock quotes (`router/price-attest.ts`) appended after the Pyth update; the router routes them to its attestation sink. */
  attestations?: readonly Hex[];
}

export interface RouterLaunchPlan {
  to: Address;
  data: Hex;
  value: bigint;
  fn: RouterLaunchFunction;
  updateFee: bigint;
  /** The update sent, if any; `feedId`/`price1e6` are its first feed (ETH/USD). */
  priceUpdate: { feedId: Hex; publishTime: number; price1e6: bigint; feeds: Hex[] } | null;
  /**
   * Set when the dev buy rides in this transaction (`createAndBuyWithEth`,
   * `createAndBuyViaV3`): the buy and its floors.
   */
  devBuy: {
    wei: bigint;
    minTokenOut: bigint;
    quotedTokensOut: bigint;
    /** `createAndBuyViaV3` only: the swap's quote and floor, and its pool. */
    swap?: {
      poolFee: number;
      quotedBaseOut: bigint;
      minBaseOut: bigint;
      source: 'quoter' | 'slot0';
    };
  } | null;
  /**
   * Why a requested dev buy is *not* in this transaction (it is a second
   * `/trade/prepare`), `null` when there is none or it is atomic.
   */
  nonAtomicReason: 'base_not_supported' | 'router_lacks_v3_launch' | null;
  deadline: bigint;
}

export type RouterLaunchPlanResult =
  { ok: true; plan: RouterLaunchPlan } | { ok: false; status: 422; error: string; detail: string };

const STOCK_POOL_TOO_THIN = (symbol: string, why: string): RouterLaunchPlanResult => ({
  ok: false,
  status: 422,
  error: 'stock_pool_too_thin',
  detail: `the ${symbol}/WETH pool is too thin for this dev buy right now (${why}); lower the dev buy or launch without one`,
});

/** Fresh-curve fill for `baseIn` at `price1e6`, or `null`. */
function freshCurveFill(input: RouterLaunchPlanInput, price1e6: bigint, baseIn: bigint) {
  const curve = deriveCurveColumns(
    input.supplyAtoms,
    price1e6,
    input.baseDecimals,
    input.tokenDecimals,
    input.net,
  );
  const fill = curve ? buyQuote(freshState(curve.params), input.params.feeBps, baseIn) : null;
  return fill && fill.tokensOut > 0n ? fill : null;
}

const DEV_BUY_UNFILLABLE: RouterLaunchPlanResult = {
  ok: false,
  status: 422,
  error: 'dev_buy_failed',
  detail: 'the dev buy amount could not be filled against a fresh curve',
};

/**
 * The single transaction an EVM launch signs: a Hermes update for the base's
 * feeds (ETH/USD, plus the equity feed for a stock base — one Hermes call),
 * its fee from `pyth.getUpdateFee`, and one of:
 *
 * - `createAndBuyWithEth` — WETH base, dev buy > 0; `minTokenOut` quoted on
 *   the coin's *fresh* curve at the Hermes ETH price, less `slipBps`.
 * - `createAndBuyViaV3` — stock base, dev buy > 0, and a router that has it:
 *   ETH → stock quoted on the V3 pool (`minBaseOut` = quote less
 *   `swapSlipBps`), `minTokenOut` the fresh-curve fill *of that floor* at the
 *   stock's USD price, less `slipBps`. A pool that is missing, empty or would
 *   move more than `maxImpactBps` refuses `stock_pool_too_thin`.
 * - `createWithPriceUpdate` — everything else (no dev buy, or one that must
 *   stay a second transaction: `nonAtomicReason`).
 *
 * Nothing here blocks on Hermes or the fee read: either failing sends an
 * empty update, which works while the chain's own price is fresh — and the
 * preflight reports `oracle_stale` when it is not.
 */
export async function planRouterLaunch(
  input: RouterLaunchPlanInput,
): Promise<RouterLaunchPlanResult> {
  const { logger } = input;
  const deadline = BigInt(Math.floor(input.nowMs / 1000) + ROUTER_LAUNCH_DEADLINE_SECONDS);

  let updateData: Hex[] = [];
  let updateFee = 0n;
  let priceUpdate: RouterLaunchPlan['priceUpdate'] = null;
  const feeds = pythFeedsForBase(input.net, input.baseSymbol);
  if (feeds.length > 0 && input.pyth && input.hermes) {
    const update = await hermesUpdateFor(input.hermes, feeds);
    const primary = update?.prices[0];
    if (update && primary) {
      try {
        updateFee = await readPythUpdateFee(input.caller, input.pyth, update.updateData);
        updateData = update.updateData;
        priceUpdate = {
          feedId: primary.feedId,
          publishTime: primary.publishTime,
          price1e6: primary.price1e6,
          feeds: update.prices.map((p) => p.feedId),
        };
      } catch (err) {
        logger.warn('launch/prepare: pyth getUpdateFee failed; launching without an update', {
          net: input.net,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  // Stock-price attestations ride in the same array; the fee above is Pyth's
  // alone, and the router forwards only the Pyth entries to Pyth.
  if (input.attestations && input.attestations.length > 0) {
    updateData = [...updateData, ...input.attestations];
  }

  const plain = (nonAtomicReason: RouterLaunchPlan['nonAtomicReason']): RouterLaunchPlanResult => ({
    ok: true,
    plan: {
      to: input.router,
      data: encodeCreateWithPriceUpdate(input.params, updateData, deadline),
      value: updateFee,
      fn: 'createWithPriceUpdate',
      updateFee,
      priceUpdate,
      devBuy: null,
      nonAtomicReason: input.devBuyWei > 0n ? nonAtomicReason : null,
      deadline,
    },
  });

  if (input.devBuyWei > 0n && input.isWethBase) {
    const price1e6 = priceUpdate?.price1e6 ?? input.fallbackPrice1e6;
    const fill = freshCurveFill(input, price1e6, input.devBuyWei);
    if (!fill) return DEV_BUY_UNFILLABLE;
    const minTokenOut = (fill.tokensOut * (10_000n - input.slipBps)) / 10_000n;
    return {
      ok: true,
      plan: {
        to: input.router,
        data: encodeCreateAndBuyWithEth(input.params, updateData, minTokenOut, deadline),
        value: updateFee + input.devBuyWei,
        fn: 'createAndBuyWithEth',
        updateFee,
        priceUpdate,
        devBuy: { wei: input.devBuyWei, minTokenOut, quotedTokensOut: fill.tokensOut },
        nonAtomicReason: null,
        deadline,
      },
    };
  }

  const stock = input.stock;
  if (input.devBuyWei > 0n && stock) {
    const viaV3 = await readRouterViaV3Support(input.caller, input.router, input.nowMs, logger);
    if (!viaV3) {
      logger.info('launch/prepare: router lacks createAndBuyViaV3; stock dev buy is two steps', {
        net: input.net,
        router: input.router,
        base: input.baseSymbol,
      });
      return plain('router_lacks_v3_launch');
    }
    const symbol = input.baseSymbol.trim().toUpperCase();
    const quote = await quoteWethToToken({
      eth: input.caller,
      factory: stock.factory,
      quoter: stock.quoter,
      weth: stock.weth,
      token: input.params.baseToken,
      fee: stock.poolFee,
      amountIn: input.devBuyWei,
      isRevert: isNodeRevert,
    });
    if (!quote.ok) {
      logger.warn('launch/prepare: stock pool cannot take the dev buy', {
        net: input.net,
        base: symbol,
        reason: quote.reason,
      });
      return STOCK_POOL_TOO_THIN(symbol, quote.reason.replace(/_/g, ' '));
    }
    if (quote.impactBps !== null && quote.impactBps > stock.maxImpactBps) {
      logger.warn('launch/prepare: stock dev buy would move the pool too far', {
        net: input.net,
        base: symbol,
        impactBps: quote.impactBps.toString(),
        maxImpactBps: stock.maxImpactBps.toString(),
      });
      return STOCK_POOL_TOO_THIN(
        symbol,
        `${(Number(quote.impactBps) / 100).toFixed(1)}% price impact`,
      );
    }
    const minBaseOut = (quote.amountOut * (10_000n - stock.swapSlipBps)) / 10_000n;
    if (minBaseOut <= 0n) return STOCK_POOL_TOO_THIN(symbol, 'the swap would deliver nothing');
    // The floor is the fill of the *worst* swap the router accepts, at the
    // lowest price any input gave (fewest tokens), so a swap anywhere inside
    // its tolerance still clears `minTokenOut`.
    const floorPrice =
      input.floorPrice1e6 && input.floorPrice1e6 < input.fallbackPrice1e6
        ? input.floorPrice1e6
        : input.fallbackPrice1e6;
    const quotedFill = freshCurveFill(input, input.fallbackPrice1e6, quote.amountOut);
    const floorFill = freshCurveFill(input, floorPrice, minBaseOut);
    if (!quotedFill || !floorFill) return DEV_BUY_UNFILLABLE;
    const minTokenOut = (floorFill.tokensOut * (10_000n - input.slipBps)) / 10_000n;
    return {
      ok: true,
      plan: {
        to: input.router,
        data: encodeCreateAndBuyViaV3(
          input.params,
          updateData,
          stock.poolFee,
          minBaseOut,
          minTokenOut,
          deadline,
        ),
        value: updateFee + input.devBuyWei,
        fn: 'createAndBuyViaV3',
        updateFee,
        priceUpdate,
        devBuy: {
          wei: input.devBuyWei,
          minTokenOut,
          quotedTokensOut: quotedFill.tokensOut,
          swap: {
            poolFee: stock.poolFee,
            quotedBaseOut: quote.amountOut,
            minBaseOut,
            source: quote.source,
          },
        },
        nonAtomicReason: null,
        deadline,
      },
    };
  }

  return plain('base_not_supported');
}

/** Decimal wei → the `0x` quantity `eth_call` takes. */
export function toRpcQuantity(wei: bigint): string {
  return `0x${wei.toString(16)}`;
}

/* ---------------------------------------------------------------- preflight */

const ROUTER_ERROR_SELECTORS = {
  updateFeeUnpaid: toFunctionSelector('UpdateFeeUnpaid(uint256,uint256)'),
  noPyth: toFunctionSelector('NoPyth()'),
  buyAboveCap: toFunctionSelector('BuyAboveCap(uint256,uint256)'),
  deadlineExpired: toFunctionSelector('DeadlineExpired()'),
  aggregatorShortfall: toFunctionSelector('AggregatorShortfall(uint256,uint256,uint256)'),
} as const;

/** Uniswap V3 pool / SwapRouter02 reverts that mean "no usable liquidity". */
const V3_NO_LIQUIDITY_STRINGS = new Set(['SPL', 'AS', 'IIA']);

/**
 * `mapLaunchFailure` plus the router's own custom errors, which arrive as a
 * bare selector (`chain/evm.ts` `revertReason`: "... (0x865ce08d)") or by
 * name from a node that decodes them.
 */
export function mapRouterLaunchFailure(reason: string, unit: NativeUnit): PreflightRefusal {
  const has = (sel: string, name: string): boolean =>
    reason.toLowerCase().includes(sel.toLowerCase()) || new RegExp(`\\b${name}\\b`).test(reason);
  if (has(ROUTER_ERROR_SELECTORS.updateFeeUnpaid, 'UpdateFeeUnpaid')) {
    return {
      status: 409,
      error: 'oracle_fee_changed',
      detail: 'the price-update fee changed since this launch was prepared; prepare it again',
    };
  }
  if (has(ROUTER_ERROR_SELECTORS.noPyth, 'NoPyth')) {
    return {
      status: 503,
      error: 'oracle_update_unavailable',
      detail: 'this network cannot take a live price update right now, try again shortly',
      retryAfter: 60,
    };
  }
  if (has(ROUTER_ERROR_SELECTORS.buyAboveCap, 'BuyAboveCap')) {
    return {
      status: 422,
      error: 'dev_buy_too_large',
      detail: 'the dev buy is above the per-transaction cap on this network; lower it',
    };
  }
  if (has(ROUTER_ERROR_SELECTORS.deadlineExpired, 'DeadlineExpired')) {
    return {
      status: 409,
      error: 'launch_expired',
      detail: 'this launch expired before it was sent; prepare it again',
    };
  }
  // `createAndBuyViaV3`'s swap leg (ETH → WETH → stock on V3).
  const evm =
    /execution reverted:?\s*(.*)$/im.exec(reason)?.[1]?.trim().replace(/^"|"$/g, '') ?? '';
  if (
    V3_NO_LIQUIDITY_STRINGS.has(evm) ||
    /\b(NoPool|PoolNotFound|NoLiquidity|InsufficientLiquidity)\b/.test(reason)
  ) {
    return {
      status: 422,
      error: 'stock_pool_too_thin',
      detail:
        'the stock pool has no usable liquidity for this dev buy right now; lower the dev buy or launch without one',
    };
  }
  if (
    /Too little received/i.test(reason) ||
    has(ROUTER_ERROR_SELECTORS.aggregatorShortfall, 'AggregatorShortfall') ||
    /\b(BaseShortfall|SwapShortfall|MinBaseOut|InsufficientBaseOut|BaseOutTooLow)\b/.test(reason)
  ) {
    return {
      status: 409,
      error: 'stock_swap_slippage',
      detail:
        'the stock pool price moved before the dev buy could swap into it; prepare the launch again',
    };
  }
  return mapLaunchFailure(reason, unit);
}

/**
 * The EVM pre-sign simulation, as the creator, with the exact value the
 * wallet will send. Same contract as `routes/launch.ts`'s `preflight`: an
 * execution failure is a refusal; a transport failure is logged and waved
 * through (the chain still enforces everything).
 */
export async function runEvmLaunchPreflight(args: {
  simulator: EvmCallSimulator;
  tx: { from: string; to: string; data: string; value?: string };
  unit: NativeUnit;
  logger: Logger;
  log: Record<string, unknown>;
}): Promise<PreflightRefusal | null> {
  let result: { ok: true } | { ok: false; reason: string };
  try {
    result = await args.simulator.simulateCall(args.tx);
  } catch (err) {
    args.logger.warn('launch/prepare: preflight simulation unavailable; continuing', {
      ...args.log,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (result.ok) return null;
  const refusal = mapRouterLaunchFailure(result.reason, args.unit);
  args.logger.warn('launch/prepare: preflight refused', {
    ...args.log,
    code: refusal.error,
    reason: result.reason.slice(0, 500),
  });
  return refusal;
}

/* ------------------------------------------------------------------ confirm */

export interface LaunchIntentParams {
  name: string;
  ticker: string;
  uri: string;
  supply: number;
  baseMint: string;
  feeBps: number;
  cashback: boolean;
}

/**
 * `/launch/confirm` on a router launch: the calldata's function must be the
 * one prepared (same selector as the intent's payload) and its
 * `CreateParams` must be the intent's, field for field. `priceUpdate`,
 * `minTokenOut`, `deadline` and `msg.value` are deliberately not compared —
 * a re-fetched Hermes update is still the same launch.
 */
export function routerLaunchMatchesIntent(
  input: string,
  preparedPayload: string,
  intent: LaunchIntentParams,
): boolean {
  if (!/^0x[0-9a-fA-F]{8}/.test(input)) return false;
  if (input.slice(0, 10).toLowerCase() !== preparedPayload.slice(0, 10).toLowerCase()) return false;
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: ROUTER_LAUNCH_ABI, data: input as Hex });
  } catch {
    return false;
  }
  if (
    decoded.functionName !== 'createAndBuyWithEth' &&
    decoded.functionName !== 'createWithPriceUpdate' &&
    decoded.functionName !== 'createAndBuyViaV3'
  ) {
    return false;
  }
  const p = decoded.args[0];
  return (
    p.name === intent.name &&
    p.ticker === intent.ticker &&
    p.uri === intent.uri &&
    p.supply === BigInt(Math.round(intent.supply)) &&
    p.baseToken.toLowerCase() === intent.baseMint.toLowerCase() &&
    p.feeBps === intent.feeBps &&
    p.cashback === intent.cashback
  );
}

/** True when the prepared payload is a router launch rather than `createToken`. */
export function isRouterLaunchPayload(payload: string): boolean {
  try {
    const d = decodeFunctionData({ abi: ROUTER_LAUNCH_ABI, data: payload as Hex });
    return ROUTER_LAUNCH_FUNCTIONS.has(d.functionName);
  } catch {
    return false;
  }
}

export interface DecodedAtomicBuy {
  trader: Address;
  token: Address;
  ethIn: bigint;
  baseFromAggregator: bigint;
  tokensOut: bigint;
}

/** The router's `AtomicBuy` for `trader` buying `token`, emitted by `router` itself; `null` if none. */
export function decodeAtomicBuy(
  logs: readonly EvmLog[],
  router: string,
  trader: string,
  token: string,
): DecodedAtomicBuy | null {
  for (const log of logs) {
    if (log.address.toLowerCase() !== router.toLowerCase()) continue;
    try {
      const d = decodeEventLog({
        abi: ROUTER_LAUNCH_ABI,
        data: log.data as Hex,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (d.eventName !== 'AtomicBuy') continue;
      if (d.args.trader.toLowerCase() !== trader.toLowerCase()) continue;
      if (d.args.token.toLowerCase() !== token.toLowerCase()) continue;
      return {
        trader: d.args.trader,
        token: d.args.token,
        ethIn: d.args.ethIn,
        baseFromAggregator: d.args.baseFromAggregator,
        tokensOut: d.args.tokensOut,
      };
    } catch {
      // Not an AtomicBuy.
    }
  }
  return null;
}
