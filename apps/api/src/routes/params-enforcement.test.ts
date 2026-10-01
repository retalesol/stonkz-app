import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encodeFunctionResult, toFunctionSelector } from 'viem';
import { DEFAULT_CURVE_PARAMS, packParamsWord } from '@stonkz/shared';
import { adminAuditLog } from '../db/schema.js';
import { LAUNCHPAD_PARAMS_ABI, ROUTER_CONFIG_ABI } from '../chain/params.js';
import { authed, createTestApp, type TestApp } from '../test/app.js';
import { evmWallet, type TestWallet } from '../test/wallets.js';

/**
 * The live launchpad parameters, end to end: a BASE launchpad whose
 * `paramsWord()` tightens the fee range and supply cap, a router whose
 * `maxBuyNative()` caps buys at 1 ETH, and the API refusing what the chain
 * would revert — with the live bounds in the message. Plus the public
 * `/platform/status` surface the web reads and the admin prepare of
 * `setParams` / `setRouterConfig`.
 */
const BASE_LAUNCHPAD = '0x2f197741C3ca71e3FE885a4F74C0D44e3A774D35';
const BASE_ROUTER = '0x1FA9D4Ad76D53FbF1274d10ACBA12463ae90Bdca';
const OWNER = evmWallet('params-owner');

const ONE_ETH = 10n ** 18n;
const TIGHT = {
  ...DEFAULT_CURVE_PARAMS,
  feeProtocolBps: 2000,
  feeOpsBps: 500,
  feeBurnBps: 500,
  minFeeBps: 100,
  maxFeeBps: 300,
  cbWindowSecs: 120,
  gradUsd: 100_000,
  maxSupply: 1e9,
};

let h: TestApp;
/** What the fake launchpad / router answer; tests flip these. */
const chain = { word: packParamsWord(TIGHT), maxBuy: ONE_ETH };

beforeAll(async () => {
  h = await createTestApp({
    env: {
      BASE_LAUNCHPAD_ADDRESS: BASE_LAUNCHPAD,
      BASE_ROUTER_ADDRESS: BASE_ROUTER,
      ADMIN_WALLETS: OWNER.address.toLowerCase(),
    },
  });
  h.rpcs.BASE.setContract(BASE_LAUNCHPAD, (data) =>
    data.startsWith(toFunctionSelector('paramsWord()'))
      ? encodeFunctionResult({
          abi: LAUNCHPAD_PARAMS_ABI,
          functionName: 'paramsWord',
          result: chain.word,
        })
      : '0x',
  );
  h.rpcs.BASE.setContract(BASE_ROUTER, (data) =>
    data.startsWith(toFunctionSelector('maxBuyNative()'))
      ? encodeFunctionResult({
          abi: ROUTER_CONFIG_ABI,
          functionName: 'maxBuyNative',
          result: chain.maxBuy,
        })
      : '0x',
  );
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.db.reset();
  await h.clearRateLimits();
  // The clock is frozen, so the 60-s cache never expires on its own.
  h.deps.params.invalidate();
  chain.word = packParamsWord(TIGHT);
  chain.maxBuy = ONE_ETH;
});

