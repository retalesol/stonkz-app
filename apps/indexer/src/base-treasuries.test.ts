import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { treasuries, treasuryCredits } from '@stonkz/api/db/schema';
import { FixtureProducer } from './fixtures/producer.js';
import { FixtureEventSource } from './source.js';
import { createIndexerRig, type IndexerTestRig } from './test/harness.js';

/**
 * Regression for the BASE vault gap: 0013 seeded the BASE replay cursor but
 * no `treasuries` rows, so `creditVault`'s plain UPDATE matched nothing and
 * every Base fee vanished from `/treasuries`. 0014 seeds the vaults (0016 adds
 * the third, 0018 renames them to protocol / buyback / rwa).
 */
let rig: IndexerTestRig;
let protocolLeg = 0;
let buybackLeg = 0;
let rwaLeg = 0;

beforeAll(async () => {
  const base = new FixtureProducer({ net: 'BASE' });
  base.launch({ sym: 'BASEDOG', name: 'Base Doggo', creator: '0xbasecreator', feeBps: 250 });
  const [, fee] = base.trade({
    sym: 'BASEDOG',
    trader: '0xbasetrader',
    side: 'buy',
    nativeAmount: 2,
    mc: 12_000,
  });
  if (fee?.kind !== 'FeeAccrued') throw new Error('expected a FeeAccrued leg');
  protocolLeg = fee.protocol;
  // Chain leg names: `stonkzOps` funds the buyback vault, `burn` the RWA fund.
  buybackLeg = fee.stonkzOps;
  rwaLeg = fee.burn;

  const events = base.all();
  rig = await createIndexerRig([], {
    sources: {
      SOL: new FixtureEventSource('SOL', []),
      RH: new FixtureEventSource('RH', []),
      BASE: new FixtureEventSource('BASE', events),
      ARC: new FixtureEventSource('ARC', []),
    },
  });
  await rig.runner.drain();
});
afterAll(async () => {
  await rig.close();
});

const vault = async (kind: 'protocol' | 'buyback' | 'rwa') => {
  const [row] = await rig.db.db
    .select()
    .from(treasuries)
    .where(and(eq(treasuries.net, 'BASE'), eq(treasuries.kind, kind)))
    .limit(1);
  return row;
};

describe('BASE fee accrual', () => {
  it('credits the BASE protocol, buyback and rwa vaults', async () => {
    expect(protocolLeg).toBeGreaterThan(0);
    expect(buybackLeg).toBeGreaterThan(0);
    expect(rwaLeg).toBeGreaterThan(0);

    const credits = await rig.db.db
      .select()
      .from(treasuryCredits)
      .where(eq(treasuryCredits.net, 'BASE'));
    expect(credits.map((c) => c.kind).sort()).toEqual(['buyback', 'protocol', 'rwa']);

    // No referral on this trade, so the whole protocol leg lands in the vault.
    const protocol = await vault('protocol');
    expect(protocol?.nativeBalance).toBeCloseTo(protocolLeg, 9);
    expect(protocol?.lifetimeCredited).toBeCloseTo(protocolLeg, 9);

    const buyback = await vault('buyback');
    expect(buyback?.nativeBalance).toBeCloseTo(buybackLeg, 9);
    expect(buyback?.lifetimeCredited).toBeCloseTo(buybackLeg, 9);

    const rwa = await vault('rwa');
    expect(rwa?.nativeBalance).toBeCloseTo(rwaLeg, 9);
    expect(rwa?.lifetimeCredited).toBeCloseTo(rwaLeg, 9);
  });

  it('does not inflate the vaults on replay', async () => {
    const before = await rig.db.db.select().from(treasuries);
    await rig.cursors.rewind('BASE', 0);
    await rig.runner.drain();
    expect(await rig.db.db.select().from(treasuries)).toEqual(before);
  });
});
