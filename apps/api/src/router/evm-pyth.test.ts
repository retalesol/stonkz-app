import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionResult,
  getAddress,
  toFunctionSelector,
  type Address,
  type Hex,
} from 'viem';
import { buyQuote, freshState } from '@stonkz/curve-sim';
import { EvmRpc } from '../chain/evm.js';
import type { FetchLike } from '../chain/types.js';
import { createLogger } from '../observability/logger.js';
import { deriveCurveColumns } from './curve-state.js';
import {
  CREATE_AND_BUY_VIA_V3_SELECTOR,
  HermesClient,
  PYTH_ABI,
  PYTH_EQUITY_FEED_IDS,
  PYTH_ETH_USD_FEED_ID,
  ROUTER_LAUNCH_ABI,
  decodeAtomicBuy,
  encodeCreateAndBuyViaV3,
  encodeCreateAndBuyWithEth,
  encodeCreateWithPriceUpdate,
  hermesClientFor,
  isRouterLaunchPayload,
  mapRouterLaunchFailure,
  parseHermesLatest,
  parseHermesLatestMany,
  planRouterLaunch,
  pythFeedsForBase,
  pythPriceTo1e6,
  readRouterLaunchSupport,
  readRouterViaV3Support,
  resetEvmPythCaches,
  routerLaunchMatchesIntent,
  type CreateParams,
  type EthCallSource,
  type HermesSource,
  type StockLaunchContext,
} from './evm-pyth.js';
import { JsonRpcError } from '../chain/jsonrpc.js';
import { V3_POOL_ABI, V3_QUOTER_ABI } from './v3-pool-reads.js';

const logger = createLogger('silent');
const ROUTER = '0x00000000000000000000000000000000000a70e1' as Address;
const PYTH = '0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a' as Address;
const WETH = '0x7943e237c7F95DA44E0301572D358911207852Fa' as Address;
const FEED = PYTH_ETH_USD_FEED_ID.slice(2);
const UPDATE_HEX = `504e4155${'ab'.repeat(40)}`;

