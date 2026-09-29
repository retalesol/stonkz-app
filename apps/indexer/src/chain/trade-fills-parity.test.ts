import { describe, expect, it } from 'vitest';
import { applyBuy, buyQuote, deriveCurve, freshState, splitFee } from '@stonkz/curve-sim';
import type { Db } from '@stonkz/api/db/client';
import { createBaseMintRegistry } from '@stonkz/api/router/base-mints';
import { createLogger } from '@stonkz/api/observability/logger';
import {
  NATIVE_BASE_MINTS as API_NATIVE_BASE_MINTS,
  TRADE_FILL_EVENTS_ABI,
  decodeEvmTradeFills,
  decodeSolanaTradeFills,
  fillPayload,
  type FillTokenMeta,
} from '@stonkz/api/chain/trade-fills';
import type { TradeEvent } from '../events.js';
import { LAUNCHPAD_EVENTS_ABI, ROUTER_EVENTS_ABI } from './evm-events.js';
import { mapEvmTransaction } from './evm-map.js';
import { groupByTransaction } from './evm-source.js';
import { NATIVE_BASE_MINTS } from './market.js';
import { TokenRegistry, type TokenMeta } from './registry.js';
import { launchpadEventCoder } from './solana-events.js';
import { mapSolanaTransaction } from './solana-map.js';
import { programDataPayloads } from './anchor.js';
import {
  DOGGO,
  LAUNCHPAD,
  ROUTER,
  TRADER,
  USDC_RH,
  encodeLog,
  hash32,
} from '../test/evm-fixtures.js';
import {
  DOGGO_MINT,
  PROGRAM_ID,
  TRADER as SOL_TRADER,
  WSOL_MINT,
  encodeTrade,
  programDataLine,
} from '../test/solana-fixtures.js';

/**
 * `/trade/confirm` (API) and the indexer decode the same fill independently —
 * the API image does not ship `apps/indexer`. These tests pin the two
 * together: the API's event fragments are the indexer's, and for the same
 * logs both produce the same trader, side, amounts, USD value and cap. A
 * divergence would make a provisional print disagree with the authoritative
 * one that replaces it.
 */

const logger = createLogger('silent');
const baseMints = createBaseMintRegistry();

function required<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`fixture ${what} failed`);
  return value;
}

function registryWith(meta: TokenMeta): TokenRegistry {
  // Resolves from the cache; the database is never reached.
  const registry = new TokenRegistry({} as Db);
  registry.remember(meta);
  return registry;
}

function apiMeta(meta: TokenMeta): FillTokenMeta {
  return {
    mint: meta.mint,
    sym: meta.sym,
    baseMint: meta.baseMint,
    baseDecimals: meta.baseDecimals,
    tokenDecimals: meta.tokenDecimals,
    basePrice1e6: meta.basePrice1e6,
    supplyAtoms: meta.supplyAtoms,
  };
}

function expectSameFill(indexed: TradeEvent, api: ReturnType<typeof fillPayload>): void {
  expect(api.w).toBe(indexed.trader);
  expect(api.buy).toBe(indexed.side === 'buy');
  expect(api.sol).toBeCloseTo(indexed.nativeAmount, 12);
  expect(api.tok).toBeCloseTo(indexed.tokenAmount, 9);
  expect(api.v).toBeCloseTo(indexed.usdValue, 9);
  expect(api.mc).toBeCloseTo(indexed.mc, 6);
  expect(api.cb).toBe(indexed.cashback);
  expect(api.sig).toBe(indexed.txSig);
  expect(api.t).toBe(indexed.blockTimeMs);
}

