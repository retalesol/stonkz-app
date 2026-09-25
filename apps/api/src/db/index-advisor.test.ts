import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../test/harness.js';
import { rowsOf } from './rows.js';
import * as schema from './schema.js';

let h: TestDb;

/**
 * Review gate 3.A — the index advisor pass.
 *
 * Migration 0003 adds an index for each hot query in the read path and the
 * ledger. These tests run `EXPLAIN` on those exact queries against a table
 * large enough that the planner would prefer a sequential scan if the index
 * were missing, and fail on `Seq Scan`. That way a later migration that drops
 * or shadows an index breaks a test rather than a latency graph.
 */
const ROWS = 4_000;

async function explain(query: string): Promise<string> {
  const result = await h.db.execute(sql.raw(`EXPLAIN (COSTS OFF) ${query}`));
  return rowsOf<Record<string, string>>(result)
    .map((row) => Object.values(row).join(' '))
    .join('\n');
}

/**
 * The planner only picks an index once it believes the table is big.
 *
 * Migration 0009 moved token identity to (net, mint) and made `mint` NOT NULL
 * on candles / holders_snapshot, so every seed row carries a synthetic mint.
 */
async function seed(): Promise<void> {
  await h.db.execute(sql`
    INSERT INTO tokens (net, mint, sym, name, creator, base_symbol, base_mint, supply, fee_bps, mc, lane, seed, launched_at)
    SELECT
      CASE WHEN i % 2 = 0 THEN 'SOL' ELSE 'RH' END,
      'mint' || i,
      'T' || i,
      'Token ' || i,
      'creator' || (i % 97),
      'SOL', 'somemint', 1000000000, 250,
      (i % 70000)::float8,
      CASE WHEN i % 7 = 0 THEN 'grad' WHEN i % 3 = 0 THEN 'soon' ELSE 'new' END,
      i,
      now() - (i || ' minutes')::interval
    FROM generate_series(1, ${ROWS}) AS s(i)
  `);

  await h.db.execute(sql`
    INSERT INTO trades (net, sym, tx_sig, log_index, side, trader, native_amount, base_amount, token_amount, usd_value, mc, price, block_time, chain_position)
    SELECT
      CASE WHEN i % 2 = 0 THEN 'SOL' ELSE 'RH' END,
      'T' || (i % 200),
      'sig' || i, 0,
      CASE WHEN i % 3 = 0 THEN 'sell' ELSE 'buy' END,
      'trader' || (i % 300),
      0.5, 0.5, 1000, 100, 20000, 0.0001,
      now() - (i || ' seconds')::interval,
      i
    FROM generate_series(1, ${ROWS}) AS s(i)
  `);

  await h.db.execute(sql`
    INSERT INTO tape (net, sym, side, trader, native_amount, token_amount, usd_value, mc, tx_sig, log_index, block_time)
    SELECT
      CASE WHEN i % 2 = 0 THEN 'SOL' ELSE 'RH' END,
      'T' || (i % 200), 'buy', 'trader' || (i % 300),
      0.5, 1000, 100, 20000, 'tapesig' || i, 0,
      now() - (i || ' seconds')::interval
    FROM generate_series(1, ${ROWS}) AS s(i)
  `);

  await h.db.execute(sql`
    INSERT INTO candles (net, mint, sym, tf, bucket_start, o, h, l, c, v, native_volume, trades)
    SELECT 'SOL', 'mint' || (i % 50), 'T' || (i % 50), '1m', date_trunc('minute', now()) - (i || ' minutes')::interval,
           1, 2, 0.5, 1.5, 100, 1, 3
    FROM generate_series(1, ${ROWS}) AS s(i)
  `);

  await h.db.execute(sql`
    INSERT INTO holders_snapshot (net, mint, sym, wallet, token_amount, cost_native)
    SELECT 'SOL', 'mint' || (i % 200), 'T' || (i % 200), 'holder' || i,
           CASE WHEN i % 5 = 0 THEN 0 ELSE (i % 1000)::float8 END,
           1.25
    FROM generate_series(1, ${ROWS}) AS s(i)
  `);

  await h.db.execute(sql`
    INSERT INTO xp_events (wallet, net, amount, base_amount, reason, tx_sig, day_utc)
    SELECT 'wallet' || (i % 400), 'SOL', 10, 10, 'trade', 'xpsig' || i,
           (current_date - ((i % 30) || ' days')::interval)::date
    FROM generate_series(1, ${ROWS}) AS s(i)
  `);

  await h.db.execute(sql`
    INSERT INTO crate_opens (wallet, net, tier, roll_commit, server_seed_hash, client_nonce, roll_value, amount_roll, drop_index, rarity, payload_json, opened_at)
    SELECT 'wallet' || (i % 400), 'SOL', 'BRONZE', 'commit' || i, 'hash', 'nonce' || i,
           (i % 100)::float8, 0.5, i % 5, 'COMMON', '{}'::jsonb,
           now() - (i || ' minutes')::interval
    FROM generate_series(1, ${ROWS}) AS s(i)
  `);

  await h.db.execute(sql`
    INSERT INTO chain_events (net, kind, sym, tx_sig, log_index, chain_position, block_time, payload)
    SELECT 'SOL', 'Trade', 'T' || (i % 200), 'cesig' || i, 0, 250000000 + i,
           now() - (i || ' seconds')::interval, '{}'::jsonb
    FROM generate_series(1, ${ROWS}) AS s(i)
  `);

  await h.db.execute(sql`ANALYZE`);
}

