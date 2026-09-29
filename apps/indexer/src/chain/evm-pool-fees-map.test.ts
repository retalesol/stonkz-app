import { describe, expect, it } from 'vitest';
import { createBaseMintRegistry } from '@stonkz/api/router/base-mints';
import { createLogger } from '@stonkz/api/observability/logger';
import type { Db } from '@stonkz/api/db/client';
import { splitFee } from '@stonkz/shared';
import type { FeeAccruedEvent } from '../events.js';
import { assertEventIntegrity } from '../events.js';
import { mapEvmTransaction } from './evm-map.js';
import { groupByTransaction } from './evm-source.js';
import { TokenRegistry, type TokenMeta } from './registry.js';
import {
  DOGGO,
  LAUNCHPAD,
  ROUTER,
  TRADER,
  USDC_RH,
  encodeLog,
  hash32,
} from '../test/evm-fixtures.js';

/**
 * `FeeLocker.claimFees` → `StonkzLaunchpad.accrueExternalFees`: the
 * launchpad emits the ordinary `FeeAccrued` + `TreasuryCredit` pair for the
 * base side, then `PoolFeesAccrued` with the token side and the staker peel.
 * There is no `Trade` in that transaction, which used to make the mapper
 * read a zero peel; it now takes the peel and the token slices from
 * `PoolFeesAccrued` and flags the event `postGraduation`, so the ingestor
 * books native *and* token fees at once.
 */

const logger = createLogger('silent');
const baseMints = createBaseMintRegistry();

const META: TokenMeta = {
  net: 'RH',
  mint: DOGGO,
  sym: 'DOGGO',
  creator: TRADER,
  baseMint: USDC_RH,
  baseDecimals: 6,
  tokenDecimals: 18,
  basePrice1e6: 1_000_000n,
  supplyAtoms: 10n ** 27n,
  tokensForSale: 8n * 10n ** 26n,
  feeBps: 250,
  circulatingAtoms: 0n,
};

function registry(): TokenRegistry {
  const r = new TokenRegistry({} as Db);
  r.remember(META);
  return r;
}

function place(logIndex: number, txHash: string) {
  return { address: LAUNCHPAD, blockNumber: 12, blockHash: hash32('b12'), txHash, logIndex };
}

async function map(logs: ReturnType<typeof encodeLog>[], txHash: string) {
  const [group] = groupByTransaction(logs, logger, {
    launchpad: LAUNCHPAD.toLowerCase(),
    routers: [ROUTER.toLowerCase()],
  });
  return mapEvmTransaction(group!.logs, {
    net: 'RH',
    txHash,
    blockNumber: 12,
    blockTimeMs: 1_757_000_020_000,
    registry: registry(),
    baseMints,
    nativeUsdPrice: 3_400,
  });
}

/** 1,000 USDC of base fees, integer-split as the launchpad does. */
const BASE_FEE = 1_000_000_000n;
const PROTOCOL = (BASE_FEE * 1500n) / 10_000n;
const OPS = (BASE_FEE * 1000n) / 10_000n;
const BURN = (BASE_FEE * 600n) / 10_000n;
const BUCKET = BASE_FEE - PROTOCOL - OPS - BURN;
const STAKERS_BASE = BUCKET / 4n;
/** 300 tokens to the bucket, 100 of them peeled to stakers. */
const TOKENS = 300n * 10n ** 18n;
const STAKERS_TOKEN = 100n * 10n ** 18n;

function claimLogs(tx: string) {
  return [
    encodeLog(
      'FeeAccrued',
      {
        token: DOGGO,
        baseToken: USDC_RH,
        feeTotal: BASE_FEE,
        protocol: PROTOCOL,
        ops: OPS,
        burn: BURN,
        creatorBucket: BUCKET,
      },
      place(3, tx),
    ),
    encodeLog(
      'TreasuryCredit',
      { baseToken: USDC_RH, protocolDelta: PROTOCOL, opsDelta: OPS, burnDelta: BURN },
      place(4, tx),
    ),
    encodeLog(
      'PoolFeesAccrued',
      {
        token: DOGGO,
        baseAmount: BASE_FEE,
        tokenAmount: TOKENS,
        stakersBase: STAKERS_BASE,
        stakersToken: STAKERS_TOKEN,
      },
      place(5, tx),
    ),
  ];
}

