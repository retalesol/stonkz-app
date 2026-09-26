import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyBuy, buyQuote, mcapBase, mcapUsd1e6 } from '@stonkz/curve-sim';
import type { Net } from '@stonkz/shared';
import { tokens } from '../db/schema.js';
import type { TokenRow } from '../routes/serialise.js';
import { createTestApp, type TestApp } from '../test/app.js';
import { composeCurveTrade } from './compose.js';
import { deriveCurveColumns } from './curve-state.js';
import { AggregatorFeeDetectedError } from './errors.js';

let h: TestApp;

beforeAll(async () => {
  h = await createTestApp();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.db.reset();
  h.jupiter.reset();
  h.uniswap.reset();
});

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const BONK_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const NATIVE_ETH_MINT = '0x0000000000000000000000000000000000000000';
const RH_USDC_MINT = '0x000000000000000000000000000000000000dEf1';

async function seedRow(opts: {
  net: Net;
  sym: string;
  baseSymbol: string;
  baseMint: string;
  baseDecimals: number;
  tokenDecimals: number;
  basePrice1e6: bigint;
  feeBps: number;
  /** Simulates prior on-chain buys so a sell has circulating supply to sell against — see `routes/trade.test.ts`'s identical note. */
  preFillBaseAtoms?: bigint;
}): Promise<TokenRow> {
  const supply = 1e9;
  const supplyAtoms = BigInt(Math.round(supply)) * 10n ** BigInt(opts.tokenDecimals);
  const derived = deriveCurveColumns(
    supplyAtoms,
    opts.basePrice1e6,
    opts.baseDecimals,
    opts.tokenDecimals,
  );
  if (!derived) throw new Error('seedRow: curve derivation failed — bad fixture inputs');
  const mcapBaseAtoms = mcapBase(derived.state, supplyAtoms);
  const mc = Number(mcapUsd1e6(mcapBaseAtoms, opts.basePrice1e6, opts.baseDecimals)) / 1e6;

  let columns = derived.columns;
  if (opts.preFillBaseAtoms) {
    const fill = buyQuote(derived.state, opts.feeBps, opts.preFillBaseAtoms);
    if (!fill)
      throw new Error('seedRow: preFillBaseAtoms could not be filled against a fresh curve');
    const next = applyBuy(derived.state, fill);
    columns = {
      ...columns,
      curveRealBase: next.realBase.toString(),
      curveRealToken: next.realToken.toString(),
    };
  }

  const [row] = await h.deps.db
    .insert(tokens)
    .values({
      net: opts.net,
      sym: opts.sym,
      name: opts.sym,
      creator: 'Dev',
      mint:
        opts.net === 'SOL'
          ? '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'
          : '0x0000000000000000000000000000000000000001',
      baseSymbol: opts.baseSymbol,
      baseMint: opts.baseMint,
      supply,
      feeBps: opts.feeBps,
      mc,
      lastMc: mc,
      lane: 'new',
      seed: 1,
      launchedAt: new Date(h.now() - 600_000),
      ...columns,
    })
    .returning();
  return row!;
}

/**
 * Plan step 82's composition math, tested directly against `composeCurveTrade`
 * rather than through HTTP — `routes/trade.test.ts` and `routes/quote.test.ts`
 * cover the endpoint wiring; this file is purely "does the fee math add up".
 */