describe('API trade-fill decoder ⇔ indexer', () => {
  it('uses the indexer’s Trade / AtomicBuy / AtomicSell fragments verbatim', () => {
    const trade = LAUNCHPAD_EVENTS_ABI.find((e) => e.name === 'Trade');
    expect(TRADE_FILL_EVENTS_ABI.find((e) => e.name === 'Trade')).toEqual(trade);
    for (const router of ROUTER_EVENTS_ABI) {
      expect(TRADE_FILL_EVENTS_ABI.find((e) => e.name === router.name)).toEqual(router);
    }
  });

  it('treats the same base mints as native', () => {
    expect(API_NATIVE_BASE_MINTS).toEqual(NATIVE_BASE_MINTS);
  });

  describe('EVM', () => {
    // A USDC-based curve, so the native leg comes from the router — the
    // partial-fill scaling path — rather than the base amount.
    const SUPPLY = 10n ** 27n;
    const PRICE = 1_000_000n; // $1 USDC
    const CURVE = required(deriveCurve(SUPPLY, PRICE, 6), 'curve');
    const FRESH = freshState(CURVE);
    const FILL = required(buyQuote(FRESH, 250, 5_000_000_000n), 'fill');
    const AFTER = applyBuy(FRESH, FILL);
    const LEGS = splitFee(FILL.fee);
    const META: TokenMeta = {
      net: 'RH',
      mint: DOGGO,
      sym: 'DOGGO',
      creator: TRADER,
      baseMint: USDC_RH,
      baseDecimals: 6,
      tokenDecimals: 18,
      basePrice1e6: PRICE,
      supplyAtoms: SUPPLY,
      tokensForSale: CURVE.tokensForSale,
      feeBps: 250,
      circulatingAtoms: 0n,
    };
    const TX = hash32('f1');
    const place = (logIndex: number, address: string) => ({
      address,
      blockNumber: 7,
      blockHash: hash32('b7'),
      txHash: TX,
      logIndex,
    });
    const logs = [
      encodeLog(
        'Trade',
        {
          token: DOGGO,
          trader: ROUTER,
          isBuy: true,
          baseAmount: FILL.grossBase,
          tokenAmount: FILL.tokensOut,
          effFeeBps: 250,
          inCashback: false,
          feeTotal: FILL.fee,
          feeProtocol: LEGS.protocol,
          feeOps: LEGS.stonkzOps,
          feeBurn: LEGS.burn,
          feeCreatorBucket: LEGS.creatorBucket,
          feeStakers: 0n,
          feeCreator: LEGS.creatorBucket,
          cashbackTokens: 0n,
          virtualBase: AFTER.virtualBase,
          virtualToken: AFTER.virtualToken,
          realBase: AFTER.realBase,
          realToken: AFTER.realToken,
        },
        place(3, LAUNCHPAD),
      ),
      encodeLog(
        'AtomicBuy',
        {
          trader: TRADER,
          token: DOGGO,
          ethIn: 2_000_000_000_000_000n,
          // The aggregator delivered more than the curve took (graduation cap).
          baseFromAggregator: FILL.grossBase + 1_000_000n,
          tokensOut: FILL.tokensOut,
        },
        place(4, ROUTER),
      ),
    ];

    it('produces the indexer’s fill for a routed, non-native-base buy', async () => {
      const [group] = groupByTransaction(logs, logger, {
        launchpad: LAUNCHPAD.toLowerCase(),
        routers: [ROUTER.toLowerCase()],
      });
      const events = await mapEvmTransaction(group!.logs, {
        net: 'RH',
        txHash: TX,
        blockNumber: 7,
        blockTimeMs: 1_757_000_014_000,
        registry: registryWith(META),
        baseMints,
        nativeUsdPrice: 3_400,
      });
      const indexed = events.find((e): e is TradeEvent => e.kind === 'Trade')!;

      const [fill] = decodeEvmTradeFills(logs, { launchpad: LAUNCHPAD, routers: [ROUTER] });
      const api = fillPayload(fill!, apiMeta(META), {
        net: 'RH',
        txSig: TX,
        blockTimeMs: 1_757_000_014_000,
        nativeUsdPrice: 3_400,
      });
      expectSameFill(indexed, api);
      expect(fill?.logIndex).toBe(indexed.logIndex);
    });

    it('drops the same foreign-emitter logs the indexer drops', () => {
      const spoofed = logs.map((l) => ({
        ...l,
        address: '0x000000000000000000000000000000000000beef',
      }));
      expect(decodeEvmTradeFills(spoofed, { launchpad: LAUNCHPAD, routers: [ROUTER] })).toEqual([]);
      expect(
        groupByTransaction(spoofed, logger, {
          launchpad: LAUNCHPAD.toLowerCase(),
          routers: [ROUTER.toLowerCase()],
        }),
      ).toEqual([]);
    });
  });

  describe('Solana', () => {
    const SUPPLY = 1_000_000_000_000_000n; // 1e9 at 6 decimals
    const PRICE = 214_080_000n;
    const CURVE = required(deriveCurve(SUPPLY, PRICE, 9), 'curve');
    const FRESH = freshState(CURVE);
    const FILL = required(buyQuote(FRESH, 300, 2_000_000_000n), 'fill');
    const AFTER = applyBuy(FRESH, FILL);
    const LEGS = splitFee(FILL.fee);
    const META: TokenMeta = {
      net: 'SOL',
      mint: DOGGO_MINT,
      sym: 'DOGGO',
      creator: SOL_TRADER,
      baseMint: WSOL_MINT,
      baseDecimals: 9,
      tokenDecimals: 6,
      basePrice1e6: PRICE,
      supplyAtoms: SUPPLY,
      tokensForSale: CURVE.tokensForSale,
      feeBps: 300,
      circulatingAtoms: 0n,
    };
    const body = encodeTrade({
      mint: DOGGO_MINT,
      trader: SOL_TRADER,
      isBuy: true,
      baseAmount: FILL.grossBase,
      tokenAmount: FILL.tokensOut,
      effFeeBps: 300,
      inCashback: false,
      feeTotal: FILL.fee,
      feeProtocol: LEGS.protocol,
      feeOps: LEGS.stonkzOps,
      feeBurn: LEGS.burn,
      feeCreatorBucket: LEGS.creatorBucket,
      feeStakers: 0n,
      feeCreator: LEGS.creatorBucket,
      cashbackTokens: 0n,
      virtualBase: AFTER.virtualBase,
      virtualToken: AFTER.virtualToken,
      realBase: AFTER.realBase,
      realToken: AFTER.realToken,
      circulating: FILL.tokensOut,
      ts: 1_757_000_000n,
    });
    const OTHER = 'Stake11111111111111111111111111111111111111';
    const logMessages = [
      `Program ${PROGRAM_ID} invoke [1]`,
      programDataLine('Trade', body),
      // A byte-exact Trade logged by another program must not count.
      `Program ${OTHER} invoke [2]`,
      programDataLine('Trade', body),
      `Program ${OTHER} success`,
      `Program ${PROGRAM_ID} success`,
    ];
    const SIG = '5'.repeat(88);

    it('produces the indexer’s fill, attributing Program data by invoke frame', async () => {
      const records = programDataPayloads(logMessages, PROGRAM_ID)
        .map((p) => launchpadEventCoder.decode(p)?.data)
        .filter((r) => r !== undefined);
      const events = await mapSolanaTransaction(records, {
        txSig: SIG,
        slot: 42,
        blockTimeMs: 1_757_000_000_000,
        registry: registryWith(META),
        baseMints,
        nativeUsdPrice: 214.08,
      });
      const indexed = events.filter((e): e is TradeEvent => e.kind === 'Trade');
      expect(indexed).toHaveLength(1);

      const fills = decodeSolanaTradeFills(
        {
          slot: 42,
          blockTimeMs: 1_757_000_000_000,
          failed: false,
          logMessages,
          innerInstructions: [],
          accountKeys: [],
        },
        PROGRAM_ID,
      );
      expect(fills).toHaveLength(1);
      const api = fillPayload(fills[0]!, apiMeta(META), {
        net: 'SOL',
        txSig: SIG,
        blockTimeMs: 1_757_000_000_000,
        nativeUsdPrice: 214.08,
      });
      expectSameFill(indexed[0]!, api);
      expect(api.fid).toBe(`${SIG}:0`);
    });
  });
});