function hermesBody(price = '400012345678', expo = -8, publishTime = 1_790_000_000) {
  return {
    binary: { encoding: 'hex', data: [UPDATE_HEX] },
    parsed: [
      {
        id: FEED,
        price: { price, conf: '100000', expo, publish_time: publishTime },
        ema_price: { price, conf: '100000', expo, publish_time: publishTime },
      },
    ],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** One canned JSON-RPC reply (or a thrown transport error) per call. */
function rpcReplying(reply: unknown | Error): FetchLike {
  return async () => {
    if (reply instanceof Error) throw reply;
    return jsonResponse({ jsonrpc: '2.0', id: 1, ...(reply as object) });
  };
}

const PARAMS: CreateParams = {
  name: 'Moon',
  ticker: 'MOON',
  uri: 'ipfs://moon',
  supply: 1_000_000_000n,
  baseToken: WETH,
  feeBps: 250,
  cashback: false,
};

beforeEach(() => {
  resetEvmPythCaches();
});

describe('StonkzRouter launch ABI', () => {
  it('matches the deployed selectors', () => {
    expect(encodeCreateAndBuyWithEth(PARAMS, [], 1n, 2n).slice(0, 10)).toBe('0x69c41f4c');
    expect(encodeCreateWithPriceUpdate(PARAMS, [], 2n).slice(0, 10)).toBe('0xca6eef13');
    expect(toFunctionSelector('NoPyth()')).toBe('0x7a8e6221');
    expect(toFunctionSelector('UpdateFeeUnpaid(uint256,uint256)')).toBe('0x865ce08d');
  });

  it('computes the createAndBuyViaV3 selector from its exact signature', () => {
    expect(CREATE_AND_BUY_VIA_V3_SELECTOR).toBe('0xd6516ffd');
    expect(encodeCreateAndBuyViaV3(PARAMS, [], 3000, 1n, 2n, 3n).slice(0, 10)).toBe(
      CREATE_AND_BUY_VIA_V3_SELECTOR,
    );
    expect(isRouterLaunchPayload(encodeCreateAndBuyViaV3(PARAMS, [], 3000, 1n, 2n, 3n))).toBe(true);
  });
});

describe('pythFeedsForBase', () => {
  it('updates ETH/USD for ETH and WETH, nothing for stables', () => {
    expect(pythFeedsForBase('RH', 'ETH')).toEqual([PYTH_ETH_USD_FEED_ID]);
    expect(pythFeedsForBase('BASE', 'weth')).toEqual([PYTH_ETH_USD_FEED_ID]);
    expect(pythFeedsForBase('RH', 'USDG')).toEqual([]);
    expect(pythFeedsForBase('RH', 'USDC')).toEqual([]);
  });

  it('updates ETH/USD plus the equity feed for a stock base, per net config', () => {
    expect(pythFeedsForBase('RH', 'TSLA')).toEqual([
      PYTH_ETH_USD_FEED_ID,
      '0x16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1',
    ]);
    expect(pythFeedsForBase('RH', 'amd')).toEqual([
      PYTH_ETH_USD_FEED_ID,
      '0x3622e381dbca2efd1859253763b1adc63f7f9abb8e76da1aa8e638a57ccde93e',
    ]);
    // A stock base with no equity feed pinned still needs ETH/USD for the TWAP.
    expect(pythFeedsForBase('RH', 'AAPL')).toEqual([PYTH_ETH_USD_FEED_ID]);
    // Base lists no stock bases yet (`BASE_STOCKS` is empty).
    expect(pythFeedsForBase('BASE', 'TSLA')).toEqual([]);
  });
});

describe('Hermes', () => {
  it('scales Pyth prices to 1e6 the way PythPriceSource does (truncating)', () => {
    expect(pythPriceTo1e6(400012345678n, -8)).toBe(4000123456n);
    expect(pythPriceTo1e6(4n, -6)).toBe(4n);
    expect(pythPriceTo1e6(4n, -4)).toBe(400n);
  });

  it('parses binary.data and parsed[0].price', () => {
    const u = parseHermesLatest(hermesBody(), FEED)!;
    expect(u.updateData).toEqual([`0x${UPDATE_HEX}`]);
    expect(u.price1e6).toBe(4000123456n);
    expect(u.publishTime).toBe(1_790_000_000);
    expect(u.feedId).toBe(PYTH_ETH_USD_FEED_ID);
    expect(parseHermesLatest({ binary: { data: [] } }, FEED)).toBeNull();
    expect(parseHermesLatest({ ...hermesBody(), parsed: [] }, FEED)).toBeNull();
  });

  it('asks /v2/updates/price/latest with a Bearer key and caches for 5 s', async () => {
    let now = 1_000_000;
    const calls: { url: string; auth: string | undefined }[] = [];
    const client = new HermesClient({
      baseUrl: 'https://hermes.example/',
      apiKey: 'k-123',
      now: () => now,
      fetchImpl: async (url, init) => {
        calls.push({
          url,
          auth: (init?.headers as Record<string, string> | undefined)?.['authorization'],
        });
        return jsonResponse(hermesBody());
      },
    });
    const first = await client.latest(PYTH_ETH_USD_FEED_ID);
    expect(first?.price1e6).toBe(4000123456n);
    expect(calls).toEqual([
      { url: `https://hermes.example/v2/updates/price/latest?ids[]=${FEED}`, auth: 'Bearer k-123' },
    ]);
    now += 4_999;
    await client.latest(PYTH_ETH_USD_FEED_ID);
    expect(calls).toHaveLength(1);
    now += 2;
    await client.latest(PYTH_ETH_USD_FEED_ID);
    expect(calls).toHaveLength(2);
  });

  it('shares one in-flight request between concurrent prepares', async () => {
    let n = 0;
    const client = new HermesClient({
      baseUrl: 'https://hermes.example',
      fetchImpl: async () => {
        n++;
        return jsonResponse(hermesBody());
      },
    });
    await Promise.all([client.latest(PYTH_ETH_USD_FEED_ID), client.latest(PYTH_ETH_USD_FEED_ID)]);
    expect(n).toBe(1);
  });

  it('gives up after the timeout and returns no update', async () => {
    vi.useFakeTimers();
    try {
      const client = new HermesClient({
        baseUrl: 'https://hermes.example',
        timeoutMs: 4_000,
        fetchImpl: () => new Promise<Response>(() => {}),
      });
      const pending = client.latest(PYTH_ETH_USD_FEED_ID);
      await vi.advanceTimersByTimeAsync(4_001);
      await expect(pending).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns no update on a 401 or a malformed body, and does not cache the failure', async () => {
    let status = 401;
    const client = new HermesClient({
      baseUrl: 'https://hermes.example',
      fetchImpl: async () =>
        status === 200 ? jsonResponse(hermesBody()) : jsonResponse({}, status),
    });
    await expect(client.latest(PYTH_ETH_USD_FEED_ID)).resolves.toBeNull();
    status = 200;
    await expect(client.latest(PYTH_ETH_USD_FEED_ID)).resolves.not.toBeNull();
  });

  it('asks for several feeds in ONE request and parses each price', async () => {
    const tsla = PYTH_EQUITY_FEED_IDS['TSLA']!.slice(2);
    const urls: string[] = [];
    const client = new HermesClient({
      baseUrl: 'https://hermes.example',
      apiKey: 'k',
      fetchImpl: async (url) => {
        urls.push(url);
        return jsonResponse({
          binary: { encoding: 'hex', data: [UPDATE_HEX] },
          parsed: [
            hermesBody().parsed[0],
            { id: tsla, price: { price: '25012345', expo: -5, publish_time: 1_789_999_000 } },
          ],
        });
      },
    });
    const u = await client.latestMany([PYTH_ETH_USD_FEED_ID, PYTH_EQUITY_FEED_IDS['TSLA']!]);
    expect(urls).toEqual([
      `https://hermes.example/v2/updates/price/latest?ids[]=${FEED}&ids[]=${tsla}`,
    ]);
    expect(u?.updateData).toEqual([`0x${UPDATE_HEX}`]);
    expect(u?.prices).toEqual([
      { feedId: PYTH_ETH_USD_FEED_ID, price1e6: 4000123456n, publishTime: 1_790_000_000 },
      { feedId: `0x${tsla}`, price1e6: 250123450n, publishTime: 1_789_999_000 },
    ]);
    await client.latestMany([PYTH_ETH_USD_FEED_ID, PYTH_EQUITY_FEED_IDS['TSLA']!]);
    expect(urls).toHaveLength(1);
  });

  it('keeps a multi-feed update whose secondary feed is missing, not one missing the primary', () => {
    const tsla = PYTH_EQUITY_FEED_IDS['TSLA']!.slice(2);
    expect(parseHermesLatestMany(hermesBody(), [FEED, tsla])?.prices).toHaveLength(1);
    expect(parseHermesLatestMany(hermesBody(), [tsla, FEED])).toBeNull();
  });

  it('is disabled when PYTH_HERMES_URL is unset', () => {
    expect(hermesClientFor({ pythHermesUrl: undefined, pythHermesApiKey: 'x' })).toBeNull();
    const a = hermesClientFor({ pythHermesUrl: 'https://h', pythHermesApiKey: undefined });
    expect(a).toBe(hermesClientFor({ pythHermesUrl: 'https://h', pythHermesApiKey: undefined }));
  });
});

describe('readRouterLaunchSupport', () => {
  const pythReturn = encodeFunctionResult({
    abi: ROUTER_LAUNCH_ABI,
    functionName: 'pyth',
    result: PYTH,
  });

  it('reads pyth() from an atomic-launch router and caches the answer', async () => {
    let calls = 0;
    const caller: EthCallSource = {
      ethCall: async () => {
        calls++;
        return pythReturn;
      },
    };
    await expect(readRouterLaunchSupport(caller, ROUTER, 0)).resolves.toEqual({
      supported: true,
      pyth: PYTH,
    });
    await readRouterLaunchSupport(caller, ROUTER, 10 ** 9);
    expect(calls).toBe(1);
  });

  it('reads a zero pyth as "no updates"', async () => {
    const zero = encodeFunctionResult({
      abi: ROUTER_LAUNCH_ABI,
      functionName: 'pyth',
      result: '0x0000000000000000000000000000000000000000',
    });
    const caller: EthCallSource = { ethCall: async () => zero };
    await expect(readRouterLaunchSupport(caller, ROUTER, 0)).resolves.toEqual({
      supported: true,
      pyth: null,
    });
  });

  it('treats a revert or empty return (the previous router) as unsupported, re-asking after a minute', async () => {
    const rpc = new EvmRpc({
      url: 'http://rpc',
      chainId: 46630,
      fetchImpl: rpcReplying({ error: { code: 3, message: 'execution reverted', data: '0x' } }),
    });
    await expect(readRouterLaunchSupport(rpc, ROUTER, 0)).resolves.toEqual({ supported: false });

    let ret = '0x';
    const caller: EthCallSource = { ethCall: async () => ret };
    await expect(readRouterLaunchSupport(caller, ROUTER, 0)).resolves.toEqual({ supported: false });
    ret = pythReturn;
    await expect(readRouterLaunchSupport(caller, ROUTER, 30_000)).resolves.toEqual({
      supported: false,
    });
    await expect(readRouterLaunchSupport(caller, ROUTER, 61_000)).resolves.toMatchObject({
      supported: true,
    });
  });

  it('throws on a transport failure rather than guessing', async () => {
    const rpc = new EvmRpc({
      url: 'http://rpc',
      chainId: 46630,
      fetchImpl: rpcReplying(new Error('socket hang up')),
    });
    await expect(readRouterLaunchSupport(rpc, ROUTER, 0)).rejects.toThrow(/socket hang up/);
  });

  it('never asks the zero address', async () => {
    const caller: EthCallSource = { ethCall: vi.fn(async () => pythReturn) };
    await expect(
      readRouterLaunchSupport(caller, '0x0000000000000000000000000000000000000000', 0),
    ).resolves.toEqual({ supported: false });
    expect(caller.ethCall).not.toHaveBeenCalled();
  });
});

describe('planRouterLaunch', () => {
  const FEE = 7n;
  const hermes: HermesSource = {
    latest: async () => parseHermesLatest(hermesBody(), FEED),
  };
  const feeCaller: EthCallSource = {
    ethCall: async (to, data) => {
      expect(to).toBe(PYTH);
      const call = decodeFunctionData({ abi: PYTH_ABI, data: data as Hex });
      expect(call.args[0]).toEqual([`0x${UPDATE_HEX}`]);
      return encodeFunctionResult({ abi: PYTH_ABI, functionName: 'getUpdateFee', result: FEE });
    },
  };
  const supplyAtoms = 1_000_000_000n * 10n ** 18n;
  const base = {
    net: 'RH' as const,
    router: ROUTER,
    pyth: PYTH,
    params: PARAMS,
    baseSymbol: 'ETH',
    isWethBase: true,
    supplyAtoms,
    baseDecimals: 18,
    tokenDecimals: 18,
    fallbackPrice1e6: 4_200_000_000n,
    slipBps: 100n,
    nowMs: 1_790_000_000_000,
    logger,
  };

  it('dev-buys a WETH curve in the same call, value = fee + dev buy, floor at the Hermes price', async () => {
    const devBuyWei = 10n ** 16n;
    const r = await planRouterLaunch({ ...base, caller: feeCaller, hermes, devBuyWei });
    if (!r.ok) throw new Error(r.detail);
    const plan = r.plan;
    expect(plan.fn).toBe('createAndBuyWithEth');
    expect(plan.to).toBe(ROUTER);
    expect(plan.value).toBe(FEE + devBuyWei);

    const curve = deriveCurveColumns(supplyAtoms, 4000123456n, 18, 18, 'RH')!;
    const fill = buyQuote(freshState(curve.params), 250, devBuyWei)!;
    const call = decodeFunctionData({ abi: ROUTER_LAUNCH_ABI, data: plan.data });
    expect(call.functionName).toBe('createAndBuyWithEth');
    expect(call.args).toEqual([
      PARAMS,
      [`0x${UPDATE_HEX}`],
      (fill.tokensOut * 9_900n) / 10_000n,
      BigInt(1_790_000_000 + 600),
    ]);
  });

  it('launches without a buy through createWithPriceUpdate, value = the fee', async () => {
    const r = await planRouterLaunch({ ...base, caller: feeCaller, hermes, devBuyWei: 0n });
    if (!r.ok) throw new Error(r.detail);
    expect(r.plan.fn).toBe('createWithPriceUpdate');
    expect(r.plan.value).toBe(FEE);
    expect(r.plan.devBuy).toBeNull();
  });

  it('sends no update for a stable base, and never asks Hermes', async () => {
    const latest = vi.fn(hermes.latest);
    const r = await planRouterLaunch({
      ...base,
      caller: feeCaller,
      hermes: { latest },
      baseSymbol: 'USDG',
      isWethBase: false,
      params: { ...PARAMS, baseToken: '0x7E955252E15c84f5768B83c41a71F9eba181802F' },
      devBuyWei: 10n ** 16n,
    });
    if (!r.ok) throw new Error(r.detail);
    // A non-WETH base cannot dev-buy through `createAndBuyWithEth`.
    expect(r.plan.fn).toBe('createWithPriceUpdate');
    expect(r.plan.value).toBe(0n);
    const call = decodeFunctionData({ abi: ROUTER_LAUNCH_ABI, data: r.plan.data });
    expect(call.args?.[1]).toEqual([]);
    expect(latest).not.toHaveBeenCalled();
  });

  it('falls back to an empty update (and the API price for the floor) when Hermes has none', async () => {
    const devBuyWei = 10n ** 16n;
    const r = await planRouterLaunch({
      ...base,
      caller: feeCaller,
      hermes: { latest: async () => null },
      devBuyWei,
    });
    if (!r.ok) throw new Error(r.detail);
    expect(r.plan.value).toBe(devBuyWei);
    expect(r.plan.priceUpdate).toBeNull();
    const curve = deriveCurveColumns(supplyAtoms, 4_200_000_000n, 18, 18, 'RH')!;
    const fill = buyQuote(freshState(curve.params), 250, devBuyWei)!;
    const call = decodeFunctionData({ abi: ROUTER_LAUNCH_ABI, data: r.plan.data });
    expect(call.args?.[1]).toEqual([]);
    expect(call.args?.[2]).toBe((fill.tokensOut * 9_900n) / 10_000n);
  });

  it('drops the update when the fee cannot be read, and when the router has no Pyth', async () => {
    const broken: EthCallSource = {
      ethCall: async () => {
        throw new Error('boom');
      },
    };
    const r = await planRouterLaunch({ ...base, caller: broken, hermes, devBuyWei: 0n });
    if (!r.ok) throw new Error(r.detail);
    expect(r.plan.value).toBe(0n);
    expect(r.plan.priceUpdate).toBeNull();

    const latest = vi.fn(hermes.latest);
    const r2 = await planRouterLaunch({
      ...base,
      caller: feeCaller,
      hermes: { latest },
      pyth: null,
      devBuyWei: 0n,
    });
    if (!r2.ok) throw new Error(r2.detail);
    expect(r2.plan.value).toBe(0n);
    expect(latest).not.toHaveBeenCalled();
  });
});

describe('mapRouterLaunchFailure', () => {
  const ROUTER_ERRORS = [
    { type: 'error', name: 'NoPyth', inputs: [] },
    {
      type: 'error',
      name: 'UpdateFeeUnpaid',
      inputs: [
        { name: 'fee', type: 'uint256' },
        { name: 'value', type: 'uint256' },
      ],
    },
  ] as const;

  async function simulatedReason(data: Hex): Promise<string> {
    const rpc = new EvmRpc({
      url: 'http://rpc',
      chainId: 46630,
      fetchImpl: rpcReplying({ error: { code: 3, message: 'execution reverted', data } }),
    });
    const r = await rpc.simulateCall({ from: ROUTER, to: ROUTER, data: '0x', value: '0x1' });
    if (r.ok) throw new Error('expected a revert');
    return r.reason;
  }

  it('maps UpdateFeeUnpaid and NoPyth as a node reports them', async () => {
    const unpaid = await simulatedReason(
      encodeErrorResult({ abi: ROUTER_ERRORS, errorName: 'UpdateFeeUnpaid', args: [5n, 1n] }),
    );
    expect(mapRouterLaunchFailure(unpaid, 'ETH')).toMatchObject({
      status: 409,
      error: 'oracle_fee_changed',
    });
    const noPyth = await simulatedReason(
      encodeErrorResult({ abi: ROUTER_ERRORS, errorName: 'NoPyth' }),
    );
    expect(mapRouterLaunchFailure(noPyth, 'ETH')).toMatchObject({
      status: 503,
      error: 'oracle_update_unavailable',
      retryAfter: 60,
    });
  });

  it.each([
    ['execution reverted (0xe5a43166)', 'dev_buy_too_large'],
    ['execution reverted: BuyAboveCap(2, 1)', 'dev_buy_too_large'],
    ['execution reverted (0x1ab7da6b)', 'launch_expired'],
    ['execution reverted: stale oracle', 'oracle_stale'],
    ['execution reverted: slippage', 'dev_buy_slippage'],
    ['insufficient funds for gas * price + value', 'insufficient_funds'],
    ['execution reverted: something else', 'simulation_failed'],
    // createAndBuyViaV3's swap leg: SwapRouter02's minBaseOut, the router's own
    // shortfall error, and a pool with nothing to swap against.
    ['execution reverted: Too little received', 'stock_swap_slippage'],
    ['execution reverted (0xdea7202b)', 'stock_swap_slippage'],
    ['execution reverted: AggregatorShortfall(10, 9, 1)', 'stock_swap_slippage'],
    ['execution reverted: SPL', 'stock_pool_too_thin'],
    ['execution reverted: IIA', 'stock_pool_too_thin'],
    ['execution reverted: NoLiquidity()', 'stock_pool_too_thin'],
  ])('maps %j to %s', (reason, code) => {
    expect(mapRouterLaunchFailure(reason, 'ETH').error).toBe(code);
  });
});

describe('/launch/confirm router matching', () => {
  const intent = {
    name: 'Moon',
    ticker: 'MOON',
    uri: 'ipfs://moon',
    supply: 1e9,
    baseMint: WETH.toLowerCase(),
    feeBps: 250,
    cashback: false,
  };
  const prepared = encodeCreateAndBuyWithEth(PARAMS, [`0x${UPDATE_HEX}`], 100n, 1_000n);

  it('matches the same launch with a different update, floor and deadline', () => {
    const resent = encodeCreateAndBuyWithEth(PARAMS, ['0xdeadbeef'], 1n, 9_999n);
    expect(routerLaunchMatchesIntent(resent, prepared, intent)).toBe(true);
  });

  it.each([
    ['name', { name: 'Moon2' }],
    ['ticker', { ticker: 'MOOM' }],
    ['uri', { uri: 'ipfs://other' }],
    ['supply', { supply: 500_000_000n }],
    ['base', { baseToken: '0x4200000000000000000000000000000000000006' as Address }],
    ['fee', { feeBps: 300 }],
    ['cashback', { cashback: true }],
  ])('refuses a different %s', (_, change) => {
    const tampered = encodeCreateAndBuyWithEth({ ...PARAMS, ...change }, [], 1n, 1n);
    expect(routerLaunchMatchesIntent(tampered, prepared, intent)).toBe(false);
  });

  it('refuses the other launch function, and garbage', () => {
    const other = encodeCreateWithPriceUpdate(PARAMS, [], 1n);
    expect(routerLaunchMatchesIntent(other, prepared, intent)).toBe(false);
    expect(routerLaunchMatchesIntent('0x69c41f4c00', prepared, intent)).toBe(false);
    expect(routerLaunchMatchesIntent('0x', prepared, intent)).toBe(false);
  });
});

describe('decodeAtomicBuy', () => {
  const trader = getAddress('0x00000000000000000000000000000000000000aa');
  const token = getAddress('0x00000000000000000000000000000000000000bb');
  const topics = encodeEventTopics({
    abi: ROUTER_LAUNCH_ABI,
    eventName: 'AtomicBuy',
    args: { trader, token },
  }) as string[];
  const data = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
    [5n, 5n, 99n],
  );

  it('reads the router’s own AtomicBuy for this trader and token', () => {
    expect(decodeAtomicBuy([{ address: ROUTER, topics, data }], ROUTER, trader, token)).toEqual({
      trader,
      token,
      ethIn: 5n,
      baseFromAggregator: 5n,
      tokensOut: 99n,
    });
  });

  it('ignores the same event from any other emitter, trader or token', () => {
    expect(decodeAtomicBuy([{ address: PYTH, topics, data }], ROUTER, trader, token)).toBeNull();
    expect(decodeAtomicBuy([{ address: ROUTER, topics, data }], ROUTER, token, token)).toBeNull();
    expect(decodeAtomicBuy([{ address: ROUTER, topics, data }], ROUTER, trader, trader)).toBeNull();
  });
});

describe('readRouterViaV3Support', () => {
  const DEADLINE_EXPIRED = toFunctionSelector('DeadlineExpired()');

  function routerReverting(data: string | undefined): EthCallSource & { calls: number } {
    const src = {
      calls: 0,
      ethCall: async (_to: string, input: string) => {
        src.calls++;
        expect(input.slice(0, 10)).toBe(CREATE_AND_BUY_VIA_V3_SELECTOR);
        throw new JsonRpcError(3, 'execution reverted', data);
      },
    };
    return src;
  }

  it('reads DeadlineExpired() (the function exists) as supported, cached for good', async () => {
    const r = routerReverting(DEADLINE_EXPIRED);
    await expect(readRouterViaV3Support(r, ROUTER, 0)).resolves.toBe(true);
    await expect(readRouterViaV3Support(r, ROUTER, 10 ** 9)).resolves.toBe(true);
    expect(r.calls).toBe(1);
  });

  it('reads a data-less revert (no such function) as unsupported, re-asking after a minute', async () => {
    const r = routerReverting('0x');
    await expect(readRouterViaV3Support(r, ROUTER, 0)).resolves.toBe(false);
    await expect(readRouterViaV3Support(r, ROUTER, 30_000)).resolves.toBe(false);
    expect(r.calls).toBe(1);
    await expect(readRouterViaV3Support(r, ROUTER, 61_000)).resolves.toBe(false);
    expect(r.calls).toBe(2);
    // Through a real EvmRpc too (the revert arrives wrapped in RpcError).
    const rpc = new EvmRpc({
      url: 'http://rpc',
      chainId: 46630,
      fetchImpl: rpcReplying({ error: { code: -32000, message: 'execution reverted' } }),
    });
    await expect(readRouterViaV3Support(rpc, ROUTER, 0)).resolves.toBe(false);
  });

  it('answers false without caching when the node cannot be asked', async () => {
    let calls = 0;
    const flaky: EthCallSource = {
      ethCall: async () => {
        calls++;
        throw new Error('socket hang up');
      },
    };
    await expect(readRouterViaV3Support(flaky, ROUTER, 0)).resolves.toBe(false);
    await expect(readRouterViaV3Support(flaky, ROUTER, 1)).resolves.toBe(false);
    expect(calls).toBe(2);
  });
});

describe('planRouterLaunch: stock base via createAndBuyViaV3', () => {
  const TSLA = '0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E' as Address;
  const FACTORY = '0xdf9e3D6ffaC4513dD7b053212bbECcbCD15ec932';
  const QUOTER = '0x00000000000000000000000000000000000c0de1';
  const POOL = '0x00000000000000000000000000000000000b001e';
  const FEE = 11n;
  const DEV_BUY = 10n ** 16n; // 0.01 ETH
  const TSLA_USD_1E6 = 250_000_000n;
  // WETH (0x79…) < TSLA (0xc9…): WETH is token0, 16 TSLA per WETH ($4000 / $250).
  const SQRT_PRICE_X96 = 4n * 2n ** 96n;
  const SPOT_OUT = (DEV_BUY * 16n * 997n) / 1000n;
  const TSLA_FEED = PYTH_EQUITY_FEED_IDS['TSLA']!;

  interface ChainOpts {
    viaV3?: boolean;
    pool?: string | null;
    liquidity?: bigint;
    quoted?: bigint | 'revert';
  }

  function chain(opts: ChainOpts = {}): EthCallSource & { log: string[] } {
    const log: string[] = [];
    const pool = opts.pool === undefined ? POOL : opts.pool;
    return {
      log,
      ethCall: async (to, data) => {
        const t = to.toLowerCase();
        const sel = data.slice(0, 10);
        log.push(`${t}:${sel}`);
        if (t === PYTH.toLowerCase()) {
          return encodeFunctionResult({ abi: PYTH_ABI, functionName: 'getUpdateFee', result: FEE });
        }
        if (t === ROUTER.toLowerCase()) {
          throw new JsonRpcError(
            3,
            'execution reverted',
            opts.viaV3 === false ? '0x' : toFunctionSelector('DeadlineExpired()'),
          );
        }
        if (t === FACTORY.toLowerCase()) {
          return encodeAbiParameters(
            [{ type: 'address' }],
            [(pool ?? '0x0000000000000000000000000000000000000000') as Address],
          );
        }
        if (t === POOL.toLowerCase()) {
          const call = decodeFunctionData({ abi: V3_POOL_ABI, data: data as Hex });
          if (call.functionName === 'liquidity') {
            return encodeFunctionResult({
              abi: V3_POOL_ABI,
              functionName: 'liquidity',
              result: opts.liquidity ?? 10n ** 24n,
            });
          }
          if (call.functionName === 'slot0') {
            return encodeFunctionResult({
              abi: V3_POOL_ABI,
              functionName: 'slot0',
              result: [SQRT_PRICE_X96, 27726, 0, 1, 1, 0, true],
            });
          }
        }
        if (t === QUOTER.toLowerCase()) {
          const call = decodeFunctionData({ abi: V3_QUOTER_ABI, data: data as Hex });
          expect(call.args).toEqual([WETH, TSLA, 3000, DEV_BUY]);
          if (opts.quoted === 'revert') throw new JsonRpcError(3, 'execution reverted', '0x');
          return encodeFunctionResult({
            abi: V3_QUOTER_ABI,
            functionName: 'quoteExactInputSingle',
            result: opts.quoted ?? (SPOT_OUT * 998n) / 1000n,
          });
        }
        throw new Error(`unexpected call ${t} ${sel}`);
      },
    };
  }

  const stock: StockLaunchContext = {
    weth: WETH,
    factory: FACTORY,
    quoter: QUOTER,
    poolFee: 3000,
    swapSlipBps: 100n,
    maxImpactBps: 500n,
  };

  function hermesBoth(): HermesSource & { many: string[][] } {
    const many: string[][] = [];
    return {
      many,
      latest: async () => {
        throw new Error('a stock launch asks for both feeds at once');
      },
      latestMany: async (ids) => {
        many.push([...ids]);
        return {
          updateData: [`0x${UPDATE_HEX}`],
          prices: [
            { feedId: PYTH_ETH_USD_FEED_ID, price1e6: 4_000_000_000n, publishTime: 1 },
            { feedId: TSLA_FEED, price1e6: TSLA_USD_1E6, publishTime: 1 },
          ],
        };
      },
    };
  }

  const supplyAtoms = 1_000_000_000n * 10n ** 18n;
  const input = (caller: EthCallSource, over: Record<string, unknown> = {}) => ({
    net: 'RH' as const,
    caller,
    router: ROUTER,
    pyth: PYTH,
    hermes: hermesBoth(),
    params: { ...PARAMS, baseToken: TSLA },
    baseSymbol: 'TSLA',
    isWethBase: false,
    stock,
    devBuyWei: DEV_BUY,
    supplyAtoms,
    baseDecimals: 18,
    tokenDecimals: 18,
    fallbackPrice1e6: TSLA_USD_1E6,
    slipBps: 100n,
    nowMs: 1_790_000_000_000,
    logger,
    ...over,
  });

  it('swaps, creates and buys in one call: both feeds, 1% minBaseOut, floor from the worst swap', async () => {
    const hermes = hermesBoth();
    const r = await planRouterLaunch(input(chain(), { hermes }));
    if (!r.ok) throw new Error(r.detail);
    const plan = r.plan;
    expect(plan.fn).toBe('createAndBuyViaV3');
    expect(plan.value).toBe(FEE + DEV_BUY);
    expect(plan.nonAtomicReason).toBeNull();
    expect(hermes.many).toEqual([[PYTH_ETH_USD_FEED_ID, TSLA_FEED]]);
    expect(plan.priceUpdate?.feeds).toEqual([PYTH_ETH_USD_FEED_ID, TSLA_FEED]);

    const quoted = (SPOT_OUT * 998n) / 1000n;
    const minBaseOut = (quoted * 9_900n) / 10_000n;
    const curve = deriveCurveColumns(supplyAtoms, TSLA_USD_1E6, 18, 18, 'RH')!;
    const floorFill = buyQuote(freshState(curve.params), 250, minBaseOut)!;
    const minTokenOut = (floorFill.tokensOut * 9_900n) / 10_000n;
    const call = decodeFunctionData({ abi: ROUTER_LAUNCH_ABI, data: plan.data });
    expect(call.functionName).toBe('createAndBuyViaV3');
    expect(call.args).toEqual([
      { ...PARAMS, baseToken: TSLA },
      [`0x${UPDATE_HEX}`],
      3000,
      minBaseOut,
      minTokenOut,
      BigInt(1_790_000_000 + 600),
    ]);
    expect(plan.devBuy).toMatchObject({
      wei: DEV_BUY,
      minTokenOut,
      swap: { poolFee: 3000, quotedBaseOut: quoted, minBaseOut, source: 'quoter' },
    });
  });

  it('quotes minTokenOut at floorPrice1e6 when an input priced the stock lower', async () => {
    const r = await planRouterLaunch(input(chain(), { floorPrice1e6: 240_000_000n }));
    if (!r.ok) throw new Error(r.detail);
    const minBaseOut = r.plan.devBuy!.swap!.minBaseOut;
    const at = (price: bigint) =>
      buyQuote(
        freshState(deriveCurveColumns(supplyAtoms, price, 18, 18, 'RH')!.params),
        250,
        minBaseOut,
      )!.tokensOut;
    expect(at(240_000_000n) < at(TSLA_USD_1E6)).toBe(true);
    expect(r.plan.devBuy!.minTokenOut).toBe((at(240_000_000n) * 9_900n) / 10_000n);
  });

  it('prices the swap off slot0 when no quoter is deployed', async () => {
    const r = await planRouterLaunch(input(chain(), { stock: { ...stock, quoter: null } }));
    if (!r.ok) throw new Error(r.detail);
    expect(r.plan.devBuy?.swap).toMatchObject({
      source: 'slot0',
      quotedBaseOut: SPOT_OUT,
      minBaseOut: (SPOT_OUT * 9_900n) / 10_000n,
    });
  });

  it('keeps the two-step path (createWithPriceUpdate, not atomic) when the router lacks the function', async () => {
    const c = chain({ viaV3: false });
    const r = await planRouterLaunch(input(c));
    if (!r.ok) throw new Error(r.detail);
    expect(r.plan.fn).toBe('createWithPriceUpdate');
    expect(r.plan.devBuy).toBeNull();
    expect(r.plan.nonAtomicReason).toBe('router_lacks_v3_launch');
    expect(r.plan.value).toBe(FEE);
    // Still carries both feeds' update, and never asked the pool.
    const call = decodeFunctionData({ abi: ROUTER_LAUNCH_ABI, data: r.plan.data });
    expect(call.args?.[1]).toEqual([`0x${UPDATE_HEX}`]);
    expect(c.log.some((l) => l.startsWith(POOL.toLowerCase()))).toBe(false);
  });

  it.each([
    ['there is no pool', { pool: null }, /no pool/],
    ['the pool is empty', { liquidity: 0n }, /no liquidity/],
    [
      'the swap would move the pool 20%',
      { quoted: (SPOT_OUT * 80n) / 100n },
      /20\.0% price impact/,
    ],
  ] as const)('refuses stock_pool_too_thin when %s', async (_, opts, detail) => {
    const r = await planRouterLaunch(input(chain(opts)));
    expect(r).toMatchObject({ ok: false, status: 422, error: 'stock_pool_too_thin' });
    if (!r.ok) expect(r.detail).toMatch(detail);
  });

  it('falls back to slot0 when the quoter reverts on a live pool', async () => {
    const r = await planRouterLaunch(input(chain({ quoted: 'revert' })));
    if (!r.ok) throw new Error(r.detail);
    expect(r.plan.devBuy?.swap?.source).toBe('slot0');
  });

  it('launches a stock base without a buy through createWithPriceUpdate, never probing the router', async () => {
    const c = chain();
    const r = await planRouterLaunch(input(c, { devBuyWei: 0n }));
    if (!r.ok) throw new Error(r.detail);
    expect(r.plan.fn).toBe('createWithPriceUpdate');
    expect(r.plan.nonAtomicReason).toBeNull();
    expect(c.log.some((l) => l.startsWith(ROUTER.toLowerCase()))).toBe(false);
  });
});

describe('/launch/confirm router matching: createAndBuyViaV3', () => {
  it('matches the same stock launch with a different update and floors', () => {
    const TSLA = '0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E' as Address;
    const p = { ...PARAMS, baseToken: TSLA };
    const prepared = encodeCreateAndBuyViaV3(p, [], 3000, 10n, 20n, 30n);
    const intent = {
      name: 'Moon',
      ticker: 'MOON',
      uri: 'ipfs://moon',
      supply: 1e9,
      baseMint: TSLA.toLowerCase(),
      feeBps: 250,
      cashback: false,
    };
    expect(
      routerLaunchMatchesIntent(
        encodeCreateAndBuyViaV3(p, ['0xbeef'], 3000, 1n, 2n, 3n),
        prepared,
        intent,
      ),
    ).toBe(true);
    // Another function is another launch, even with the same params.
    expect(
      routerLaunchMatchesIntent(encodeCreateWithPriceUpdate(p, [], 1n), prepared, intent),
    ).toBe(false);
  });
});
