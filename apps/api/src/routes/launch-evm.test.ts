import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  getAddress,
  type Address,
  type Hex,
} from 'viem';
import { buyQuote, freshState } from '@stonkz/curve-sim';
import { launchIntents, tokens } from '../db/schema.js';
import { LAUNCHPAD_ABI, TOKEN_CREATED_EVENT_ABI } from '../router/evm-abi.js';
import { deriveCurveColumns } from '../router/curve-state.js';
import {
  PYTH_ABI,
  PYTH_ETH_USD_FEED_ID,
  ROUTER_LAUNCH_ABI,
  encodeCreateAndBuyWithEth,
  encodeCreateWithPriceUpdate,
  resetEvmPythCaches,
  type CreateParams,
} from '../router/evm-pyth.js';
import { createTestApp, authed, type TestApp } from '../test/app.js';

/**
 * `/launch/prepare` + `/launch/confirm` through the atomic-launch
 * `StonkzRouter`: a Hermes price update in the launch transaction, the dev
 * buy in the same call, confirm verifying `CreateParams` rather than bytes.
 * Hermes is a stubbed `fetch`; the router and Pyth are fake `eth_call`s.
 */

const RH_LAUNCHPAD = '0x000000000000000000000000000000000000dec0';
const RH_ROUTER = '0x00000000000000000000000000000000000a70e1';
const BASE_LAUNCHPAD = '0x2f197741C3ca71e3FE885a4F74C0D44e3A774D35';
const BASE_ROUTER = '0x00000000000000000000000000000000000ba5e1';
const PYTH = '0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a';
const RH_WETH = '0x7943e237c7F95DA44E0301572D358911207852Fa';
const RH_USDG = '0x7E955252E15c84f5768B83c41a71F9eba181802F';
const HERMES = 'https://hermes.test';
const UPDATE_HEX = `504e4155${'cd'.repeat(48)}`;
const FEE = 3n;
const DEV_BUY_WEI = 10n ** 16n; // 0.01 ETH
const HERMES_PRICE_1E6 = 4000123456n;

let h: TestApp;
let hermesCalls: { url: string; auth: string | undefined }[];
let hermesMode: 'ok' | 'down';

function hermesBody() {
  return {
    binary: { encoding: 'hex', data: [UPDATE_HEX] },
    parsed: [
      {
        id: PYTH_ETH_USD_FEED_ID.slice(2),
        price: { price: '400012345678', conf: '1000000', expo: -8, publish_time: 1_788_700_000 },
      },
    ],
  };
}

const SEL_PYTH = '0xf98d06f0';
const SEL_FEE = '0xd47eed45';

function wireRouter(rpc: TestApp['rpcs']['RH'], router: string, pyth: string = PYTH): void {
  rpc.setContract(router, (data) => {
    if (data.slice(0, 10) === SEL_PYTH) {
      return encodeFunctionResult({
        abi: ROUTER_LAUNCH_ABI,
        functionName: 'pyth',
        result: pyth as Address,
      });
    }
    throw new Error(`router: unexpected call ${data.slice(0, 10)}`);
  });
  rpc.setContract(PYTH, (data) => {
    if (data.slice(0, 10) === SEL_FEE) {
      return encodeFunctionResult({ abi: PYTH_ABI, functionName: 'getUpdateFee', result: FEE });
    }
    throw new Error(`pyth: unexpected call ${data.slice(0, 10)}`);
  });
}

