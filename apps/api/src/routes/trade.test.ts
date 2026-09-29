import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
} from '@solana/web3.js';
import { applyBuy, buyQuote, mcapBase, mcapUsd1e6 } from '@stonkz/curve-sim';
import type { Net } from '@stonkz/shared';
import { settings, tokens } from '../db/schema.js';
import { deriveCurveColumns } from '../router/curve-state.js';
import { createTestApp, authed, type TestApp } from '../test/app.js';
import { solanaWallet } from '../test/wallets.js';
import { JITO_TIP_ACCOUNTS } from '../router/solana-fees.js';
import { BroadcastFailedError } from '../router/solana-broadcast.js';
import { encodeLookupTableAccount, syntheticJupiterRoute } from '../test/solana-alt-fixtures.js';

let h: TestApp;

beforeAll(async () => {
  h = await createTestApp();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.db.reset();
  await h.clearRateLimits();
  h.jupiter.reset();
  h.uniswap.reset();
});

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const BONK_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const RH_USDC_MINT = getAddress(`0x${'def1'.padStart(40, '0')}`);
const RH_TOKEN_MINT = getAddress(`0x${'123456'.padStart(40, '0')}`);

interface SeedOpts {
  net: Net;
  sym: string;
  mint: string;
  baseSymbol: string;
  baseMint: string;
  baseDecimals: number;
  tokenDecimals: number;
  basePrice1e6: bigint;
  supply?: number;
  feeBps?: number;
  /**
   * Simulates prior on-chain trading activity by applying one buy fill to
   * the fresh curve before the row is persisted — `/trade/prepare` never
   * writes `curveRealBase`/`curveRealToken` back itself (that is the
   * indexer's job, out of this phase's scope), so a sell-side test needs
   * some already-circulating supply to sell against, exactly as a real
   * launch that already saw a buy would have.
   */
  preFillBaseAtoms?: bigint;
}

async function seedTradeableToken(opts: SeedOpts): Promise<void> {
  const supply = opts.supply ?? 1e9;
  const feeBps = opts.feeBps ?? 250;
  const supplyAtoms = BigInt(Math.round(supply)) * 10n ** BigInt(opts.tokenDecimals);
  const derived = deriveCurveColumns(
    supplyAtoms,
    opts.basePrice1e6,
    opts.baseDecimals,
    opts.tokenDecimals,
  );
  if (!derived) throw new Error('seedTradeableToken: curve derivation failed — bad fixture inputs');
  const mcapBaseAtoms = mcapBase(derived.state, supplyAtoms);
  const mc = Number(mcapUsd1e6(mcapBaseAtoms, opts.basePrice1e6, opts.baseDecimals)) / 1e6;

  let columns = derived.columns;
  if (opts.preFillBaseAtoms) {
    const fill = buyQuote(derived.state, feeBps, opts.preFillBaseAtoms);
    if (!fill)
      throw new Error(
        'seedTradeableToken: preFillBaseAtoms could not be filled against a fresh curve',
      );
    const next = applyBuy(derived.state, fill);
    columns = {
      ...columns,
      curveRealBase: next.realBase.toString(),
      curveRealToken: next.realToken.toString(),
    };
  }

  await h.deps.db.insert(tokens).values({
    net: opts.net,
    sym: opts.sym,
    name: opts.sym,
    creator: 'Dev',
    mint: opts.mint,
    baseSymbol: opts.baseSymbol,
    baseMint: opts.baseMint,
    supply,
    feeBps,
    mc,
    lastMc: mc,
    lane: 'new',
    seed: 1,
    launchedAt: new Date(h.now() - 600_000),
    ...columns,
  });
}

interface TradeBody {
  sym: string;
  side: 'buy' | 'sell';
  amount: number;
}

interface TradeQuote {
  side: string;
  routeLabel: string;
  hops: { venue: string; feeBps: number; feeAmount: number }[];
}

interface TradeStep {
  description: string;
}

interface TradePrepareResponse {
  net?: string;
  atomic?: boolean;
  transaction?: string;
  steps?: TradeStep[];
  warning?: string;
  quote?: TradeQuote;
  expiresAt?: number;
  error?: string;
  detail?: string;
  /** RH atomic path only (`router/evm-router.ts`). */
  to?: string;
  data?: string;
  value?: string;
}

async function tradePrepare(
  token: string,
  body: TradeBody,
): Promise<{ status: number; body: TradePrepareResponse }> {
  const res = await h.app.request('/trade/prepare', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authed(token) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as TradePrepareResponse };
}

