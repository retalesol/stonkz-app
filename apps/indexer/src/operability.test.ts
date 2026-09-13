import { afterEach, describe, expect, it } from 'vitest';
import { BackfillArgsError, parseBackfillArgs } from './cli/backfill-args.js';
import { readIndexerConfig, DEFAULT_LOCK_KEY } from './config.js';
import { renderPrometheus, readHealth, type IndexerHealth } from './http.js';
import { createIndexerRig, type IndexerTestRig } from './test/harness.js';
import { ScriptedSource } from './test/scripted-source.js';
import { readEnv } from '@stonkz/api/env';
import { createLogger } from '@stonkz/api/observability/logger';
import { FixtureProducer } from './fixtures/producer.js';

let rig: IndexerTestRig | undefined;

afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

/* ------------------------------------------------------------------ config */

describe('chain-mode configuration', () => {
  const base = {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    JWT_SECRET: 'test-secret-that-is-at-least-32-chars-long',
    CRATE_HMAC_SECRET: 'test-crate-secret-at-least-32-chars-long',
  };
  const env = readEnv(base);

  it('defaults to chain mode (fixtures are opt-in for tests only)', () => {
    expect(() => readIndexerConfig(env, {})).toThrow(/INDEXER_SOL_START_SLOT|INDEXER_RH_START_BLOCK|RH_LAUNCHPAD/);
    const config = readIndexerConfig(env, {
      INDEXER_SOURCE: 'fixtures',
      INDEXER_ALLOW_FIXTURES: '1',
    });
    expect(config.mode).toBe('fixtures');
    // Solana reads at `finalized`, which is already the post-reorg view.
    expect(config.confirmations.SOL).toBe(0);
    // Robinhood Chain has no equivalent, so it gets a real block buffer.
    expect(config.confirmations.RH).toBe(12);
    expect(config.lockKey).toBe(DEFAULT_LOCK_KEY);
    expect(config.singleReplicaLock).toBe(true);
  });

  it('refuses fixtures in production without INDEXER_ALLOW_FIXTURES', () => {
    const prod = readEnv({ ...base, NODE_ENV: 'production', ...{
      JWT_SECRET: 'production-jwt-secret-at-least-32-chars!!',
      CRATE_HMAC_SECRET: 'production-crate-secret-not-the-dev-one',
      STONKZ_STAGING: '1',
      RH_ROUTER_ADDRESS: '0x00000000000000000000000000000000000000aa',
    }});
    expect(() => readIndexerConfig(prod, { INDEXER_SOURCE: 'fixtures' })).toThrow(/INDEXER_ALLOW_FIXTURES/);
  });

  it('rejects a source mode it does not implement', () => {
    expect(() => readIndexerConfig(env, { INDEXER_SOURCE: 'helius' })).toThrow(/must be "fixtures" or "chain"/);
  });

  it('refuses chain mode without a Robinhood launchpad address', () => {
    // The zero address is `ApiEnv`'s "not deployed here" default. An indexer
    // pointed at it would poll forever, find nothing, and look healthy.
    expect(() =>
      readIndexerConfig(env, {
        INDEXER_SOURCE: 'chain',
        INDEXER_SOL_START_SLOT: '250000000',
        INDEXER_RH_START_BLOCK: '21000000',
      }),
    ).toThrow(/RH_LAUNCHPAD_ADDRESS/);
  });

  it('refuses chain mode without a Solana start slot when SOL is enabled', () => {
    expect(() =>
      readIndexerConfig(env, {
        INDEXER_SOURCE: 'chain',
        INDEXER_CHAIN_NETS: 'SOL,RH',
        RH_LAUNCHPAD_ADDRESS: '0x000000000000000000000000000000000000dec0',
        INDEXER_RH_START_BLOCK: '21000000',
      }),
    ).toThrow(/INDEXER_SOL_START_SLOT/);
  });

  it('allows RH-only chain mode without a Solana start slot', () => {
    const config = readIndexerConfig(env, {
      INDEXER_SOURCE: 'chain',
      INDEXER_CHAIN_NETS: 'RH',
      RH_LAUNCHPAD_ADDRESS: '0x000000000000000000000000000000000000dec0',
      INDEXER_RH_START_BLOCK: '21000000',
    });
    expect(config.chainNets).toEqual(['RH']);
  });

  it('accepts a fully configured chain mode', () => {
    const config = readIndexerConfig(env, {
      INDEXER_SOURCE: 'chain',
      INDEXER_CHAIN_NETS: 'SOL,RH',
      RH_LAUNCHPAD_ADDRESS: '0x000000000000000000000000000000000000dec0',
      INDEXER_SOL_START_SLOT: '250000000',
      INDEXER_RH_START_BLOCK: '21000000',
      INDEXER_RH_CONFIRMATIONS: '30',
      INDEXER_MAX_BATCH_ATTEMPTS: '3',
      INDEXER_HTTP_PORT: '0',
    });
    expect(config.mode).toBe('chain');
    expect(config.confirmations.RH).toBe(30);
    expect(config.maxBatchAttempts).toBe(3);
    expect(config.httpPort).toBe(0);
  });

  it('rejects a negative confirmation depth and a zero reorg depth', () => {
    const chain = {
      INDEXER_SOURCE: 'chain',
      RH_LAUNCHPAD_ADDRESS: '0x000000000000000000000000000000000000dec0',
      INDEXER_SOL_START_SLOT: '250000000',
      INDEXER_RH_START_BLOCK: '21000000',
    };
    expect(() => readIndexerConfig(env, { ...chain, INDEXER_RH_CONFIRMATIONS: '-1' })).toThrow(/must not be negative/);
    expect(() => readIndexerConfig(env, { ...chain, INDEXER_SOL_REORG_DEPTH: '0' })).toThrow(/at least 1/);
  });
});

