import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { treasuries, treasuryCredits } from '@stonkz/api/db/schema';
import { FixtureProducer } from './fixtures/producer.js';
import { FixtureEventSource } from './source.js';
import { createIndexerRig, type IndexerTestRig } from './test/harness.js';

/**
 * Regression for the BASE vault gap: 0013 seeded the BASE replay cursor but
 * no `treasuries` rows, so `creditVault`'s plain UPDATE matched nothing and
 * every Base fee vanished from `/treasuries`. 0014 seeds the two vaults.
 */
let rig: IndexerTestRig;
let protocolLeg = 0;
let opsLeg = 0;

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
  opsLeg = fee.stonkzOps;

  const events = base.all();
  rig = await createIndexerRig([], {
    sources: {
      SOL: new FixtureEventSource('SOL', []),
      RH: new FixtureEventSource('RH', []),
      BASE: new FixtureEventSource('BASE', events),
    },
  });
  await rig.runner.drain();
});
afterAll(async () => {
  await rig.close();
});

const vault = async (kind: 'protocol' | 'stonkz_ops') => {
  const [row] = await rig.db.db
    .select()
    .from(treasuries)
    .where(and(eq(treasuries.net, 'BASE'), eq(treasuries.kind, kind)))
    .limit(1);
  return row;
};

describe('BASE fee accrual', () => {
  it('credits the BASE protocol and stonkz_ops vaults', async () => {
    expect(protocolLeg).toBeGreaterThan(0);
    expect(opsLeg).toBeGreaterThan(0);

    const credits = await rig.db.db
      .select()
      .from(treasuryCredits)
      .where(eq(treasuryCredits.net, 'BASE'));
    expect(credits.map((c) => c.kind).sort()).toEqual(['protocol', 'stonkz_ops']);

    // No referral on this trade, so the whole protocol leg lands in the vault.
    const protocol = await vault('protocol');
    expect(protocol?.nativeBalance).toBeCloseTo(protocolLeg, 9);
    expect(protocol?.lifetimeCredited).toBeCloseTo(protocolLeg, 9);

    const ops = await vault('stonkz_ops');
    expect(ops?.nativeBalance).toBeCloseTo(opsLeg, 9);
    expect(ops?.lifetimeCredited).toBeCloseTo(opsLeg, 9);
  });

  it('does not inflate the vaults on replay', async () => {
    const before = await rig.db.db.select().from(treasuries);
    await rig.cursors.rewind('BASE', 0);
    await rig.runner.drain();
    expect(await rig.db.db.select().from(treasuries)).toEqual(before);
  });
});