describe('composeCurveTrade — fee application', () => {
  it('SOL: charges nothing on the Jupiter hop and exactly the creator fee on the curve hop', async () => {
    const row = await seedRow({
      net: 'SOL',
      sym: 'FEEMATH',
      baseSymbol: 'BONK',
      baseMint: BONK_MINT,
      baseDecimals: 6,
      tokenDecimals: 6,
      basePrice1e6: 1_000_000n,
      feeBps: 300,
    });
    h.jupiter.setRoute(SOL_MINT, BONK_MINT, { rate: 500 });

    const trade = await composeCurveTrade({
      net: 'SOL',
      side: 'buy',
      amount: 2,
      row,
      usdPrice: 214.08,
      now: h.now(),
      aggregator: h.jupiter,
    });

    expect(trade.quote.hops).toHaveLength(2);
    const [hop1, hop2] = trade.quote.hops;
    expect(hop1).toMatchObject({ venue: 'JUPITER', feeBps: 0, feeAmount: 0 });
    expect(hop2?.venue).toBe('CURVE');
    expect(hop2?.feeBps).toBe(300);
    // The curve hop's own fee amount matches 3% of what actually entered the curve (hop 1's output), not of the native input.
    expect(hop2!.feeAmount).toBeCloseTo(hop2!.inAmount * 0.03, 6);
    expect(trade.quote.routeLabel).toBe('JUPITER → CURVE');
    expect(trade.quote.effFeePct).toBe(3);
  });

  it('RH: charges nothing on the Uniswap hop and exactly the creator fee on the curve hop', async () => {
    const row = await seedRow({
      net: 'RH',
      sym: 'FEEMATHRH',
      baseSymbol: 'USDC',
      baseMint: RH_USDC_MINT,
      baseDecimals: 6,
      tokenDecimals: 18,
      basePrice1e6: 1_000_000n,
      feeBps: 150,
    });
    h.uniswap.setRoute(NATIVE_ETH_MINT, RH_USDC_MINT, { rate: 4_200 });

    const trade = await composeCurveTrade({
      net: 'RH',
      side: 'buy',
      amount: 1,
      row,
      usdPrice: 4200,
      now: h.now(),
      aggregator: h.uniswap,
    });

    expect(trade.quote.hops).toHaveLength(2);
    const [hop1, hop2] = trade.quote.hops;
    expect(hop1).toMatchObject({ venue: 'UNISWAP', feeBps: 0, feeAmount: 0 });
    expect(hop2?.venue).toBe('CURVE');
    expect(hop2?.feeBps).toBe(150);
    expect(hop2!.feeAmount).toBeCloseTo(hop2!.inAmount * 0.015, 3);
    expect(trade.quote.routeLabel).toBe('UNISWAP → CURVE');
  });

  it('direct-pair fast path (base is native): a single CURVE hop, no aggregator called at all', async () => {
    const row = await seedRow({
      net: 'SOL',
      sym: 'DIRECTMATH',
      baseSymbol: 'SOL',
      baseMint: SOL_MINT,
      baseDecimals: 9,
      tokenDecimals: 6,
      basePrice1e6: 214_080_000n,
      feeBps: 250,
    });

    const trade = await composeCurveTrade({
      net: 'SOL',
      side: 'buy',
      amount: 1,
      row,
      usdPrice: 214.08,
      now: h.now(),
      aggregator: null,
    });

    expect(trade.quote.hops).toHaveLength(1);
    expect(trade.quote.hops[0]?.venue).toBe('CURVE');
    expect(trade.quote.routeLabel).toBe('CURVE');
    expect(trade.aggregatorQuote).toBeNull();
  });

  it('inverts hop order/symbols on a sell without changing which hop carries the fee', async () => {
    const row = await seedRow({
      net: 'SOL',
      sym: 'SELLMATH',
      baseSymbol: 'BONK',
      baseMint: BONK_MINT,
      baseDecimals: 6,
      tokenDecimals: 6,
      basePrice1e6: 1_000_000n,
      feeBps: 400,
      preFillBaseAtoms: 1_000_000n,
    });
    h.jupiter.setRoute(SOL_MINT, BONK_MINT, { rate: 500 });
    h.jupiter.setRoute(BONK_MINT, SOL_MINT, { rate: 1 / 500 });

    const trade = await composeCurveTrade({
      net: 'SOL',
      side: 'sell',
      amount: 1000,
      row,
      usdPrice: 214.08,
      now: h.now(),
      aggregator: h.jupiter,
    });

    const [hop1, hop2] = trade.quote.hops;
    // Chronological sell path: token → base on the curve, then base → native.
    expect(hop1).toMatchObject({ inSymbol: 'SELLMATH', outSymbol: 'BONK', feeBps: 400 });
    expect(hop2).toMatchObject({ inSymbol: 'BONK', outSymbol: 'SOL', feeBps: 0 });
    expect(trade.quote.routeLabel).toBe('CURVE → JUPITER');
  });

  it('propagates the fee-trap guard as a structured RouterError rather than silently accepting a smuggled fee', async () => {
    const row = await seedRow({
      net: 'SOL',
      sym: 'TRAPMATH',
      baseSymbol: 'BONK',
      baseMint: BONK_MINT,
      baseDecimals: 6,
      tokenDecimals: 6,
      basePrice1e6: 1_000_000n,
      feeBps: 250,
    });
    h.jupiter.setRoute(SOL_MINT, BONK_MINT, { rate: 500 });
    h.jupiter.forcePlatformFeeBps(5);

    await expect(
      composeCurveTrade({
        net: 'SOL',
        side: 'buy',
        amount: 1,
        row,
        usdPrice: 214.08,
        now: h.now(),
        aggregator: h.jupiter,
      }),
    ).rejects.toBeInstanceOf(AggregatorFeeDetectedError);
  });
});
