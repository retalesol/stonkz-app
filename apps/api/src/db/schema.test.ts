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
      '0016_burn_vault',
      '0017_hot_path_indexes',
      // 0018 renames the vault kinds to buyback / rwa and adds rwa_rewards.
      '0018_fee_v2_rwa_crates',
      // 0019 carries launch socials on the intent and indexes consumed signatures.
      '0019_launch_intent_socials',
      // 0020 rebuilds stake amounts that were summed from new-total `Staked` events.
      '0020_stake_position_totals',
      // 0023 adds `users.private`, `wall_posts.flagged` and ordered follow indexes.
      '0023_profile_privacy',
      // 0024 adds the admin panel: roles, step-up challenges, the append-only audit
      // log, platform settings, user/token moderation, notices and operator jobs.
      '0024_admin_panel',
      // 0025 adds crate commit–reveal (`crate_commitments`, revealed seeds) and
      // scopes the xp_events replay index by net.
      '0025_crate_commit_reveal',
      // 0022 adds referral tier balances + the payout ledger and the staker
      // token peel; numbered earlier, journaled (and applied) after 0025.
      '0022_referral_payouts',
      // 0026 adds the graduation pool records.
      '0026_graduation_pool',
    ]);
    const second = await runMigrations(h.db);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toHaveLength(readMigrations().length);
  });

  it('journal and disk agree', () => {
    const files = readMigrations();
    // 0022 (referral tiers / payouts, staker token peel) was numbered before
    // 0023–0025 landed and is journaled after them: the applier runs the
    // journal order, so its idx is 26 and 0026 follows at 27.
    expect(files.map((f) => f.idx)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 23, 24, 25, 26, 27,
    ]);
    expect(files.map((f) => f.tag)).toContain('0022_referral_payouts');
    for (const f of files) expect(f.statements.length).toBeGreaterThan(0);
  });

  it('seeds four replay cursors and twelve treasury vaults', async () => {
    // 0001 seeds SOL + RH; 0013 adds the BASE cursor (284ae9a); 0014 adds the
    // BASE vaults so Base fees have somewhere to land; 0015 does both for ARC;
    // 0016 adds the burn vaults and 0018 renames the kinds to buyback / rwa.
    const cursors = await h.db.select().from(schema.indexerCursors);
    expect(cursors.map((c) => c.net).sort()).toEqual(['ARC', 'BASE', 'RH', 'SOL']);

    const vaults = await h.db.select().from(schema.treasuries);
    expect(vaults.map((v) => `${v.net}:${v.kind}`).sort()).toEqual([
      'ARC:buyback',
      'ARC:protocol',
      'ARC:rwa',
      'BASE:buyback',
      'BASE:protocol',
      'BASE:rwa',
      'RH:buyback',
      'RH:protocol',
      'RH:rwa',
      'SOL:buyback',
      'SOL:protocol',
      'SOL:rwa',
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