describe('EVM post-graduation fee mapping', () => {
  it('maps a pool-fee claim to one FeeAccrued carrying both units and the peel', async () => {
    const tx = hash32('pf1');
    const events = await map(claimLogs(tx), tx);
    const fees = events.filter((e): e is FeeAccruedEvent => e.kind === 'FeeAccrued');
    expect(fees).toHaveLength(1);
    expect(events).toHaveLength(1); // TreasuryCredit and PoolFeesAccrued are folded in
    const fee = fees[0]!;
    expect(fee.postGraduation).toBe(true);
    expect(fee.logIndex).toBe(3);

    // USDC on RH is not the native asset, so the notional is reconstructed
    // through USD: $1,000 at $3,400/ETH, then re-split.
    const nativeTotal = 1000 / 3400;
    const legs = splitFee(nativeTotal);
    expect(fee.feeAmount).toBeCloseTo(nativeTotal, 12);
    expect(fee.protocol).toBeCloseTo(legs.protocol, 12);
    expect(fee.stonkzOps).toBeCloseTo(legs.buyback, 12);
    expect(fee.burn).toBeCloseTo(legs.rwa, 12);
    expect(fee.creatorBucket).toBeCloseTo(legs.creatorBucket, 12);
    // A quarter of the bucket went to stakers on-chain: the same fraction here.
    expect(fee.stakerShare).toBeCloseTo(legs.creatorBucket / 4, 12);
    // Token side: bucket minus the staker slice to the creator, slice to stakers.
    expect(fee.creatorTokens).toBe(200);
    expect(fee.stakerTokens).toBe(100);
    // And it still passes the integrity gate every FeeAccrued goes through.
    expect(() => assertEventIntegrity(fee)).not.toThrow();
  });

  it('leaves a curve fill alone: the peel still comes from its Trade', async () => {
    const tx = hash32('pf2');
    const logs = [
      encodeLog(
        'Trade',
        {
          token: DOGGO,
          trader: TRADER,
          isBuy: true,
          baseAmount: 100_000_000n,
          tokenAmount: 10n ** 21n,
          effFeeBps: 250,
          inCashback: false,
          feeTotal: 2_500_000n,
          feeProtocol: 375_000n,
          feeOps: 250_000n,
          feeBurn: 150_000n,
          feeCreatorBucket: 1_725_000n,
          feeStakers: 0n,
          feeCreator: 1_725_000n,
          cashbackTokens: 0n,
          virtualBase: 10n ** 12n,
          virtualToken: 10n ** 27n,
          realBase: 100_000_000n,
          realToken: 7n * 10n ** 26n,
        },
        place(1, tx),
      ),
      encodeLog(
        'FeeAccrued',
        {
          token: DOGGO,
          baseToken: USDC_RH,
          feeTotal: 2_500_000n,
          protocol: 375_000n,
          ops: 250_000n,
          burn: 150_000n,
          creatorBucket: 1_725_000n,
        },
        place(2, tx),
      ),
      encodeLog(
        'TreasuryCredit',
        { baseToken: USDC_RH, protocolDelta: 375_000n, opsDelta: 250_000n, burnDelta: 150_000n },
        place(3, tx),
      ),
    ];
    const events = await map(logs, tx);
    const fee = events.find((e): e is FeeAccruedEvent => e.kind === 'FeeAccrued');
    expect(fee?.postGraduation).toBeUndefined();
    expect(fee?.stakerShare).toBe(0);
    expect(fee?.creatorTokens).toBe(0);
  });
});