beforeAll(async () => {
  h = await createTestApp({
    env: {
      RH_LAUNCHPAD_ADDRESS: RH_LAUNCHPAD,
      RH_ROUTER_ADDRESS: RH_ROUTER,
      BASE_LAUNCHPAD_ADDRESS: BASE_LAUNCHPAD,
      BASE_ROUTER_ADDRESS: BASE_ROUTER,
      PYTH_HERMES_URL: HERMES,
      PYTH_HERMES_API_KEY: 'test-hermes-key',
    },
  });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.db.reset();
  await h.clearRateLimits();
  resetEvmPythCaches();
  hermesCalls = [];
  hermesMode = 'ok';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      hermesCalls.push({
        url: String(url),
        auth: (init?.headers as Record<string, string> | undefined)?.['authorization'],
      });
      if (hermesMode === 'down') throw new TypeError('fetch failed');
      return new Response(JSON.stringify(hermesBody()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  for (const rpc of [h.rpcs.RH, h.rpcs.BASE]) {
    rpc.setFailing(false);
    rpc.setSimulationFailing(false);
    rpc.setSimulation({ ok: true });
  }
  wireRouter(h.rpcs.RH, RH_ROUTER);
  wireRouter(h.rpcs.BASE, BASE_ROUTER);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

interface PrepareBody {
  intentId: string;
  to: string;
  data: Hex;
  value: string;
  devBuy: { native: number; atomic: boolean; minTokenOut?: string; note?: string } | null;
  priceUpdate?: { publishTime: number; fee: string } | null;
  error?: string;
  detail?: string;
}

async function prepare(token: string, body: Record<string, unknown>) {
  const res = await h.app.request('/launch/prepare', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authed(token) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as PrepareBody };
}

async function confirm(token: string, intentId: string, signature: string) {
  const res = await h.app.request('/launch/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authed(token) },
    body: JSON.stringify({ intentId, signature }),
  });
  return {
    status: res.status,
    body: (await res.json()) as {
      mint?: string;
      sym?: string;
      error?: string;
      devBuy?: { ethInWei: string; tokensOutAtoms: string; native: number; tokens: number };
    },
  };
}

const ETH_BODY = {
  ticker: 'atom',
  name: 'Atomic Coin',
  uri: 'ipfs://atomic',
  supply: 1e9,
  feePct: 2.5,
  cashback: false,
  baseSymbol: 'ETH',
};

function tokenCreatedLog(token: Address, creator: Address, baseToken: Address, ticker: string) {
  const topics = encodeEventTopics({
    abi: TOKEN_CREATED_EVENT_ABI,
    eventName: 'TokenCreated',
    args: { token, baseToken, creator },
  }) as string[];
  const nonIndexed = TOKEN_CREATED_EVENT_ABI[0].inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(nonIndexed, [
    ticker,
    1_000_000_000n * 10n ** 18n,
    250,
    false,
    0n,
    1_000_000_000_000_000_000n,
    800_000_000_000_000_000_000_000_000n,
    800_000_000_000_000_000_000_000_000n,
    200_000_000_000_000_000_000_000_000n,
    69_000_000_000_000_000_000n,
    HERMES_PRICE_1E6,
  ]);
  return { address: RH_LAUNCHPAD, topics, data };
}

function atomicBuyLog(emitter: string, trader: Address, token: Address, tokensOut: bigint) {
  const topics = encodeEventTopics({
    abi: ROUTER_LAUNCH_ABI,
    eventName: 'AtomicBuy',
    args: { trader, token },
  }) as string[];
  const data = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
    [DEV_BUY_WEI, DEV_BUY_WEI, tokensOut],
  );
  return { address: emitter, topics, data };
}

function evmHash(seed: string): string {
  return `0x${seed.repeat(32)}`;
}

/** The `CreateParams` of a router launch call. */
function launchParams(data: Hex): CreateParams {
  const call = decodeFunctionData({ abi: ROUTER_LAUNCH_ABI, data });
  if (
    call.functionName !== 'createAndBuyWithEth' &&
    call.functionName !== 'createWithPriceUpdate'
  ) {
    throw new Error(`not a router launch: ${call.functionName}`);
  }
  return call.args[0];
}

const TOKEN = getAddress(`0x${'a70b'.padStart(40, '0')}`);

describe('EVM /launch/prepare through the atomic-launch router', () => {
  it('builds one createAndBuyWithEth call: Hermes update, value = fee + dev buy, 1% floor at the Hermes price', async () => {
    const { token, address } = await h.login('RH');
    let simulated: Record<string, unknown> | null = null;
    h.rpcs.RH.setSimulation((payload) => {
      simulated = payload;
      return { ok: true };
    });
    const { status, body } = await prepare(token, { ...ETH_BODY, devBuyNative: 0.01 });
    expect(status).toBe(200);
    expect(body.to).toBe(RH_ROUTER);
    expect(body.value).toBe((FEE + DEV_BUY_WEI).toString());
    expect(body.devBuy).toMatchObject({ native: 0.01, atomic: true });
    expect(body.devBuy?.note).toBeUndefined();
    expect(body.priceUpdate).toEqual({ publishTime: 1_788_700_000, fee: FEE.toString() });

    // Hermes: the documented URL shape and Bearer auth.
    expect(hermesCalls).toEqual([
      {
        url: `${HERMES}/v2/updates/price/latest?ids[]=${PYTH_ETH_USD_FEED_ID.slice(2)}`,
        auth: 'Bearer test-hermes-key',
      },
    ]);

    const call = decodeFunctionData({ abi: ROUTER_LAUNCH_ABI, data: body.data });
    expect(call.functionName).toBe('createAndBuyWithEth');
    const supplyAtoms = 1_000_000_000n * 10n ** 18n;
    const curve = deriveCurveColumns(supplyAtoms, HERMES_PRICE_1E6, 18, 18, 'RH')!;
    const fill = buyQuote(freshState(curve.params), 250, DEV_BUY_WEI)!;
    expect(call.args).toEqual([
      {
        name: 'Atomic Coin',
        ticker: 'ATOM',
        uri: 'ipfs://atomic',
        supply: 1_000_000_000n,
        baseToken: RH_WETH,
        feeBps: 250,
        cashback: false,
      },
      [`0x${UPDATE_HEX}`],
      (fill.tokensOut * 9_900n) / 10_000n,
      BigInt(Math.floor(h.now() / 1000) + 600),
    ]);
    expect(body.devBuy?.minTokenOut).toBe(((fill.tokensOut * 9_900n) / 10_000n).toString());

    // The preflight runs the exact call, value included, as the creator.
    expect(simulated).toEqual({
      from: address,
      to: RH_ROUTER,
      data: body.data,
      value: `0x${(FEE + DEV_BUY_WEI).toString(16)}`,
    });

    const [intent] = await h.deps.db
      .select()
      .from(launchIntents)
      .where(eq(launchIntents.id, body.intentId));
    expect(intent?.unsignedPayload).toBe(body.data);
    expect(intent?.devBuyNative).toBe(0.01);
  });

  it('launches without a buy through createWithPriceUpdate, value = the update fee', async () => {
    const { token } = await h.login('RH');
    const { status, body } = await prepare(token, { ...ETH_BODY, ticker: 'nobuy' });
    expect(status).toBe(200);
    expect(body.to).toBe(RH_ROUTER);
    expect(body.value).toBe(FEE.toString());
    expect(body.devBuy).toBeNull();
    const call = decodeFunctionData({ abi: ROUTER_LAUNCH_ABI, data: body.data });
    expect(call.functionName).toBe('createWithPriceUpdate');
    expect(call.args?.[1]).toEqual([`0x${UPDATE_HEX}`]);
  });

  it('sends no update for a $1-pinned stable base and never calls Hermes', async () => {
    const { token } = await h.login('RH');
    const { status, body } = await prepare(token, {
      ...ETH_BODY,
      ticker: 'usdg',
      baseSymbol: 'USDG',
      devBuyNative: 0.01,
    });
    expect(status).toBe(200);
    expect(hermesCalls).toHaveLength(0);
    expect(body.value).toBe('0');
    const call = decodeFunctionData({ abi: ROUTER_LAUNCH_ABI, data: body.data });
    expect(call.functionName).toBe('createWithPriceUpdate');
    expect(launchParams(body.data).baseToken).toBe(RH_USDG);
    expect(call.args?.[1]).toEqual([]);
    // Not a WETH curve: the dev buy cannot ride along, and the client is told so.
    expect(body.devBuy).toMatchObject({ native: 0.01, atomic: false });
  });

  it('launches with an empty update when Hermes is down (the chain price may still be fresh)', async () => {
    const { token } = await h.login('BASE');
    hermesMode = 'down';
    const { status, body } = await prepare(token, {
      ...ETH_BODY,
      ticker: 'nohermes',
      devBuyNative: 0.01,
    });
    expect(status).toBe(200);
    expect(body.to).toBe(BASE_ROUTER);
    expect(body.value).toBe(DEV_BUY_WEI.toString());
    expect(body.priceUpdate).toBeNull();
    const call = decodeFunctionData({ abi: ROUTER_LAUNCH_ABI, data: body.data });
    expect(call.functionName).toBe('createAndBuyWithEth');
    expect(call.args?.[1]).toEqual([]);
  });

  it('then reports a stale chain price as oracle_stale', async () => {
    const { token } = await h.login('RH');
    hermesMode = 'down';
    h.rpcs.RH.setSimulation({ ok: false, reason: 'execution reverted: stale oracle' });
    const { status, body } = await prepare(token, { ...ETH_BODY, ticker: 'stale' });
    expect(status).toBe(503);
    expect(body.error).toBe('oracle_stale');
  });

  it.each([
    ['execution reverted (0x865ce08d)', 409, 'oracle_fee_changed'],
    ['execution reverted (0x7a8e6221)', 503, 'oracle_update_unavailable'],
    ['execution reverted (0xe5a43166)', 422, 'dev_buy_too_large'],
    ['execution reverted: slippage', 409, 'dev_buy_slippage'],
  ])('maps router revert %j to %i %s and records nothing', async (reason, status, code) => {
    const { token } = await h.login('RH');
    h.rpcs.RH.setSimulation({ ok: false, reason });
    const res = await prepare(token, { ...ETH_BODY, ticker: 'revert', devBuyNative: 0.01 });
    expect(res.status).toBe(status);
    expect(res.body.error).toBe(code);
    const rows = await h.deps.db
      .select()
      .from(launchIntents)
      .where(eq(launchIntents.ticker, 'REVERT'));
    expect(rows).toHaveLength(0);
  });

  it('falls back to the legacy launchpad createToken while the router predates atomic launches', async () => {
    const { token } = await h.login('RH');
    h.rpcs.RH.setContract(RH_ROUTER, () => '0x');
    const { status, body } = await prepare(token, {
      ...ETH_BODY,
      ticker: 'legacy',
      devBuyNative: 0.01,
    });
    expect(status).toBe(200);
    expect(body.to).toBe(RH_LAUNCHPAD);
    expect(body.value).toBe('0x0');
    const call = decodeFunctionData({ abi: LAUNCHPAD_ABI, data: body.data });
    expect(call.functionName).toBe('createToken');
    expect(body.devBuy).toMatchObject({ native: 0.01, atomic: false });
    expect(hermesCalls).toHaveLength(0);
  });

  it('answers chain_unavailable when the router cannot be asked at all', async () => {
    const { token } = await h.login('RH');
    h.rpcs.RH.setFailing(true);
    const { status, body } = await prepare(token, { ...ETH_BODY, ticker: 'rpcdown' });
    expect(status).toBe(503);
    expect(body.error).toBe('chain_unavailable');
  });
});

describe('EVM /launch/confirm of a router launch', () => {
  async function prepared(ticker: string, devBuyNative = 0.01) {
    const login = await h.login('RH');
    const p = await prepare(login.token, { ...ETH_BODY, ticker, devBuyNative });
    expect(p.status).toBe(200);
    return { ...login, body: p.body };
  }

  it('confirms off TokenCreated and records the AtomicBuy dev buy, whatever update was re-sent', async () => {
    const { token, address, body } = await prepared('atomcnf');
    // The wallet (or a re-prepare) may carry a fresher update and floor.
    const resent = encodeCreateAndBuyWithEth(
      launchParams(body.data),
      ['0xfeedbeef'],
      1n,
      BigInt(Math.floor(h.now() / 1000) + 900),
    );
    const sig = evmHash('a1');
    h.rpcs.RH.setEvmReceipt(sig, {
      status: 'success',
      from: address,
      to: RH_ROUTER,
      input: resent,
      logs: [
        tokenCreatedLog(TOKEN, address as Address, RH_WETH, 'ATOMCNF'),
        atomicBuyLog(RH_ROUTER, address as Address, TOKEN, 12_345n * 10n ** 18n),
      ],
    });
    const res = await confirm(token, body.intentId, sig);
    expect(res.status).toBe(200);
    expect(res.body.mint?.toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(res.body.devBuy).toEqual({
      ethInWei: DEV_BUY_WEI.toString(),
      tokensOutAtoms: (12_345n * 10n ** 18n).toString(),
      native: 0.01,
      tokens: 12_345,
    });
    const [row] = await h.deps.db
      .select()
      .from(tokens)
      .where(and(eq(tokens.net, 'RH'), eq(tokens.sym, 'ATOMCNF')));
    expect(row?.mint.toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(row?.creator).toBe(address);
  });

  it('ignores an AtomicBuy that the router did not emit', async () => {
    const { token, address, body } = await prepared('fakebuy');
    const sig = evmHash('a2');
    h.rpcs.RH.setEvmReceipt(sig, {
      status: 'success',
      from: address,
      to: RH_ROUTER,
      input: body.data,
      logs: [
        tokenCreatedLog(TOKEN, address as Address, RH_WETH, 'FAKEBUY'),
        atomicBuyLog(PYTH, address as Address, TOKEN, 1n),
      ],
    });
    const res = await confirm(token, body.intentId, sig);
    expect(res.status).toBe(200);
    expect(res.body.devBuy).toBeUndefined();
  });

  it.each([
    ['ticker', { ticker: 'OTHER' }],
    ['uri', { uri: 'ipfs://swapped' }],
    ['base', { baseToken: RH_USDG as Address }],
    ['fee', { feeBps: 500 }],
  ])('refuses a router call whose %s differs from the intent', async (_, change) => {
    const { token, address, body } = await prepared(`tamp${Object.keys(change)[0]!.slice(0, 3)}`);
    const tampered = encodeCreateAndBuyWithEth(
      { ...launchParams(body.data), ...(change as Partial<CreateParams>) },
      [],
      1n,
      1n,
    );
    const sig = evmHash('b3');
    h.rpcs.RH.setEvmReceipt(sig, {
      status: 'success',
      from: address,
      to: RH_ROUTER,
      input: tampered,
      logs: [tokenCreatedLog(TOKEN, address as Address, RH_WETH, 'X')],
    });
    const res = await confirm(token, body.intentId, sig);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('signature_mismatch');
  });

  it('refuses the other launch function, and a router call sent to any other address', async () => {
    const { token, address, body } = await prepared('wrongfn');
    const sig = evmHash('c4');
    h.rpcs.RH.setEvmReceipt(sig, {
      status: 'success',
      from: address,
      to: RH_ROUTER,
      input: encodeCreateWithPriceUpdate(launchParams(body.data), [], 1n),
      logs: [tokenCreatedLog(TOKEN, address as Address, RH_WETH, 'WRONGFN')],
    });
    expect((await confirm(token, body.intentId, sig)).body.error).toBe('signature_mismatch');

    const sig2 = evmHash('c5');
    h.rpcs.RH.setEvmReceipt(sig2, {
      status: 'success',
      from: address,
      to: '0x000000000000000000000000000000000000beef',
      input: body.data,
      logs: [tokenCreatedLog(TOKEN, address as Address, RH_WETH, 'WRONGFN')],
    });
    expect((await confirm(token, body.intentId, sig2)).body.error).toBe('signature_mismatch');
  });

  it('refuses a router launch another wallet sent, or whose TokenCreated names another creator', async () => {
    const { token, address, body } = await prepared('thief');
    const sig = evmHash('d6');
    h.rpcs.RH.setEvmReceipt(sig, {
      status: 'success',
      from: '0x000000000000000000000000000000000000dEaD',
      to: RH_ROUTER,
      input: body.data,
      logs: [tokenCreatedLog(TOKEN, address as Address, RH_WETH, 'THIEF')],
    });
    const stolen = await confirm(token, body.intentId, sig);
    expect(stolen.status).toBe(403);
    expect(stolen.body.error).toBe('tx_sender_mismatch');

    const sig2 = evmHash('d7');
    h.rpcs.RH.setEvmReceipt(sig2, {
      status: 'success',
      from: address,
      to: RH_ROUTER,
      input: body.data,
      logs: [
        tokenCreatedLog(
          TOKEN,
          '0x000000000000000000000000000000000000dEaD' as Address,
          RH_WETH,
          'THIEF',
        ),
      ],
    });
    const other = await confirm(token, body.intentId, sig2);
    expect(other.status).toBe(422);
    expect(other.body.error).toBe('token_created_event_missing');
  });

  it('still confirms a legacy createToken intent sent to the launchpad', async () => {
    const { token, address } = await h.login('RH');
    h.rpcs.RH.setContract(RH_ROUTER, () => '0x');
    const p = await prepare(token, { ...ETH_BODY, ticker: 'oldpath' });
    expect(p.body.to).toBe(RH_LAUNCHPAD);
    const sig = evmHash('e8');
    h.rpcs.RH.setEvmReceipt(sig, {
      status: 'success',
      from: address,
      to: RH_LAUNCHPAD,
      input: p.body.data,
      logs: [tokenCreatedLog(TOKEN, address as Address, RH_WETH, 'OLDPATH')],
    });
    const res = await confirm(token, p.body.intentId, sig);
    expect(res.status).toBe(200);
    expect(res.body.devBuy).toBeUndefined();
  });
});