/** Plan steps 83–87 — trade composition, `Settings` application, and structured router errors. */
describe('POST /trade/prepare', () => {
  it('composes an atomic Solana transaction on the direct-pair fast path (no aggregator hop)', async () => {
    await seedTradeableToken({
      net: 'SOL',
      sym: 'DIRECT',
      mint: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
      baseSymbol: 'SOL',
      baseMint: SOL_MINT,
      baseDecimals: 9,
      tokenDecimals: 6,
      basePrice1e6: 214_080_000n,
    });
    const { token, address } = await h.login('SOL');
    h.rpcs.SOL.setBalance(address, 10);

    const { status, body } = await tradePrepare(token, { sym: 'DIRECT', side: 'buy', amount: 1 });
    expect(status).toBe(200);
    expect(body.atomic).toBe(true);
    expect(typeof body.transaction).toBe('string');
    expect(body.quote?.hops).toHaveLength(1);
    expect(body.quote?.hops[0]?.venue).toBe('CURVE');
  });

  it('routes hop 1 through Jupiter and still composes one atomic transaction', async () => {
    await seedTradeableToken({
      net: 'SOL',
      sym: 'VIABONK',
      mint: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
      baseSymbol: 'BONK',
      baseMint: BONK_MINT,
      baseDecimals: 6,
      tokenDecimals: 6,
      basePrice1e6: 1_000_000n,
    });
    h.jupiter.setRoute(SOL_MINT, BONK_MINT, { rate: 1_000 });
    const { token, address } = await h.login('SOL');
    h.rpcs.SOL.setBalance(address, 10);

    const { status, body } = await tradePrepare(token, { sym: 'VIABONK', side: 'buy', amount: 1 });
    expect(status).toBe(200);
    expect(body.atomic).toBe(true);
    const quote = body.quote!;
    expect(quote.routeLabel).toBe('JUPITER → CURVE');
    expect(quote.hops[0]).toMatchObject({ venue: 'JUPITER', feeBps: 0, feeAmount: 0 });
    expect(quote.hops[1]?.venue).toBe('CURVE');
    expect(quote.hops[1]?.feeBps).toBe(250);
  });

  it('composes a Jupiter hop whose route uses lookup tables as one v0 transaction', async () => {
    await seedTradeableToken({
      net: 'SOL',
      sym: 'ALTBONK',
      mint: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
      baseSymbol: 'BONK',
      baseMint: BONK_MINT,
      baseDecimals: 6,
      tokenDecimals: 6,
      basePrice1e6: 1_000_000n,
    });
    h.jupiter.setRoute(SOL_MINT, BONK_MINT, { rate: 1_000 });
    const { token, address } = await h.login('SOL');
    h.rpcs.SOL.setBalance(address, 10);
    const route = syntheticJupiterRoute({
      user: new PublicKey(address),
      baseMint: new PublicKey(BONK_MINT),
      poolAccounts: 21,
      tableCount: 2,
    });
    h.jupiter.setSwapInstructions(route.response);
    for (const t of route.tables) {
      h.rpcs.SOL.setAccountData(
        t.key.toBase58(),
        encodeLookupTableAccount(t.state.addresses).toString('base64'),
      );
    }

    const { status, body } = await tradePrepare(token, { sym: 'ALTBONK', side: 'buy', amount: 1 });
    expect(status).toBe(200);
    const wire = Buffer.from(body.transaction!, 'base64');
    expect(wire.length).toBeLessThanOrEqual(1232);
    const vtx = VersionedTransaction.deserialize(wire);
    expect(vtx.version).toBe(0);
    expect(vtx.message.addressTableLookups.map((l) => l.accountKey.toBase58()).sort()).toEqual(
      route.tables.map((t) => t.key.toBase58()).sort(),
    );
  });

  it('fails closed when RH has no StonkzRouter (non-atomic EvmStep[] is disabled)', async () => {
    await seedTradeableToken({
      net: 'RH',
      sym: 'RHVIA',
      mint: RH_TOKEN_MINT,
      baseSymbol: 'USDC',
      baseMint: RH_USDC_MINT,
      baseDecimals: 6,
      tokenDecimals: 18,
      basePrice1e6: 1_000_000n,
    });
    h.uniswap.setRoute('0x0000000000000000000000000000000000000000', RH_USDC_MINT, { rate: 4_200 });
    const { token, address } = await h.login('RH');
    h.rpcs.RH.setBalance(address, 5);

    const { status, body } = await tradePrepare(token, { sym: 'RHVIA', side: 'buy', amount: 0.5 });
    expect(status).toBe(422);
    expect(body.error).toBe('rh_router_required');
    expect(body.atomic).toBeUndefined();
    expect(body.steps).toBeUndefined();
  });

  it('rejects a buy when the wallet cannot cover hop 1 (insufficient native)', async () => {
    await seedTradeableToken({
      net: 'SOL',
      sym: 'POOR',
      mint: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
      baseSymbol: 'SOL',
      baseMint: SOL_MINT,
      baseDecimals: 9,
      tokenDecimals: 6,
      basePrice1e6: 214_080_000n,
    });
    const { token, address } = await h.login('SOL');
    h.rpcs.SOL.setBalance(address, 0.1);

    const { status, body } = await tradePrepare(token, { sym: 'POOR', side: 'buy', amount: 2 });
    expect(status).toBe(422);
    expect(body.error).toBe('insufficient_native');
  });

  it('rejects a buy whose total cost exceeds the caller cap before ever touching the balance', async () => {
    await seedTradeableToken({
      net: 'SOL',
      sym: 'CAPPED',
      mint: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
      baseSymbol: 'SOL',
      baseMint: SOL_MINT,
      baseDecimals: 9,
      tokenDecimals: 6,
      basePrice1e6: 214_080_000n,
    });
    const { token, address } = await h.login('SOL');
    // Plenty of balance — the cap must still fire first (default Settings cap is 5).
    h.rpcs.SOL.setBalance(address, 100);

    const { status, body } = await tradePrepare(token, { sym: 'CAPPED', side: 'buy', amount: 10 });
    expect(status).toBe(422);
    expect(body.error).toBe('cap_exceeded');
  });

  it('rejects a fill whose slippage-floored min-out would round to zero', async () => {
    await seedTradeableToken({
      net: 'SOL',
      sym: 'SLIP',
      mint: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
      baseSymbol: 'SOL',
      baseMint: SOL_MINT,
      baseDecimals: 9,
      tokenDecimals: 6,
      basePrice1e6: 214_080_000n,
    });
    const { token, address } = await h.login('SOL');
    h.rpcs.SOL.setBalance(address, 10);
    // 99.995% rounds to exactly 10,000 bps in `applySlippageFloor`'s integer
    // math, flooring *any* expected output to 0 atoms — while still being
    // `< 100`, so `/trade/prepare`'s own zero-min-out guard actually fires
    // instead of being skipped as "slippage tolerance is effectively off".
    await h.deps.db.insert(settings).values({ net: 'SOL', wallet: address, slip: 99.995 });

    const { status, body } = await tradePrepare(token, { sym: 'SLIP', side: 'buy', amount: 1 });
    expect(status).toBe(422);
    expect(body.error).toBe('slippage_exceeded');
  });

  it('rejects an unknown ticker', async () => {
    const { token } = await h.login('SOL');
    const { status, body } = await tradePrepare(token, { sym: 'NOPE', side: 'buy', amount: 1 });
    expect(status).toBe(404);
    expect(body.error).toBe('not_found');
  });

  it('refuses to trade a token with no on-chain curve state yet (fixture-only row)', async () => {
    await h.deps.db.insert(tokens).values({
      net: 'SOL',
      sym: 'FIXTURE',
      name: 'Fixture Only',
      creator: 'Dev',
      mint: 'mint-FIXTURE',
      baseSymbol: 'SOL',
      baseMint: SOL_MINT,
      supply: 1e9,
      feeBps: 250,
      mc: 1000,
      lane: 'new',
      seed: 2,
      launchedAt: new Date(h.now() - 600_000),
    });
    const { token } = await h.login('SOL');
    const { status, body } = await tradePrepare(token, { sym: 'FIXTURE', side: 'buy', amount: 1 });
    expect(status).toBe(422);
    expect(body.error).toBe('not_tradeable');
  });

  it('handles a sell on the direct-pair fast path', async () => {
    await seedTradeableToken({
      net: 'SOL',
      sym: 'SELLIT',
      mint: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
      baseSymbol: 'SOL',
      baseMint: SOL_MINT,
      baseDecimals: 9,
      tokenDecimals: 6,
      basePrice1e6: 214_080_000n,
      // Simulates 1 SOL of prior buys already on-chain, so there is
      // circulating supply on record to sell back against.
      preFillBaseAtoms: 1_000_000_000n,
    });
    const { token, address } = await h.login('SOL');
    h.rpcs.SOL.setBalance(address, 10);

    const { status, body } = await tradePrepare(token, {
      sym: 'SELLIT',
      side: 'sell',
      amount: 1000,
    });
    expect(status).toBe(200);
    expect(body.atomic).toBe(true);
    const quote = body.quote as { side: string; hops: { venue: string }[] };
    expect(quote.side).toBe('sell');
    expect(quote.hops[0]?.venue).toBe('CURVE');
  });

  it("does not use USDC's price feed reasoning for trade — trades price straight off the stored curve regardless of base-price availability", async () => {
    // BONK has no `basePriceFor` entry (router/base-price.ts), but `/trade/prepare`
    // never calls it — only `/launch/prepare` does — so a BONK-based curve trades fine.
    await seedTradeableToken({
      net: 'SOL',
      sym: 'NOBASEPRICE',
      mint: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
      baseSymbol: 'BONK',
      baseMint: BONK_MINT,
      baseDecimals: 6,
      tokenDecimals: 6,
      basePrice1e6: 1_000n,
    });
    h.jupiter.setRoute(SOL_MINT, BONK_MINT, { rate: 500 });
    const { token, address } = await h.login('SOL');
    h.rpcs.SOL.setBalance(address, 10);
    const { status } = await tradePrepare(token, { sym: 'NOBASEPRICE', side: 'buy', amount: 0.5 });
    expect(status).toBe(200);
  });

  it('surfaces a structured, red-toastable error when the aggregator has no route', async () => {
    await seedTradeableToken({
      net: 'SOL',
      sym: 'NOROUTE',
      mint: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
      baseSymbol: 'BONK',
      baseMint: BONK_MINT,
      baseDecimals: 6,
      tokenDecimals: 6,
      basePrice1e6: 1_000_000n,
    });
    // Deliberately do not configure a Jupiter route for this pair.
    const { token, address } = await h.login('SOL');
    h.rpcs.SOL.setBalance(address, 10);
    const { status, body } = await tradePrepare(token, { sym: 'NOROUTE', side: 'buy', amount: 1 });
    expect(status).toBe(422);
    expect(body.error).toBe('no_route');
  });

  describe('RH atomic path via StonkzRouter', () => {
    const ROUTER_ADDRESS = getAddress(`0x${'baad'.padStart(40, '0')}`);
    let hr: TestApp;

    beforeAll(async () => {
      hr = await createTestApp({
        env: {
          RH_ROUTER_ADDRESS: ROUTER_ADDRESS,
          // Pinned per `ApiEnv.rhV3FeeTierOverrides`'s doc comment \u2014 an
          // explicit allow-list, not a guessed default.
          RH_V3_FEE_TIER_OVERRIDES: 'USDC:3000',
        },
      });
    });
    afterAll(async () => {
      await hr.close();
    });
    beforeEach(async () => {
      await hr.db.reset();
      await hr.clearRateLimits();
      hr.uniswap.reset();
    });

    async function tradePrepareOn(
      app: TestApp,
      token: string,
      body: TradeBody & { permit?: unknown },
    ) {
      const res = await app.app.request('/trade/prepare', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authed(token) },
        body: JSON.stringify(body),
      });
      return {
        status: res.status,
        body: (await res.json()) as TradePrepareResponse & {
          permitTypedData?: unknown;
          note?: string;
        },
      };
    }

    async function seedOn(app: TestApp, opts: SeedOpts): Promise<void> {
      const supply = opts.supply ?? 1e9;
      const feeBps = opts.feeBps ?? 250;
      const supplyAtoms = BigInt(Math.round(supply)) * 10n ** BigInt(opts.tokenDecimals);
      const derived = deriveCurveColumns(
        supplyAtoms,
        opts.basePrice1e6,
        opts.baseDecimals,
        opts.tokenDecimals,
      );
      if (!derived) throw new Error('seedOn: curve derivation failed');
      let columns = derived.columns;
      if (opts.preFillBaseAtoms) {
        const fill = buyQuote(derived.state, feeBps, opts.preFillBaseAtoms);
        if (!fill) throw new Error('seedOn: preFillBaseAtoms could not be filled');
        const next = applyBuy(derived.state, fill);
        columns = {
          ...columns,
          curveRealBase: next.realBase.toString(),
          curveRealToken: next.realToken.toString(),
        };
      }
      const mcapBaseAtoms = mcapBase(derived.state, supplyAtoms);
      const mc = Number(mcapUsd1e6(mcapBaseAtoms, opts.basePrice1e6, opts.baseDecimals)) / 1e6;
      await app.deps.db.insert(tokens).values({
        net: opts.net,
        sym: opts.sym,
        name: opts.sym,
        creator: 'Dev',
        mint: opts.mint,
        baseSymbol: opts.baseSymbol,
        baseMint: opts.baseMint,
        supply,
        feeBps,
        mc,
        lastMc: mc,
        lane: 'new',
        seed: 1,
        launchedAt: new Date(app.now() - 600_000),
        ...columns,
      });
    }

    const RH_WETH_MINT = getAddress('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73');

    it('buys atomically on the direct-pair (WETH) fast path \u2014 one call to StonkzRouter, no step plan', async () => {
      await seedOn(hr, {
        net: 'RH',
        sym: 'RHDIRECT',
        mint: RH_TOKEN_MINT,
        baseSymbol: 'WETH',
        baseMint: RH_WETH_MINT,
        baseDecimals: 18,
        tokenDecimals: 18,
        basePrice1e6: 4_200_000_000n,
      });
      const { token, address } = await hr.login('RH');
      hr.rpcs.RH.setBalance(address, 5);

      const { status, body } = await tradePrepareOn(hr, token, {
        sym: 'RHDIRECT',
        side: 'buy',
        amount: 0.5,
      });
      expect(status).toBe(200);
      expect(body.atomic).toBe(true);
      expect(body.steps).toBeUndefined();
      expect(body.warning).toBeUndefined();
      expect(body.to).toBe(ROUTER_ADDRESS);
      expect(typeof body.data).toBe('string');
      expect(body.value).toBe(String(Math.round(0.5 * 1e18)));
    });

    it('buys atomically through the pinned Uniswap v3 pool on an aggregator-hop base asset', async () => {
      await seedOn(hr, {
        net: 'RH',
        sym: 'RHAGG',
        mint: RH_TOKEN_MINT,
        baseSymbol: 'USDC',
        baseMint: RH_USDC_MINT,
        baseDecimals: 6,
        tokenDecimals: 18,
        basePrice1e6: 1_000_000n,
      });
      hr.uniswap.setRoute('0x0000000000000000000000000000000000000000', RH_USDC_MINT, {
        rate: 4_200,
      });
      const { token, address } = await hr.login('RH');
      hr.rpcs.RH.setBalance(address, 5);

      const { status, body } = await tradePrepareOn(hr, token, {
        sym: 'RHAGG',
        side: 'buy',
        amount: 0.5,
      });
      expect(status).toBe(200);
      expect(body.atomic).toBe(true);
      expect(body.to).toBe(ROUTER_ADDRESS);
    });

    it('sells atomically with no permit supplied \u2014 the standing-allowance branch, and returns signable permit typed data', async () => {
      await seedOn(hr, {
        net: 'RH',
        sym: 'RHSELL',
        mint: RH_TOKEN_MINT,
        baseSymbol: 'WETH',
        baseMint: RH_WETH_MINT,
        baseDecimals: 18,
        tokenDecimals: 18,
        basePrice1e6: 4_200_000_000n,
        preFillBaseAtoms: 10n ** 18n,
      });
      const { token, address } = await hr.login('RH');
      hr.rpcs.RH.setBalance(address, 5);

      const { status, body } = await tradePrepareOn(hr, token, {
        sym: 'RHSELL',
        side: 'sell',
        amount: 1_000_000,
      });
      expect(status).toBe(200);
      expect(body.atomic).toBe(true);
      expect(body.value).toBe('0');
      expect(body.permitTypedData).toBeTruthy();
      const permitTypedData = body.permitTypedData as {
        domain: { name: string };
        primaryType: string;
      };
      expect(permitTypedData.primaryType).toBe('Permit');
      expect(permitTypedData.domain.name).toBe('RHSELL');
      expect(typeof body.note).toBe('string');
      expect(String(body.note)).toMatch(/standing.allowance/);
    });

    it('sells atomically with a permit supplied \u2014 no standing-allowance note, permit is embedded', async () => {
      await seedOn(hr, {
        net: 'RH',
        sym: 'RHSELLP',
        mint: RH_TOKEN_MINT,
        baseSymbol: 'WETH',
        baseMint: RH_WETH_MINT,
        baseDecimals: 18,
        tokenDecimals: 18,
        basePrice1e6: 4_200_000_000n,
        preFillBaseAtoms: 10n ** 18n,
      });
      const { token, address } = await hr.login('RH');
      hr.rpcs.RH.setBalance(address, 5);

      const { status, body } = await tradePrepareOn(hr, token, {
        sym: 'RHSELLP',
        side: 'sell',
        amount: 1_000_000,
        permit: {
          value: '1000000',
          deadline: 2_000_000_000,
          v: 27,
          r: `0x${'11'.repeat(32)}`,
          s: `0x${'22'.repeat(32)}`,
        },
      });
      expect(status).toBe(200);
      expect(body.atomic).toBe(true);
      expect(body.permitTypedData).toBeUndefined();
      expect(body.note).toBeUndefined();
    });

    it('fails closed when the aggregator-hop base asset has no pinned fee tier', async () => {
      const UNPINNED_MINT = getAddress(`0x${'dca0dca0'.padStart(40, '0')}`);
      await seedOn(hr, {
        net: 'RH',
        sym: 'RHNOPIN',
        mint: RH_TOKEN_MINT,
        baseSymbol: 'DAI', // not in RH_V3_FEE_TIER_OVERRIDES
        baseMint: UNPINNED_MINT,
        baseDecimals: 18,
        tokenDecimals: 18,
        basePrice1e6: 4_200_000_000n,
      });
      hr.uniswap.setRoute('0x0000000000000000000000000000000000000000', UNPINNED_MINT, {
        rate: 3_000,
      });
      const { token, address } = await hr.login('RH');
      hr.rpcs.RH.setBalance(address, 5);

      const { status, body } = await tradePrepareOn(hr, token, {
        sym: 'RHNOPIN',
        side: 'buy',
        amount: 0.5,
      });
      expect(status).toBe(422);
      expect(body.error).toBe('rh_router_required');
      expect(body.steps).toBeUndefined();
    });
  });

  describe('Arc: real funds, capped at NET_INFO.ARC.maxTradeUsd', () => {
    // Nothing is deployed on Arc; the launchpad address is set here only so
    // SIWE accepts chain id 5042 (env.ts adds it to the allow-list on that
    // condition alone) and a session can reach /trade/prepare at all.
    const ARC_LAUNCHPAD = getAddress(`0x${'a4c0'.padStart(40, '0')}`);
    const ARC_NATIVE = '0x0000000000000000000000000000000000000000';
    const ARC_TOKEN_MINT = getAddress(`0x${'a4cd06'.padStart(40, '0')}`);
    let ha: TestApp;

    beforeAll(async () => {
      ha = await createTestApp({ env: { ARC_LAUNCHPAD_ADDRESS: ARC_LAUNCHPAD } });
    });
    afterAll(async () => {
      await ha.close();
    });
    beforeEach(async () => {
      await ha.db.reset();
      await ha.clearRateLimits();
    });

    async function seedArcToken(): Promise<void> {
      const supplyAtoms = 10n ** 9n * 10n ** 18n;
      // Native USDC at $1 with 18 decimals only fits the EVM (uint256) curve.
      const derived = deriveCurveColumns(supplyAtoms, 1_000_000n, 18, 18, 'ARC');
      if (!derived) throw new Error('seedArcToken: curve derivation failed');
      const mcapBaseAtoms = mcapBase(derived.state, supplyAtoms);
      const mc = Number(mcapUsd1e6(mcapBaseAtoms, 1_000_000n, 18)) / 1e6;
      await ha.deps.db.insert(tokens).values({
        net: 'ARC',
        sym: 'ARCDOG',
        name: 'ARCDOG',
        creator: 'Dev',
        mint: ARC_TOKEN_MINT,
        baseSymbol: 'USDC',
        baseMint: ARC_NATIVE,
        supply: 1e9,
        feeBps: 250,
        mc,
        lastMc: mc,
        lane: 'new',
        seed: 1,
        launchedAt: new Date(ha.now() - 600_000),
        ...derived.columns,
      });
    }

    async function arcPrepare(
      token: string,
      body: TradeBody,
    ): Promise<{ status: number; body: TradePrepareResponse }> {
      const res = await ha.app.request('/trade/prepare', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authed(token) },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as TradePrepareResponse };
    }

    it('refuses a buy worth more than 25 USD before touching a route or balance', async () => {
      await seedArcToken();
      const { token, address } = await ha.login('ARC');
      ha.rpcs.ARC.setBalance(address, 1_000);

      const { status, body } = await arcPrepare(token, {
        sym: 'ARCDOG',
        side: 'buy',
        amount: 25.01,
      });
      expect(status).toBe(422);
      expect(body.error).toBe('max_trade_usd_exceeded');
      expect(body.detail).toMatch(/capped at 25 USD/);
      expect(body.atomic).toBeUndefined();
    });

    it('refuses a quote above the cap too, so the UI never shows a trade it cannot prepare', async () => {
      await seedArcToken();
      const res = await ha.app.request('/tokens/ARCDOG/quote?net=ARC&side=buy&amount=30');
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: string }).error).toBe('max_trade_usd_exceeded');

      const ok = await ha.app.request('/tokens/ARCDOG/quote?net=ARC&side=buy&amount=20');
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { nativeUnit: string }).nativeUnit).toBe('USDC');
    });

    it('refuses an under-cap prepare while nothing is deployed on Arc', async () => {
      await seedArcToken();
      const { token, address } = await ha.login('ARC');
      ha.rpcs.ARC.setBalance(address, 1_000);

      // Same fail-closed path Base takes with BASE_ROUTER_ADDRESS unset: no
      // atomic router means no prepare, never a multi-step fallback.
      const { status, body } = await arcPrepare(token, { sym: 'ARCDOG', side: 'buy', amount: 10 });
      expect(status).toBe(422);
      expect(body.error).toBe('rh_router_required');
      expect(body.detail).toMatch(/ARC_ROUTER_ADDRESS is not configured/);
      expect(body.steps).toBeUndefined();
    });
  });

  it('rejects a Jupiter response that smuggles a platform fee on hop 1', async () => {
    await seedTradeableToken({
      net: 'SOL',
      sym: 'FEETRAP',
      mint: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
      baseSymbol: 'BONK',
      baseMint: BONK_MINT,
      baseDecimals: 6,
      tokenDecimals: 6,
      basePrice1e6: 1_000_000n,
    });
    h.jupiter.setRoute(SOL_MINT, BONK_MINT, { rate: 500 });
    h.jupiter.forcePlatformFeeBps(10);
    const { token, address } = await h.login('SOL');
    h.rpcs.SOL.setBalance(address, 10);
    const { status, body } = await tradePrepare(token, { sym: 'FEETRAP', side: 'buy', amount: 1 });
    expect(status).toBe(502);
    expect(body.error).toBe('aggregator_fee_detected');
    h.jupiter.forcePlatformFeeBps(0);
  });
});

