import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../test/harness.js';
import { CHAIN_DERIVED_TABLES, resetNets, rowsOf } from './reset-net.js';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.reset();
});

async function count(table: string, net: string): Promise<number> {
  const r = await db.db.execute(
    sql`select count(*)::int as n from ${sql.identifier(table)} where net = ${net}`,
  );
  return Number((rowsOf(r)[0] as { n: number }).n);
}

describe('resetNets', () => {
  it('wipes one net and leaves the others and the identity tables alone', async () => {
    for (const net of ['RH', 'SOL']) {
      await db.db.execute(sql`
        insert into tokens (net, mint, sym, name, creator, base_symbol, base_mint, supply, fee_bps, seed)
        values (${net}, ${'mint-' + net}, 'DOG', 'Dog', 'creator', 'SOL', 'base', 1000000000, 250, 1)`);
      await db.db.execute(sql`insert into koth (net, sym, mc) values (${net}, 'DOG', 1400)`);
      await db.db.execute(
        sql`insert into indexer_cursors (net, position, chain_head) values (${net}, 100, 100)
            on conflict (net) do update set position = 100, chain_head = 100`,
      );
      await db.db.execute(sql`
        insert into treasuries (net, kind, native_balance, lifetime_credited)
        values (${net}, 'protocol', 1.5, 2.5)
        on conflict (net, kind) do update set native_balance = 1.5, lifetime_credited = 2.5`);
      await db.db.execute(sql`
        insert into users (net, wallet) values (${net}, ${'wallet-' + net})`);
    }

    const r = await resetNets(db.db, ['RH']);
    expect(r.deleted['tokens']).toBe(1);
    expect(r.deleted['koth']).toBe(1);
    expect(r.deleted['indexer_cursors']).toBe(1);
    expect(r.treasuriesZeroed).toBeGreaterThanOrEqual(1);
    for (const table of CHAIN_DERIVED_TABLES) expect(r.deleted[table]).toBeTypeOf('number');

    expect(await count('tokens', 'RH')).toBe(0);
    expect(await count('tokens', 'SOL')).toBe(1);
    expect(await count('koth', 'SOL')).toBe(1);
    expect(await count('indexer_cursors', 'SOL')).toBe(1);
    expect(await count('users', 'RH')).toBe(1);

    const t = await db.db.execute(sql`
      select native_balance, lifetime_credited from treasuries where net = 'RH' and kind = 'protocol'`);
    expect(rowsOf(t)[0]).toMatchObject({ native_balance: 0, lifetime_credited: 0 });
    const s = await db.db.execute(sql`
      select native_balance from treasuries where net = 'SOL' and kind = 'protocol'`);
    expect(rowsOf(s)[0]).toMatchObject({ native_balance: 1.5 });
  });

  it('refuses an empty net list', async () => {
    await expect(resetNets(db.db, [])).rejects.toThrow(/no nets/);
  });
});