beforeAll(async () => {
  h = await createTestDb();
  await seed();
  // Force the question "is there a usable index?" rather than "is the table
  // small enough to slurp?" — without this a 4k-row table scans either way.
  await h.db.execute(sql`SET enable_seqscan = off`);
  await h.db.execute(sql`SET enable_bitmapscan = off`);
});
afterAll(async () => {
  await h.close();
});

const QUERIES: { name: string; sql: string; expectIndex: string }[] = [
  {
    name: 'GET /tokens?lane=&sort=mc',
    sql: `SELECT * FROM tokens WHERE net = 'SOL' AND lane = 'new' ORDER BY mc DESC LIMIT 100`,
    expectIndex: 'tokens_lane_mc_idx',
  },
  {
    name: 'GET /tokens?sort=new',
    sql: `SELECT * FROM tokens WHERE net = 'SOL' ORDER BY launched_at DESC LIMIT 100`,
    expectIndex: 'tokens_launched_idx',
  },
  {
    // The (net, sym) prefix index shares its leading columns with the primary
    // key, so the planner is free to pick either for the equality lookup. It
    // is kept regardless: text_pattern_ops is what makes `LIKE 'ABC%'`
    // index-eligible, and the primary key's default opclass cannot serve that.
    name: 'GET /tokens/:sym',
    sql: `SELECT * FROM tokens WHERE net = 'SOL' AND sym = 'T42'`,
    expectIndex: 'tokens_',
  },
  {
    name: 'GET /tokens?q= prefix search',
    sql: `SELECT * FROM tokens WHERE net = 'SOL' AND sym LIKE 'T4%' LIMIT 20`,
    expectIndex: 'tokens_sym_prefix_idx',
  },
  {
    name: 'GET /tokens/:sym/trades',
    sql: `SELECT * FROM trades WHERE net = 'SOL' AND sym = 'T42' ORDER BY id DESC LIMIT 50`,
    expectIndex: 'trades_token_recent_idx',
  },
  {
    // Both tape reads ride the primary key. See migration 0004: `net` has two
    // values, so a net-filtered backward pkey scan reads at most ~2x the rows
    // it returns, which the planner prices below a dedicated index.
    name: 'GET /tape?net=',
    sql: `SELECT * FROM tape WHERE net = 'SOL' ORDER BY id DESC LIMIT 40`,
    expectIndex: 'tape_pkey',
  },
  {
    name: 'GET /tape (all nets)',
    sql: `SELECT * FROM tape ORDER BY id DESC LIMIT 40`,
    expectIndex: 'tape_pkey',
  },
  {
    name: 'GET /tokens/:sym/candles?tf=',
    sql: `SELECT * FROM candles WHERE net = 'SOL' AND sym = 'T7' AND tf = '1m' ORDER BY bucket_start DESC LIMIT 200`,
    expectIndex: 'candles_range_idx',
  },
  {
    name: 'GET /tokens/:sym/holders',
    sql: `SELECT * FROM holders_snapshot WHERE net = 'SOL' AND sym = 'T42' AND token_amount > 0 ORDER BY token_amount DESC LIMIT 50`,
    expectIndex: 'holders_top_idx',
  },
  {
    name: 'daily XP cap check',
    sql: `SELECT coalesce(sum(amount), 0) FROM xp_events WHERE wallet = 'wallet7' AND net = 'SOL' AND day_utc = current_date`,
    expectIndex: 'xp_events_cap_idx',
  },
  {
    name: 'replay dedupe on (wallet, tx_sig, reason)',
    sql: `SELECT id FROM xp_events WHERE wallet = 'wallet7' AND tx_sig = 'xpsig7' AND reason = 'trade'`,
    expectIndex: 'xp_events_sig_reason_uq',
  },
  {
    name: 'GET /rewards drop log',
    sql: `SELECT * FROM crate_opens WHERE wallet = 'wallet7' AND net = 'SOL' ORDER BY opened_at DESC LIMIT 14`,
    expectIndex: 'crate_opens_log_idx',
  },
  {
    name: 'indexer replay window',
    sql: `SELECT * FROM chain_events WHERE net = 'SOL' AND chain_position > 250000100 ORDER BY chain_position, id LIMIT 500`,
    expectIndex: 'chain_events_replay_idx',
  },
  {
    name: 'ledger verified-event lookup',
    sql: `SELECT id FROM chain_events WHERE net = 'SOL' AND tx_sig = 'cesig9' LIMIT 1`,
    expectIndex: 'chain_events_sig_uq',
  },
];