describe('POST /trade/confirm', () => {
  it('refuses a proof that is not a transaction id before touching an RPC', async () => {
    const { token } = await h.login('SOL');
    const res = await h.app.request('/trade/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ sym: 'DOGGO', signature: 'not-a-signature; drop table trades' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('bad_proof');
  });

  it('accepts a base58 signature shape and only then looks the coin up', async () => {
    const { token } = await h.login('SOL');
    const res = await h.app.request('/trade/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ sym: 'NOSUCHCOIN', signature: '5'.repeat(64) }),
    });
    expect(res.status).toBe(404);
  });
});

/* -------------------------------------------------------------------------- */
/* Settings → the composed Solana transaction                                  */
/* -------------------------------------------------------------------------- */

interface DecodedIx {
  programId: string;
  data: Buffer;
  keys: string[];
}

/** Every instruction of a prepared transaction, program ids resolved (programs are always static keys). */
function decodeIxs(base64: string): DecodedIx[] {
  const vtx = VersionedTransaction.deserialize(Buffer.from(base64, 'base64'));
  const keys = vtx.message.staticAccountKeys;
  return vtx.message.compiledInstructions.map((ix) => ({
    programId: keys[ix.programIdIndex]!.toBase58(),
    data: Buffer.from(ix.data),
    keys: ix.accountKeyIndexes.map((i) => keys[i]?.toBase58() ?? `lut:${i}`),
  }));
}

