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
import { ZERO_EVM_ADDRESS } from '../env.js';
import type { Logger } from '../observability/logger.js';
import { deriveCurveColumns } from './curve-state.js';
import { mapLaunchFailure, type PreflightRefusal } from './launch-preflight.js';

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

export type RouterLaunchFunction = 'createAndBuyWithEth' | 'createWithPriceUpdate';

/* ----------------------------------------------------------------- feeds */

/** Pyth Core ETH/USD — the feed `UpgradeAtomicLaunch.s.sol` wires to WETH. */
export const PYTH_ETH_USD_FEED_ID: Hex =
  '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace';

/**
 * Which Pyth feed a launch on this base needs updated in-transaction, or
 * `null` for none:
 *
 * - ETH / WETH: ETH/USD — the only feed `PythPriceSource` reads.
 * - USD stables: `PythPriceSource` pins them at $1.00 (`setFixedPrice`).
 * - Everything else (the RH testnet stock tokens): the fallback push source,
 *   which an update to Pyth cannot refresh.
 */
export function pythFeedForBase(baseSymbol: string): Hex | null {
  const s = baseSymbol.trim().toUpperCase();
  return s === 'ETH' || s === 'WETH' ? PYTH_ETH_USD_FEED_ID : null;
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

export interface HermesSource {
  latest(feedId: Hex): Promise<HermesPriceUpdate | null>;
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

/**
 * `GET {baseUrl}/v2/updates/price/latest?ids[]=<feed>` with
 * `Authorization: Bearer <key>` (the only header style the hosted endpoint
 * accepts). Cached ~5 s per feed so a burst of prepares shares one update,
 * and bounded at 4 s: a slow Hermes means *no* update, never a slow prepare
 * — the chain's own price may still be fresh, and if it is not the preflight
 * says `oracle_stale`.
 */
export class HermesClient implements HermesSource {
  private readonly cache = new Map<string, { at: number; value: HermesPriceUpdate }>();
  private readonly inflight = new Map<string, Promise<HermesPriceUpdate | null>>();
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
    const id = feedId.toLowerCase().replace(/^0x/, '');
    const hit = this.cache.get(id);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value;
    const running = this.inflight.get(id);
    if (running) return running;
    const p = this.fetchLatest(id).finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }

  private async fetchLatest(id: string): Promise<HermesPriceUpdate | null> {
    const url = `${this.opts.baseUrl.replace(/\/+$/, '')}/v2/updates/price/latest?ids[]=${id}`;
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
      const value = parseHermesLatest(body, id);
      if (!value) throw new Error('hermes response carried no update for the feed');
      this.cache.set(id, { at: this.now(), value });
      return value;
    } catch (err) {
      // Never log the key or the URL's auth; the URL itself carries none.
      this.opts.logger?.warn('hermes: no price update; launching without one', {
        feed: `0x${id.slice(0, 8)}`,
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Parses a Hermes `/v2/updates/price/latest` body for `id` (no 0x). `null` if unusable. */
export function parseHermesLatest(body: HermesLatestBody, id: string): HermesPriceUpdate | null {
  const data = body.binary?.data;
  if (!Array.isArray(data) || data.length === 0) return null;
  const updateData: Hex[] = [];
  for (const d of data) {
    if (typeof d !== 'string' || !/^(0x)?[0-9a-fA-F]+$/.test(d) || d.length % 2 !== 0) return null;
    updateData.push((d.startsWith('0x') ? d : `0x${d}`) as Hex);
  }
  const parsed = body.parsed?.find((p) => (p.id ?? '').toLowerCase().replace(/^0x/, '') === id);
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
  return {
    feedId: `0x${id}` as Hex,
    updateData,
    price1e6: pythPriceTo1e6(raw, expo),
    publishTime,
  };
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

/** Tests: forget every cached router answer and Hermes client. */
export function resetEvmPythCaches(): void {
  hermesClients.clear();
  supportCache = new WeakMap();
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

/** How long a prepared launch stays signable on-chain (`deadline`). */
export const ROUTER_LAUNCH_DEADLINE_SECONDS = 600;

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
  /** Dev buy in wei; `0n` for none. */
  devBuyWei: bigint;
  supplyAtoms: bigint;
  baseDecimals: number;
  tokenDecimals: number;
  /** The API's own price for the base, used to quote when Hermes has none. */
  fallbackPrice1e6: bigint;
  /** Dev-buy tolerance, bps. */
  slipBps: bigint;
  nowMs: number;
  logger: Logger;
}

export interface RouterLaunchPlan {
  to: Address;
  data: Hex;
  value: bigint;
  fn: RouterLaunchFunction;
  updateFee: bigint;
  priceUpdate: { feedId: Hex; publishTime: number; price1e6: bigint } | null;
  /** Set for `createAndBuyWithEth`: the atomic dev buy and its floor. */
  devBuy: { wei: bigint; minTokenOut: bigint; quotedTokensOut: bigint } | null;
  deadline: bigint;
}

export type RouterLaunchPlanResult =
  { ok: true; plan: RouterLaunchPlan } | { ok: false; status: 422; error: string; detail: string };

/**
 * The single transaction an EVM launch signs: a Hermes update for the base's
 * feed (if it has one and the router can take it), its fee from
 * `pyth.getUpdateFee`, and either `createAndBuyWithEth` (WETH base, dev buy
 * > 0; `minTokenOut` quoted on the coin's *fresh* curve at the Hermes price,
 * less `slipBps`) or `createWithPriceUpdate`.
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
  const feed = pythFeedForBase(input.baseSymbol);
  if (feed && input.pyth && input.hermes) {
    const update = await input.hermes.latest(feed);
    if (update) {
      try {
        updateFee = await readPythUpdateFee(input.caller, input.pyth, update.updateData);
        updateData = update.updateData;
        priceUpdate = {
          feedId: update.feedId,
          publishTime: update.publishTime,
          price1e6: update.price1e6,
        };
      } catch (err) {
        logger.warn('launch/prepare: pyth getUpdateFee failed; launching without an update', {
          net: input.net,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  if (input.devBuyWei > 0n && input.isWethBase) {
    const price1e6 = priceUpdate?.price1e6 ?? input.fallbackPrice1e6;
    const curve = deriveCurveColumns(
      input.supplyAtoms,
      price1e6,
      input.baseDecimals,
      input.tokenDecimals,
      input.net,
    );
    const fill = curve
      ? buyQuote(freshState(curve.params), input.params.feeBps, input.devBuyWei)
      : null;
    if (!fill || fill.tokensOut <= 0n) {
      return {
        ok: false,
        status: 422,
        error: 'dev_buy_failed',
        detail: 'the dev buy amount could not be filled against a fresh curve',
      };
    }
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
        deadline,
      },
    };
  }

  return {
    ok: true,
    plan: {
      to: input.router,
      data: encodeCreateWithPriceUpdate(input.params, updateData, deadline),
      value: updateFee,
      fn: 'createWithPriceUpdate',
      updateFee,
      priceUpdate,
      devBuy: null,
      deadline,
    },
  };
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
} as const;

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
    decoded.functionName !== 'createWithPriceUpdate'
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
    return d.functionName === 'createAndBuyWithEth' || d.functionName === 'createWithPriceUpdate';
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
