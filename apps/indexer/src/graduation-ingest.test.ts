import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { and, eq } from 'drizzle-orm';
import { tokens } from '@stonkz/api/db/schema';
import type { Net } from '@stonkz/shared';
import { createIndexerRig, type IndexerTestRig } from './test/harness.js';
import type { ChainEvent, GraduatedEvent } from './events.js';

/**
 * Graduation through the `Ingestor`: the flag, and where the liquidity went.
 *
 * On EVM `Graduated` (permissionless) and `LiquidityMigrated` (migration
 * authority) are two transactions; the mapper turns a standalone
 * `LiquidityMigrated` into a `Graduated`-shaped event with `mc: 0` and the
 * pool. On Solana `migrate_seed_liquidity` does the same in a later tx and
 * adds the locked position. Both orders must end with `graduatedAt`,
 * `poolAddress` (and `positionAddress`) persisted, and the cap untouched by
 * the pool-only update.
 */

const MEMEMAN_EVM = '0x847eb6311333f8F7F2cd0E9A89379214302aB2c9';
const MEMEMAN_SOL = 'DoGGo1111111111111111111111111111111111111';
const POOL_EVM = getAddress('0x00000000000000000000000000000000000dead1');
const POOL_SOL = 'PooL11111111111111111111111111111111111111';
const POSITION_SOL = 'PoS111111111111111111111111111111111111111';

let rig: IndexerTestRig;
let seq = 0;

beforeAll(async () => {
  rig = await createIndexerRig();
});
afterAll(async () => {
  await rig.close();
});
beforeEach(async () => {
  await rig.db.reset();
  // The rows the events resolve against. Graduation only touches columns the
  // ingestor reads back, so the curve columns can stay at their defaults.
  await rig.db.db.insert(tokens).values(
    (['BASE', 'SOL'] as const).map((net) => ({
      net,
      sym: 'MEMEMAN',
      name: 'Mememan',
      creator: net === 'SOL' ? 'CReaToR11111111111111111111111111111111111' : OWNER,
      mint: net === 'SOL' ? MEMEMAN_SOL : MEMEMAN_EVM,
      baseSymbol: net === 'SOL' ? 'SOL' : 'ETH',
      baseMint:
        net === 'SOL'
          ? 'So11111111111111111111111111111111111111112'
          : '0x0000000000000000000000000000000000000000',
      supply: 1e9,
      feeBps: 250,
      mc: 42_000,
      lane: 'soon',
      seed: 7,
    })),
  );
});

const OWNER = '0x1FA9D4Ad76D53FbF1274d10ACBA12463ae90Bdca';

function sig(net: Net): string {
  seq++;
  return net === 'SOL' ? `gradSig${seq}xxxxxxxxx` : `0x${seq.toString(16).padStart(64, 'a')}`;
}

function graduated(net: Net, position: number, over: Partial<GraduatedEvent> = {}): GraduatedEvent {
  return {
    net,
    kind: 'Graduated',
    txSig: sig(net),
    logIndex: 0,
    chainPosition: position,
    blockTimeMs: 1_790_000_000_000 + position,
    mint: net === 'SOL' ? MEMEMAN_SOL : MEMEMAN_EVM,
    sym: 'MEMEMAN',
    mc: 71_250,
    ...over,
  };
}

async function row(net: Net) {
  const [r] = await rig.db.db
    .select({
      graduatedAt: tokens.graduatedAt,
      lane: tokens.lane,
      mc: tokens.mc,
      poolAddress: tokens.poolAddress,
      positionAddress: tokens.positionAddress,
    })
    .from(tokens)
    .where(and(eq(tokens.net, net), eq(tokens.mint, net === 'SOL' ? MEMEMAN_SOL : MEMEMAN_EVM)));
  return r;
}

async function apply(events: ChainEvent[]) {
  return rig.ingestor.apply(events);
}

describe.each<Net>(['BASE', 'SOL'])('graduation ingest on %s', (net) => {
  const pool = net === 'SOL' ? POOL_SOL : POOL_EVM;
  const position = net === 'SOL' ? { positionAddress: POSITION_SOL } : {};

  it('flips the token to graduated, then attaches the pool from a later migration', async () => {
    expect((await apply([graduated(net, 100)])).accepted).toBe(1);
    let r = await row(net);
    expect(r?.graduatedAt).not.toBeNull();
    expect(r?.lane).toBe('grad');
    expect(r?.mc).toBe(71_250);
    expect(r?.poolAddress).toBeNull();

    // The standalone `LiquidityMigrated`, as the mappers shape it.
    const report = await apply([graduated(net, 101, { mc: 0, poolAddress: pool, ...position })]);
    expect(report.accepted).toBe(1);
    r = await row(net);
    expect(r?.poolAddress).toBe(pool);
    expect(r?.positionAddress).toBe(net === 'SOL' ? POSITION_SOL : null);
    expect(r?.mc).toBe(71_250); // a pool-only update never zeroes the cap
    expect(r?.lane).toBe('grad');
  });

  it('persists the pool when it arrives in the graduation itself', async () => {
    await apply([graduated(net, 100, { poolAddress: pool, ...position })]);
    const r = await row(net);
    expect(r?.graduatedAt).not.toBeNull();
    expect(r?.poolAddress).toBe(pool);
  });

  it('is idempotent: a replayed migration changes nothing', async () => {
    await apply([graduated(net, 100)]);
    const ev = graduated(net, 101, { mc: 0, poolAddress: pool, ...position });
    await apply([ev]);
    const before = await row(net);
    const report = await apply([ev]);
    expect(report.duplicates).toBe(1);
    expect(await row(net)).toEqual(before);
  });
});