const COMPUTE_BUDGET = ComputeBudgetProgram.programId.toBase58();
const SYSTEM = SystemProgram.programId.toBase58();
const cuLimits = (ixs: DecodedIx[]) =>
  ixs
    .filter((ix) => ix.programId === COMPUTE_BUDGET && ix.data[0] === 2)
    .map((ix) => ix.data.readUInt32LE(1));
const cuPrices = (ixs: DecodedIx[]) =>
  ixs
    .filter((ix) => ix.programId === COMPUTE_BUDGET && ix.data[0] === 3)
    .map((ix) => Number(ix.data.readBigUInt64LE(1)));
const tipTransfers = (ixs: DecodedIx[]) =>
  ixs
    .filter(
      (ix) =>
        ix.programId === SYSTEM &&
        ix.data.readUInt32LE(0) === 2 &&
        (JITO_TIP_ACCOUNTS as readonly string[]).includes(ix.keys[1] ?? ''),
    )
    .map((ix) => ({
      from: ix.keys[0],
      to: ix.keys[1],
      lamports: Number(ix.data.readBigUInt64LE(4)),
    }));

interface FeesResponse {
  slipPct: number;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: number;
  maxPriorityLamports: number;
  tipLamports: number;
  tipAccount: string | null;
  mevMode: string;
  mevRoute: string;
}

