import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { is, sql, Table } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../test/harness.js';
import { isUniqueViolation } from './errors.js';
import { listAppliedMigrations, readMigrations, runMigrations } from './migrate.js';
import { rowsOf } from './rows.js';
import * as schema from './schema.js';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';

let h: TestDb;

beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  await h.close();
});

describe('migration history', () => {
  it('applies in order and is idempotent', async () => {
    expect(await listAppliedMigrations(h.db)).toEqual([
      '0000_infra_core',
      '0001_read_tables',
      '0002_game_ledger',
      '0003_index_advisor',
      '0004_index_advisor_prune',
      '0005_router_and_launch',
      '0006_social_layer',
      '0007_indexer_chain_mode',
      // 0008–0013 landed with duplicate tickers (9aa2c68) and the Base Sepolia
      // net (284ae9a); 0013 seeds the BASE replay cursor.
      '0008_token_image',
      '0009_token_mint_pk',
      '0010_crate_inventory_sp_levels',
      '0011_referrals_social',
      '0012_net_base',
      '0013_base_cursor',
      '0014_base_treasuries',
      // 0015 widens every net CHECK to Circle's Arc and seeds its cursor + vaults.
      '0015_net_arc',
    ]);
    const second = await runMigrations(h.db);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toHaveLength(16);
  });

  it('journal and disk agree', () => {
    const files = readMigrations();
    expect(files.map((f) => f.idx)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    for (const f of files) expect(f.statements.length).toBeGreaterThan(0);
  });

  it('seeds four replay cursors and eight treasury vaults', async () => {
    // 0001 seeds SOL + RH; 0013 adds the BASE cursor (284ae9a); 0014 adds the
    // BASE vaults so Base fees have somewhere to land; 0015 does both for ARC.
    const cursors = await h.db.select().from(schema.indexerCursors);
    expect(cursors.map((c) => c.net).sort()).toEqual(['ARC', 'BASE', 'RH', 'SOL']);

    const vaults = await h.db.select().from(schema.treasuries);
    expect(vaults.map((v) => `${v.net}:${v.kind}`).sort()).toEqual([
      'ARC:protocol',
      'ARC:stonkz_ops',
      'BASE:protocol',
      'BASE:stonkz_ops',
      'RH:protocol',
      'RH:stonkz_ops',
      'SOL:protocol',
      'SOL:stonkz_ops',
    ]);
  });
});

describe('the typed mirror matches the SQL', () => {
  // Guards against drift between drizzle/*.sql (the DDL) and db/schema.ts.
  const tables = Object.values(schema)
    .filter((v) => is(v, Table))
    .map((v) => v as unknown as PgTable);

  it('covers every migrated table', async () => {
    const result = await h.db.execute(
      sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    const inDb = new Set(rowsOf<{ tablename: string }>(result).map((r) => r.tablename));
    inDb.delete('__stonkz_migrations');

    const inTs = new Set(tables.map((t) => getTableConfig(t).name));
    expect([...inDb].sort()).toEqual([...inTs].sort());
  });

  it('selects from every table with the declared columns', async () => {
    for (const table of tables) {
      const name = getTableConfig(table).name;
      await expect(
        h.db.select().from(table).limit(1),
        `select * from ${name} using the typed mirror`,
      ).resolves.toBeInstanceOf(Array);
    }
  });
});

describe('the plan 101 uniqueness constraint', () => {
  it('rejects a second award for the same (wallet, tx_sig, reason)', async () => {
    const row = {
      wallet: 'W1',
      net: 'SOL',
      amount: 10,
      baseAmount: 10,
      reason: 'trade',
      txSig: 'SIG1',
      dayUtc: '2026-09-06',
    };
    await h.db.insert(schema.xpEvents).values(row);
    await expect(h.db.insert(schema.xpEvents).values(row)).rejects.toSatisfy(isUniqueViolation);
  });

  it('allows a different reason on the same signature', async () => {
    await h.db.insert(schema.xpEvents).values({
      wallet: 'W1',
      net: 'SOL',
      amount: 50,
      baseAmount: 50,
      reason: 'ach:first',
      txSig: 'SIG1',
      dayUtc: '2026-09-06',
    });
    const rows = await h.db.select().from(schema.xpEvents);
    expect(rows).toHaveLength(2);
  });

  it('does not constrain rows without a signature', async () => {
    const row = {
      wallet: 'W1',
      net: 'SOL' as const,
      amount: 12,
      baseAmount: 12,
      reason: 'stake_claim',
      dayUtc: '2026-09-06',
    };
    await h.db.insert(schema.xpEvents).values(row);
    await h.db.insert(schema.xpEvents).values(row);
    const rows = await h.db.select().from(schema.xpEvents);
    expect(rows).toHaveLength(4);
    await h.reset();
  });
});