/* -------------------------------------------------------- health / metrics */

describe('the health and metrics surface', () => {
  /**
   * A caught-up chain. `confirmations` is the buffer, and the head is placed
   * that far past the last event so the whole scenario is confirmed — a head
   * *at* the last event with a buffer would confirm nothing, which is a
   * different state and a different test.
   */
  async function healthRig(confirmations: number, maxLagSeconds: number) {
    const sol = new FixtureProducer({
      net: 'SOL',
      startPosition: 988,
      startMs: Date.parse('2026-09-06T00:00:00.000Z'),
    });
    sol.launch({ sym: 'DOGGO', name: 'Doggo Coin', creator: 'creator-DOGGO', feeBps: 250, mc: 4_200 });
    sol.trade({
      sym: 'DOGGO',
      trader: 'SoLtrader1111111111111111111111111111111111',
      side: 'buy',
      nativeAmount: 2.5,
      mc: 9_000,
    });
    const events = sol.all();
    const positions = [...new Set(events.map((e) => e.chainPosition))].sort((a, b) => a - b);

    const source = new ScriptedSource({
      net: 'SOL',
      events,
      head: (positions.at(-1) ?? 0) + confirmations,
      startPosition: positions[0] ?? 1,
      confirmations,
    });
    const idle = new ScriptedSource({ net: 'RH', head: 0, startPosition: 1 });
    rig = await createIndexerRig([], { sources: { SOL: source, RH: idle } });
    await rig.runner.drain();

    const opts = {
      cursors: rig.cursors,
      deadLetters: rig.deadLetters,
      logger: createLogger('silent'),
      host: '127.0.0.1',
      port: 0,
      tickMs: { SOL: 400, RH: 2_000 },
      maxLagSeconds,
      mode: 'chain',
      isLeader: () => true,
      now: rig.now,
    };
    return { health: await readHealth(opts), source };
  }

  it('reports a caught-up chain as healthy, with both heads visible', async () => {
    const { health } = await healthRig(0, 30);
    expect(health.ok).toBe(true);
    expect(health.leader).toBe(true);
    expect(health.mode).toBe('chain');

    const sol = health.chains.find((c) => c.net === 'SOL');
    expect(sol?.behind).toBe(0);
    expect(sol?.position).toBeGreaterThan(0);
    // With no buffer the confirmed head *is* the raw head, so a caught-up
    // cursor sits on both.
    expect(sol?.chainHead).toBe(sol?.position);
    expect(sol?.confirmedHead).toBe(sol?.position);
    expect(sol?.healthy).toBe(true);
    expect(sol?.lastEventAgeSeconds).not.toBeNull();
  });

  it('measures lag against the confirmed head, not the raw head', async () => {
    // With a 120-slot buffer the chain is *correctly* 120 slots behind the raw
    // tip. Measuring against the raw head would report that as lag and alert
    // forever; measuring against the confirmed head reports 0.
    const { health } = await healthRig(120, 30);
    const sol = health.chains.find((c) => c.net === 'SOL');
    expect(sol?.behind).toBe(0);
    expect(sol?.behindRaw).toBe(120);
    expect(sol?.healthy).toBe(true);
    expect(health.ok).toBe(true);
  });

  it('fails health when a chain is outside its lag budget', async () => {
    const sol = new ScriptedSource({ net: 'SOL', head: 1_000_000, startPosition: 1, confirmations: 0 });
    const idle = new ScriptedSource({ net: 'RH', head: 0, startPosition: 1 });
    rig = await createIndexerRig([], { sources: { SOL: sol, RH: idle } });
    // Nothing was ingested, but the head is a million slots away.
    await rig.cursors.observeHead('SOL', 1_000_000, 1_000_000);

    const health = await readHealth({
      cursors: rig.cursors,
      deadLetters: rig.deadLetters,
      logger: createLogger('silent'),
      host: '127.0.0.1',
      port: 0,
      tickMs: { SOL: 400, RH: 2_000 },
      maxLagSeconds: 30,
      mode: 'chain',
      isLeader: () => true,
      now: rig.now,
    });

    expect(health.ok).toBe(false);
    expect(health.chains.find((c) => c.net === 'SOL')?.healthy).toBe(false);
    // The other chain is still reported honestly rather than dragged down.
    expect(health.chains.find((c) => c.net === 'RH')?.healthy).toBe(true);
  });

  it('renders valid Prometheus text with a series per chain', async () => {
    const { health } = await healthRig(0, 30);
    const text = renderPrometheus(health);

    // Every metric declares its HELP and TYPE before its samples.
    for (const line of text.split('\n').filter((l) => l && !l.startsWith('#'))) {
      const name = line.split(/[{ ]/)[0] ?? '';
      expect(text).toContain(`# HELP ${name} `);
      expect(text).toContain(`# TYPE ${name} `);
      // A sample is `name{labels} value` with a finite numeric value.
      expect(Number(line.split(' ').at(-1))).not.toBeNaN();
    }

    expect(text).toContain('stonkz_indexer_up 1');
    expect(text).toContain('stonkz_indexer_leader 1');
    expect(text).toMatch(/stonkz_indexer_cursor_position\{net="SOL"\} \d+/);
    expect(text).toMatch(/stonkz_indexer_cursor_position\{net="RH"\} \d+/);
    expect(text).toMatch(/stonkz_indexer_lag_seconds\{net="SOL"\} /);
    expect(text).toMatch(/stonkz_indexer_reorgs_total\{net="SOL"\} 0/);
    expect(text).toMatch(/stonkz_indexer_dead_letters_open\{net="SOL"\} 0/);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('exports the reorg and dead-letter counters an operator pages on', async () => {
    const { health: before } = await healthRig(0, 30);
    expect(before.chains.every((c) => c.reorgs === 0 && c.deadLetters === 0)).toBe(true);

    if (!rig) throw new Error('rig missing');
    await rig.cursors.rewind('SOL', 100, { reorg: true });
    await rig.deadLetters.recordBatch('SOL', 100, 200, 'provider 429', 5);

    const health = await readHealth({
      cursors: rig.cursors,
      deadLetters: rig.deadLetters,
      logger: createLogger('silent'),
      host: '127.0.0.1',
      port: 0,
      tickMs: { SOL: 400, RH: 2_000 },
      maxLagSeconds: 30,
      mode: 'chain',
      isLeader: () => true,
      now: rig.now,
    });

    const sol = health.chains.find((c) => c.net === 'SOL');
    expect(sol?.reorgs).toBe(1);
    expect(sol?.deadLetters).toBe(1);
    const text = renderPrometheus(health);
    expect(text).toContain('stonkz_indexer_reorgs_total{net="SOL"} 1');
    expect(text).toContain('stonkz_indexer_dead_letters_open{net="SOL"} 1');
  });

  it('reports a standby replica as healthy but not leader', () => {
    // A replica that lost the lock race is behaving correctly. Reporting it
    // unhealthy would make an orchestrator restart the one that is fine.
    const health: IndexerHealth = {
      ok: true,
      mode: 'chain',
      leader: false,
      chains: [],
    };
    expect(renderPrometheus(health)).toContain('stonkz_indexer_leader 0');
    expect(renderPrometheus(health)).toContain('stonkz_indexer_up 1');
  });
});

/* ---------------------------------------------------------- the backfill CLI */

describe('backfill argument parsing', () => {
  it('takes a chain and an exclusive-inclusive range', () => {
    const args = parseBackfillArgs(['--net', 'SOL', '--from', '1000', '--to', '2000']);
    expect(args).toMatchObject({ net: 'SOL', from: 1_000, to: 2_000, dryRun: false, window: null });
  });

  it('accepts a lowercase chain name', () => {
    expect(parseBackfillArgs(['--net', 'rh', '--from', '1', '--to', '2']).net).toBe('RH');
  });

  it('requires a chain it can actually index', () => {
    expect(() => parseBackfillArgs(['--from', '1', '--to', '2'])).toThrow(BackfillArgsError);
    expect(() => parseBackfillArgs(['--net', 'ETH', '--from', '1', '--to', '2'])).toThrow(/SOL or RH/);
  });

  it('requires both bounds', () => {
    expect(() => parseBackfillArgs(['--net', 'SOL', '--to', '2'])).toThrow(/--from is required/);
    expect(() => parseBackfillArgs(['--net', 'SOL', '--from', '1'])).toThrow(/--to is required/);
  });

  it('rejects an empty or inverted range instead of silently doing nothing', () => {
    expect(() => parseBackfillArgs(['--net', 'SOL', '--from', '2000', '--to', '2000'])).toThrow(
      /must be greater than/,
    );
    expect(() => parseBackfillArgs(['--net', 'SOL', '--from', '2000', '--to', '1000'])).toThrow(
      /must be greater than/,
    );
  });

  it('rejects a bound that is not a whole non-negative number', () => {
    expect(() => parseBackfillArgs(['--net', 'SOL', '--from', '-5', '--to', '10'])).toThrow(/non-negative/);
    expect(() => parseBackfillArgs(['--net', 'SOL', '--from', '1e6', '--to', '10'])).toThrow(/non-negative/);
    expect(() => parseBackfillArgs(['--net', 'SOL', '--from', 'tip', '--to', '10'])).toThrow(/non-negative/);
  });

  it('treats a missing value as absent rather than eating the next flag', () => {
    // `--from --to 10` must not parse `--to` as the value of `--from`.
    expect(() => parseBackfillArgs(['--net', 'SOL', '--from', '--to', '10'])).toThrow(/--from is required/);
  });

  it('carries every destructive flag explicitly, never by default', () => {
    const plain = parseBackfillArgs(['--net', 'SOL', '--from', '1', '--to', '2']);
    expect(plain.rollbackFirst).toBe(false);
    expect(plain.rewind).toBe(false);
    expect(plain.allowUnconfirmed).toBe(false);
    expect(plain.resolve).toBe(false);

    const armed = parseBackfillArgs([
      '--net',
      'RH',
      '--from',
      '1',
      '--to',
      '2',
      '--rollback-first',
      '--rewind',
      '--allow-unconfirmed',
      '--resolve',
      '--dry-run',
      '--window',
      '500',
    ]);
    expect(armed).toMatchObject({
      rollbackFirst: true,
      rewind: true,
      allowUnconfirmed: true,
      resolve: true,
      dryRun: true,
      window: 500,
    });
  });

  it('rejects a zero window, which would never make progress', () => {
    expect(() => parseBackfillArgs(['--net', 'SOL', '--from', '1', '--to', '2', '--window', '0'])).toThrow(
      /at least 1/,
    );
  });
});