async function post(
  path: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await h.app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authed(token) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const LAUNCH_BODY = {
  ticker: 'PARAM',
  name: 'Param Coin',
  descr: 'reads the chain',
  supply: 1e9,
  feePct: 2,
  baseSymbol: 'WETH',
  devBuyNative: 0,
};

describe('GET /platform/status → params', () => {
  it('serves the live record per net with its provenance', async () => {
    const res = await h.app.request('/platform/status');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { params: Record<string, Record<string, unknown>> };
    const base = body.params['BASE']!;
    expect(base['source']).toBe('chain');
    expect(base['set']).toBe(true);
    expect(base['gradUsd']).toBe(100_000);
    expect(base['maxFeeBps']).toBe(300);
    expect(base['maxSupply']).toBe(1e9);
    expect(base['maxBuyNative']).toBe(ONE_ETH.toString());
    // Solana: no PDA on the fake RPC → the program's defaults, flagged.
    const sol = body.params['SOL']!;
    expect(sol['source']).toBe('default');
    expect(sol['gradUsd']).toBe(69_000);
    // RH has no launchpad in this environment.
    expect((body.params['RH'] as { error: string }).error).toMatch(/not deployed/);
  });

  it('falls back to the defaults when the launchpad predates params', async () => {
    const launchpad = h.rpcs.BASE;
    launchpad.setContract(BASE_LAUNCHPAD, () => '0x');
    try {
      const body = (await (await h.app.request('/platform/status')).json()) as {
        params: Record<string, Record<string, unknown>>;
      };
      expect(body.params['BASE']!['source']).toBe('default');
      expect(body.params['BASE']!['gradUsd']).toBe(69_000);
      // The old router still answers its cap.
      expect(body.params['BASE']!['maxBuyNative']).toBe(ONE_ETH.toString());
    } finally {
      launchpad.setContract(BASE_LAUNCHPAD, (data) =>
        data.startsWith(toFunctionSelector('paramsWord()'))
          ? encodeFunctionResult({
              abi: LAUNCHPAD_PARAMS_ABI,
              functionName: 'paramsWord',
              result: chain.word,
            })
          : '0x',
      );
    }
  });
});

describe('POST /launch/prepare under live parameters', () => {
  it('bounds the creator fee by the chain and quotes the live range', async () => {
    const { token } = await h.login('BASE');
    const { status, body } = await post('/launch/prepare', token, { ...LAUNCH_BODY, feePct: 4 });
    expect(status).toBe(422);
    expect(body['error']).toBe('invalid_fee');
    expect(body['detail']).toBe('fee must be between 1.0 and 3.0 percent');
  });

  it('refuses a fixed supply over the chain cap, naming what is offered', async () => {
    const { token } = await h.login('BASE');
    const { status, body } = await post('/launch/prepare', token, { ...LAUNCH_BODY, supply: 1e12 });
    expect(status).toBe(422);
    expect(body['error']).toBe('invalid_supply');
    expect(body['detail']).toContain('1M, 500M, 1B');
    expect(body['detail']).toContain('1,000,000,000');
  });

  it('refuses an EVM dev buy over the router cap with a readable 400', async () => {
    const { token } = await h.login('BASE');
    const { status, body } = await post('/launch/prepare', token, {
      ...LAUNCH_BODY,
      devBuyNative: 1.5,
    });
    expect(status).toBe(400);
    expect(body['error']).toBe('max_buy_exceeded');
    expect(body['detail']).toBe(
      'BASE buys are capped at 1 ETH per transaction right now; this one is 1.5 ETH',
    );
  });

  it('is uncapped when the router reports 0', async () => {
    chain.maxBuy = 0n;
    const { token } = await h.login('BASE');
    const { status, body } = await post('/launch/prepare', token, {
      ...LAUNCH_BODY,
      devBuyNative: 1.5,
    });
    // Past the cap: whatever fails next is not the cap.
    expect(status).not.toBe(400);
    expect(body['error']).not.toBe('max_buy_exceeded');
  });
});

describe('POST /trade/prepare under live parameters', () => {
  it('refuses an EVM buy over maxBuyNative before any route work', async () => {
    const { token } = await h.login('BASE');
    const { status, body } = await post('/trade/prepare', token, {
      sym: 'NOPE',
      side: 'buy',
      amount: 2,
    });
    expect(status).toBe(400);
    expect(body['error']).toBe('max_buy_exceeded');
    expect(String(body['detail'])).toMatch(/capped at 1 ETH/);
    // At the cap exactly it proceeds (and 404s on the unknown ticker).
    const ok = await post('/trade/prepare', token, { sym: 'NOPE', side: 'buy', amount: 1 });
    expect(ok.status).toBe(404);
    // Sells are never capped by it.
    const sell = await post('/trade/prepare', token, { sym: 'NOPE', side: 'sell', amount: 2 });
    expect(sell.status).toBe(404);
  });
});

/* ---------------------------------------------------------------- admin */

async function stepUp(wallet: TestWallet): Promise<string> {
  const { token } = await h.login('BASE', wallet);
  const ch = await h.app.request('/admin/auth/challenge', { headers: authed(token) });
  if (ch.status !== 200) throw new Error(`challenge ${ch.status} ${await ch.text()}`);
  const challenge = (await ch.json()) as { message: string };
  const res = await h.app.request('/admin/auth/verify', {
    method: 'POST',
    headers: { ...authed(token), 'content-type': 'application/json' },
    body: JSON.stringify({ message: challenge.message, signature: wallet.sign(challenge.message) }),
  });
  if (res.status !== 200) throw new Error(`verify ${res.status} ${await res.text()}`);
  return ((await res.json()) as { adminToken: string }).adminToken;
}

const asAdmin = (adminToken: string): Record<string, string> => ({
  authorization: `Bearer ${adminToken}`,
  origin: 'https://ston.kz',
  'content-type': 'application/json',
});

describe('admin: parameters view and setters', () => {
  it('reads the effective record next to the raw chain state', async () => {
    const admin = await stepUp(OWNER);
    const res = await h.app.request('/admin/chain/params/BASE', { headers: asAdmin(admin) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, Record<string, unknown>>;
    expect(body['deployed']).toBe(true);
    expect(body['effective']!['gradUsd']).toBe(100_000);
    expect(body['effective']!['set']).toBe(true);
    expect(body['chain']!['kind']).toBe('evm');
    expect(body['chain']!['launchpad']).toBe(BASE_LAUNCHPAD);
    expect(body['chain']!['router']).toBe(BASE_ROUTER);
    expect(body['chain']!['paramsWord']).toBe(packParamsWord(TIGHT).toString());
    expect((body['chain']!['routerConfig'] as { maxBuyNative: string }).maxBuyNative).toBe(
      ONE_ETH.toString(),
    );
    const sol = (await (
      await h.app.request('/admin/chain/params/SOL', { headers: asAdmin(admin) })
    ).json()) as Record<string, Record<string, unknown>>;
    expect(sol['chain']!['kind']).toBe('sol');
    expect((sol['chain']!['params'] as { initialised: boolean }).initialised).toBe(false);
    expect(sol['effective']!['source']).toBe('default');
    // A stranger sees nothing.
    const { token } = await h.login('BASE', evmWallet('params-stranger'));
    expect(
      (await h.app.request('/admin/chain/params/BASE', { headers: authed(token) })).status,
    ).toBe(404);
  });

  it('prepares setParams (packed word), setRouterConfig (router) and setTrustedRouter, audited', async () => {
    const admin = await stepUp(OWNER);
    const word = packParamsWord({ ...TIGHT, gradUsd: 80_000 }).toString();
    const prep = (action: Record<string, unknown>) =>
      h.app.request('/admin/chain/prepare/BASE', {
        method: 'POST',
        headers: asAdmin(admin),
        body: JSON.stringify({
          action,
          signer: OWNER.address,
          confirm: `PREPARE ${String(action['kind'])}`,
        }),
      });
    const res = await prep({ kind: 'setParams', word });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { tx: Record<string, unknown>; safe: unknown };
    expect(body.tx['to']).toBe(BASE_LAUNCHPAD);
    expect(String(body.tx['data']).startsWith(toFunctionSelector('setParams(uint256)'))).toBe(true);
    expect(body.tx['summary']).toContain('grad=$80000');
    expect(body.safe).toBeDefined();

    const cfg = await prep({
      kind: 'setRouterConfig',
      maxBuyNative: (2n * ONE_ETH).toString(),
      pyth: OWNER.address,
      attestationSink: OWNER.address,
    });
    expect(cfg.status, await cfg.clone().text()).toBe(200);
    expect(((await cfg.json()) as { tx: { to: string } }).tx.to).toBe(BASE_ROUTER);

    const trusted = await prep({ kind: 'setTrustedRouter', router: BASE_ROUTER });
    expect(trusted.status).toBe(200);

    // The contract's own rules are enforced before anything is encoded.
    const bad = await prep({
      kind: 'setParams',
      word: packParamsWord({ ...TIGHT, feeProtocolBps: 9000, feeOpsBps: 2000 }).toString(),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { detail: string }).detail).toMatch(/at most 10000/);

    // Reporting the broadcast drops the cache so the next read sees the chain.
    chain.word = BigInt(word);
    const sub = await h.app.request('/admin/chain/submitted', {
      method: 'POST',
      headers: asAdmin(admin),
      body: JSON.stringify({ net: 'BASE', kind: 'setParams', txHash: '0x' + 'ab'.repeat(32) }),
    });
    expect(sub.status).toBe(200);
    expect((await h.deps.params.get('BASE')).gradUsd).toBe(80_000);

    const actions = (
      await h.db.db.select({ action: adminAuditLog.action }).from(adminAuditLog)
    ).map((r) => r.action);
    // Three successful prepares; the refused one never reaches the audit log.
    expect(actions.filter((a) => a === 'chain.prepare')).toHaveLength(3);
    expect(actions).toContain('chain.submitted');
  });
});
