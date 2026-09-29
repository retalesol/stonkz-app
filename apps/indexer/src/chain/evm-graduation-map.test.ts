import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { createBaseMintRegistry } from '@stonkz/api/router/base-mints';
import { createLogger } from '@stonkz/api/observability/logger';
import type { Db } from '@stonkz/api/db/client';
import type { GraduatedEvent } from '../events.js';
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
 * `graduate` and `migrateLiquidity` are separate transactions on the EVM
 * launchpad (the second is gated on the migration authority), so the usual
 * shape is a `Graduated` in one block and a `LiquidityMigrated` in a later
 * one. The mapper used to drop the standalone `LiquidityMigrated`, which left
 * every EVM graduate without a pool address. It now materialises the same
 * `Graduated`-shaped update `solana-map.ts` does (decision 2).
 */

const logger = createLogger('silent');
const baseMints = createBaseMintRegistry();
const POOL = getAddress('0x00000000000000000000000000000000000dead1');

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

function place(logIndex: number, address: string, txHash: string, blockNumber: number) {
  return { address, blockNumber, blockHash: hash32(`b${blockNumber}`), txHash, logIndex };
}

async function map(logs: ReturnType<typeof encodeLog>[], txHash: string, blockNumber: number) {
  const [group] = groupByTransaction(logs, logger, {
    launchpad: LAUNCHPAD.toLowerCase(),
    routers: [ROUTER.toLowerCase()],
  });
  return mapEvmTransaction(group!.logs, {
    net: 'RH',
    txHash,
    blockNumber,
    blockTimeMs: 1_757_000_014_000,
    registry: registry(),
    baseMints,
    nativeUsdPrice: 3_400,
  });
}

describe('EVM graduation mapping', () => {
  it('maps a standalone LiquidityMigrated to a pool-only Graduated update', async () => {
    const tx = hash32('m1');
    const logs = [
      encodeLog(
        'LiquidityMigrated',
        { token: DOGGO, pool: POOL, liquidityBurned: 985_854_938_711_039_069_469n },
        place(2, LAUNCHPAD, tx, 9),
      ),
    ];
    const events = await map(logs, tx, 9);
    const grad = events.find((e): e is GraduatedEvent => e.kind === 'Graduated');
    expect(grad).toBeDefined();
    expect(grad?.mint).toBe(DOGGO);
    expect(grad?.poolAddress?.toLowerCase()).toBe(POOL.toLowerCase());
    expect(grad?.mc).toBe(0);
    expect(grad?.logIndex).toBe(2);
  });

  it('folds the pool into the Graduated when both share a transaction', async () => {
    const tx = hash32('m2');
    const logs = [
      encodeLog(
        'Graduated',
        {
          token: DOGGO,
          reason: 0,
          baseMigrated: 13_800_000_000n,
          tokensMigrated: 2n * 10n ** 26n,
          tokensBurned: 0n,
          mcapBase: 69_000_000_000n,
          mcapUsd1e6: 69_000_000_000n,
        },
        place(1, LAUNCHPAD, tx, 9),
      ),
      encodeLog(
        'LiquidityMigrated',
        { token: DOGGO, pool: POOL, liquidityBurned: 1n },
        place(2, LAUNCHPAD, tx, 9),
      ),
    ];
    const events = await map(logs, tx, 9);
    const grads = events.filter((e): e is GraduatedEvent => e.kind === 'Graduated');
    expect(grads).toHaveLength(1);
    expect(grads[0]?.mc).toBe(69_000);
    expect(grads[0]?.poolAddress?.toLowerCase()).toBe(POOL.toLowerCase());
  });
});