async function prepareRaw(
  app: TestApp,
  token: string,
  body: Record<string, unknown>,
): Promise<{
  status: number;
  body: TradePrepareResponse & {
    fees?: FeesResponse;
    quote?: TradeQuote & { amountOut: number; minOut: number };
  };
}> {
  const res = await app.app.request('/trade/prepare', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authed(token) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as never };
}

function seedDirectSol(sym: string): Promise<void> {
  return seedTradeableToken({
    net: 'SOL',
    sym,
    mint: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
    baseSymbol: 'SOL',
    baseMint: SOL_MINT,
    baseDecimals: 9,
    tokenDecimals: 6,
    basePrice1e6: 214_080_000n,
  });
}

describe('settings → composed Solana transaction', () => {
  it('writes exactly one CU limit and one CU price from the priority fee, and no tip without Jito', async () => {
    await seedDirectSol('FEES');
    const { token, address } = await h.login('SOL');
    h.rpcs.SOL.setBalance(address, 10);

    const { status, body } = await prepareRaw(h, token, { sym: 'FEES', side: 'buy', amount: 1 });
    expect(status).toBe(200);
    // Default settings row: prio 0.0012 SOL over 400k CU = 3 lamports/CU.
    expect(body.fees).toEqual({
      slipPct: 2.5,
      computeUnitLimit: 400_000,
      computeUnitPriceMicroLamports: 3_000_000,
      maxPriorityLamports: 1_200_000,
      tipLamports: 0,
      tipAccount: null,
      mevMode: 'SHIELD',
      mevRoute: 'none',
    });
    const ixs = decodeIxs(body.transaction!);
    expect(cuLimits(ixs)).toEqual([400_000]);
    expect(cuPrices(ixs)).toEqual([3_000_000]);
    expect(tipTransfers(ixs)).toEqual([]);
    // Budget first, so it applies before anything can run out of units.
    expect(ixs[0]!.programId).toBe(COMPUTE_BUDGET);
  });

  it('the request body overrides the stored row: prio 0 writes no CU price, slip sizes min_out', async () => {
    await seedDirectSol('OVR');
    const { token, address } = await h.login('SOL');
    h.rpcs.SOL.setBalance(address, 10);
    await h.deps.db.insert(settings).values({ net: 'SOL', wallet: address, slip: 1, prio: 0.004 });

    const { body } = await prepareRaw(h, token, {
      sym: 'OVR',
      side: 'buy',
      amount: 1,
      prio: 0,
      slip: 10,
    });
    expect(body.fees?.computeUnitPriceMicroLamports).toBe(0);
    expect(body.fees?.slipPct).toBe(10);
    const ixs = decodeIxs(body.transaction!);
    expect(cuLimits(ixs)).toEqual([400_000]);
    expect(cuPrices(ixs)).toEqual([]);
    const q = body.quote!;
    expect(q.minOut / q.amountOut).toBeCloseTo(0.9, 6);

    // No override: the stored row applies.
    const stored = await prepareRaw(h, token, { sym: 'OVR', side: 'buy', amount: 1 });
    expect(stored.body.fees?.slipPct).toBe(1);
    // 0.004 SOL over 400k CU = 10 lamports/CU.
    expect(stored.body.fees?.computeUnitPriceMicroLamports).toBe(10_000_000);
  });

  it('merges Jupiter’s compute budget instead of stacking a second one', async () => {
    await seedTradeableToken({
      net: 'SOL',
      sym: 'JUPFEE',
      mint: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
      baseSymbol: 'BONK',
      baseMint: BONK_MINT,
      baseDecimals: 6,
      tokenDecimals: 6,
      basePrice1e6: 1_000_000n,
    });
    h.jupiter.setRoute(SOL_MINT, BONK_MINT, { rate: 1_000 });
    const { token, address } = await h.login('SOL');
    h.rpcs.SOL.setBalance(address, 10);
    // The synthetic route carries SetComputeUnitLimit(300k) + SetComputeUnitPrice(12,345).
    const route = syntheticJupiterRoute({
      user: new PublicKey(address),
      baseMint: new PublicKey(BONK_MINT),
      poolAccounts: 8,
      tableCount: 1,
    });
    h.jupiter.setSwapInstructions(route.response);
    for (const t of route.tables) {
      h.rpcs.SOL.setAccountData(
        t.key.toBase58(),
        encodeLookupTableAccount(t.state.addresses).toString('base64'),
      );
    }

    const { status, body } = await prepareRaw(h, token, { sym: 'JUPFEE', side: 'buy', amount: 1 });
    expect(status).toBe(200);
    const ixs = decodeIxs(body.transaction!);
    // One limit: Jupiter's 300k plus the curve leg. One price: the user's, not Jupiter's 12,345.
    expect(cuLimits(ixs)).toEqual([500_000]);
    expect(cuPrices(ixs)).toEqual([2_400_000]);
    expect(body.fees).toMatchObject({
      computeUnitLimit: 500_000,
      computeUnitPriceMicroLamports: 2_400_000,
    });
  });

  describe('with JITO_BLOCK_ENGINE_URL configured', () => {
    let j: TestApp;
    let originalBroadcaster: TestApp['deps']['solanaBroadcaster'];

    beforeAll(async () => {
      j = await createTestApp({ env: { JITO_BLOCK_ENGINE_URL: 'https://jito.test' } });
      originalBroadcaster = j.deps.solanaBroadcaster;
    });
    afterAll(async () => {
      await j.close();
    });
    beforeEach(async () => {
      await j.db.reset();
      await j.clearRateLimits();
      j.jupiter.reset();
      j.deps.solanaBroadcaster = originalBroadcaster;
      await j.deps.db.insert(tokens).values({
        net: 'SOL',
        sym: 'SHIELDED',
        name: 'SHIELDED',
        creator: 'Dev',
        mint: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
        baseSymbol: 'SOL',
        baseMint: SOL_MINT,
        supply: 1e9,
        feeBps: 250,
        mc: 1,
        lastMc: 1,
        lane: 'new',
        seed: 1,
        launchedAt: new Date(j.now() - 600_000),
        ...deriveCurveColumns(10n ** 15n, 214_080_000n, 9, 6)!.columns,
      });
    });

    it('SHIELD writes a tip transfer to a Jito tip account and reports the jito route', async () => {
      const { token, address } = await j.login('SOL');
      j.rpcs.SOL.setBalance(address, 10);
      const { status, body } = await prepareRaw(j, token, {
        sym: 'SHIELDED',
        side: 'buy',
        amount: 1,
      });
      expect(status).toBe(200);
      expect(body.fees).toMatchObject({
        mevMode: 'SHIELD',
        mevRoute: 'jito',
        tipLamports: 900_000,
      });
      expect(JITO_TIP_ACCOUNTS).toContain(body.fees!.tipAccount);
      const tips = tipTransfers(decodeIxs(body.transaction!));
      expect(tips).toEqual([{ from: address, to: body.fees!.tipAccount, lamports: 900_000 }]);
    });

    it('OFF writes no tip; RELAY without a private RPC has no route and writes none either', async () => {
      const { token, address } = await j.login('SOL');
      j.rpcs.SOL.setBalance(address, 10);
      const off = await prepareRaw(j, token, {
        sym: 'SHIELDED',
        side: 'buy',
        amount: 1,
        mev: 'OFF',
      });
      expect(off.body.fees).toMatchObject({ mevMode: 'OFF', mevRoute: 'none', tipLamports: 0 });
      expect(tipTransfers(decodeIxs(off.body.transaction!))).toEqual([]);
      const relay = await prepareRaw(j, token, {
        sym: 'SHIELDED',
        side: 'buy',
        amount: 1,
        mev: 'RELAY',
      });
      expect(relay.body.fees).toMatchObject({ mevMode: 'RELAY', mevRoute: 'none', tipLamports: 0 });
      expect(tipTransfers(decodeIxs(relay.body.transaction!))).toEqual([]);
    });

    it('floors a dust tip to Jito’s 1000-lamport minimum', async () => {
      const { token, address } = await j.login('SOL');
      j.rpcs.SOL.setBalance(address, 10);
      const { body } = await prepareRaw(j, token, {
        sym: 'SHIELDED',
        side: 'buy',
        amount: 1,
        mevTip: 0.0000001,
      });
      expect(body.fees?.tipLamports).toBe(1_000);
      expect(tipTransfers(decodeIxs(body.transaction!))[0]?.lamports).toBe(1_000);
    });

    it('the tip counts toward the cap exactly when it is written', async () => {
      const { token, address } = await j.login('SOL');
      j.rpcs.SOL.setBalance(address, 100);
      // 4.9985 + prio 0.0012 = 4.9997 ≤ 5; + tip 0.0009 = 5.0006 > 5.
      const shield = await prepareRaw(j, token, { sym: 'SHIELDED', side: 'buy', amount: 4.9985 });
      expect(shield.status).toBe(422);
      expect(shield.body.error).toBe('cap_exceeded');
      const off = await prepareRaw(j, token, {
        sym: 'SHIELDED',
        side: 'buy',
        amount: 4.9985,
        mev: 'OFF',
      });
      expect(off.status).toBe(200);
    });

    describe('POST /trade/broadcast', () => {
      async function signedPrepared(token: string, address: string): Promise<string> {
        j.rpcs.SOL.setBalance(address, 10);
        const { body } = await prepareRaw(j, token, { sym: 'SHIELDED', side: 'buy', amount: 1 });
        const vtx = VersionedTransaction.deserialize(Buffer.from(body.transaction!, 'base64'));
        vtx.signatures[0] = new Uint8Array(64).fill(1);
        return Buffer.from(vtx.serialize()).toString('base64');
      }

      async function broadcast(
        token: string,
        body: unknown,
      ): Promise<{ status: number; body: Record<string, unknown> }> {
        const res = await j.app.request('/trade/broadcast', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authed(token) },
          body: JSON.stringify(body),
        });
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
      }

      it('relays the signed-in wallet’s own signed transaction and reports the route', async () => {
        const { token, address } = await j.login('SOL');
        const transaction = await signedPrepared(token, address);
        const calls: { tx: string; mode: string }[] = [];
        j.deps.solanaBroadcaster = {
          routeFor: () => 'jito',
          send: async (tx, mode) => {
            calls.push({ tx, mode });
            return { signature: 'sigJito', via: 'jito' };
          },
        };
        const { status, body } = await broadcast(token, { transaction, mev: 'SHIELD' });
        expect(status).toBe(200);
        expect(body).toEqual({ signature: 'sigJito', via: 'jito' });
        expect(calls).toEqual([{ tx: transaction, mode: 'SHIELD' }]);
      });

      it('refuses an unsigned transaction, another wallet’s transaction, and a non-protected mode', async () => {
        const { token, address } = await j.login('SOL');
        j.deps.solanaBroadcaster = {
          routeFor: () => 'jito',
          send: async () => {
            throw new Error('must not be reached');
          },
        };
        const signed = await signedPrepared(token, address);
        const unsignedVtx = VersionedTransaction.deserialize(Buffer.from(signed, 'base64'));
        unsignedVtx.signatures[0] = new Uint8Array(64);
        const unsigned = Buffer.from(unsignedVtx.serialize()).toString('base64');

        expect(
          (await broadcast(token, { transaction: unsigned, mev: 'SHIELD' })).body,
        ).toMatchObject({
          error: 'bad_transaction',
        });
        expect((await broadcast(token, { transaction: signed, mev: 'OFF' })).status).toBe(400);
        expect((await broadcast(token, { transaction: 'zz', mev: 'SHIELD' })).body).toMatchObject({
          error: 'bad_transaction',
        });
        const other = await j.login('SOL', solanaWallet('someone-else'));
        const foreign = await broadcast(other.token, { transaction: signed, mev: 'SHIELD' });
        expect(foreign.status).toBe(400);
        expect(foreign.body).toMatchObject({ error: 'bad_transaction' });
      });

      it('maps a total broadcast failure to 502 broadcast_failed', async () => {
        const { token, address } = await j.login('SOL');
        const transaction = await signedPrepared(token, address);
        j.deps.solanaBroadcaster = {
          routeFor: () => 'jito',
          send: async () => {
            throw new BroadcastFailedError('jito: down; rpc: down');
          },
        };
        const { status, body } = await broadcast(token, { transaction, mev: 'SHIELD' });
        expect(status).toBe(502);
        expect(body).toEqual({ error: 'broadcast_failed', detail: 'jito: down; rpc: down' });
      });
    });
  });
});