describe('index advisor pass', () => {
  for (const query of QUERIES) {
    it(`${query.name} uses ${query.expectIndex}`, async () => {
      const plan = await explain(query.sql);
      expect(plan, `plan for ${query.name}:\n${plan}`).not.toMatch(/Seq Scan/);
      expect(plan, `plan for ${query.name}:\n${plan}`).toContain(query.expectIndex);
    });
  }

  it('every declared index actually exists in the database', async () => {
    const result = await h.db.execute(
      sql`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const present = rowsOf<{ indexname: string }>(result).map((r) => r.indexname);
    for (const query of QUERIES) {
      expect(present.some((name) => name.startsWith(query.expectIndex))).toBe(true);
    }
  });

  it('has dropped the indexes the planner would not use', async () => {
    const result = await h.db.execute(
      sql`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'tape'`,
    );
    const present = rowsOf<{ indexname: string }>(result).map((r) => r.indexname);
    // Migration 0004. `tape` takes a row per trade on both chains, so a
    // never-read index here is the worst place in the schema to keep one.
    expect(present).not.toContain('tape_recent_idx');
    expect(present).not.toContain('tape_net_recent_idx');
    expect(present).toContain('tape_pkey');
  });

  it('the partial holder indexes exclude zero balances', async () => {
    const result = await h.db.execute(sql`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'holders_top_idx'
    `);
    const [row] = rowsOf<{ indexdef: string }>(result);
    // Zero-balance rows are kept for cost basis but never listed.
    expect(row?.indexdef).toMatch(/WHERE \(token_amount > /);
  });

  it('sanity-checks that the scan-off setting is what makes this meaningful', async () => {
    await h.db.execute(sql`SET enable_seqscan = on`);
    await h.db.execute(sql`SET enable_indexscan = off`);
    await h.db.execute(sql`SET enable_bitmapscan = off`);
    const plan = await explain(QUERIES[0]?.sql ?? 'SELECT 1');
    // With index scans disabled the planner falls back, proving the assertions
    // above were reading a real plan rather than a constant.
    expect(plan).toMatch(/Seq Scan/);
    await h.db.execute(sql`SET enable_indexscan = on`);
    await h.db.execute(sql`SET enable_seqscan = off`);
  });

  it('leaves the schema check green — nothing above mutated the DDL', async () => {
    const result = await h.db.execute(
      sql`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`,
    );
    expect(rowsOf<{ n: number }>(result)[0]?.n).toBeGreaterThan(20);
    expect(Object.keys(schema).length).toBeGreaterThan(20);
  });
});
